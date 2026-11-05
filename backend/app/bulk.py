# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Bulk fetch helpers for the BFS streaming endpoint (B3).

Edges and node attributes are fetched with flat queries over VALUES chunks
of :data:`CHUNK` IRIs (see the notes in ``app.templates``), one query per
(chunk, relation) for edges and per chunk for types/labels. Queries run on
worker threads (the QLever client is synchronous) with concurrency capped by
``QLEVER_CONCURRENCY`` (``Settings.qlever_concurrency``) both per call and
process-wide (one shared executor, so concurrent streams cannot multiply the load)
— the endpoint is shared, so the cap is also a politeness limit. The
``iter_*`` variants yield per completed chunk for streaming.

Failure policy: any failed chunk raises its :class:`app.qlever.QleverError`
(including truncated bodies) out of the TaskGroup (unwrapped from the ExceptionGroup); no retry, no partial
result. The caller (B3) decides how to surface the error.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator, Callable, Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any, NamedTuple, TypeVar

from app import graph_config, qlever, templates
from app.settings import Settings

#: Frontier / node IRIs per query (types ~7s, labels ~6s per 2k, measured).
CHUNK = 2000

_T = TypeVar("_T")


class NodeType(NamedTuple):
    """Type info of a node: contract group (or None) and the skip flag.

    ``skip`` means "no typed group or colour": the node has a skip type and
    no mapped group. It does NOT mean "drop the node or its edges".
    """

    group: str | None
    skip: bool


def _chunks(items: Iterable[str], size: int = CHUNK) -> list[list[str]]:
    """De-duplicated, valid-IRI-only chunks (invalid IRIs can't enter VALUES)."""
    unique = list(dict.fromkeys(i for i in items if templates.is_valid_iri(i)))
    return [unique[i : i + size] for i in range(0, len(unique), size)]


#: Process-wide cap on concurrent QLever queries: ALL bulk queries (every
#: stream request) run on this one dedicated executor, so its size is the cap
#: and concurrent streams cannot multiply the load on the shared endpoint.
#: Created lazily on first use and sized ONCE from ``Settings.qlever_concurrency``
#: (a later env change needs a restart). Queued jobs are cancelled on failure
#: or disconnect; a query already running cannot be interrupted.
_executor: ThreadPoolExecutor | None = None  # pylint: disable=invalid-name
_executor_lock = threading.Lock()


def _get_executor() -> ThreadPoolExecutor:
    global _executor  # pylint: disable=global-statement
    with _executor_lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(
                max_workers=max(1, Settings.from_env().qlever_concurrency),
                thread_name_prefix="qlever",
            )
        return _executor


def shutdown_executor() -> None:
    """Drop queued jobs and release the shared executor (app shutdown)."""
    global _executor  # pylint: disable=global-statement
    with _executor_lock:
        executor, _executor = _executor, None
    if executor is not None:
        executor.shutdown(wait=False, cancel_futures=True)


async def _run_iter(
    jobs: Sequence[Callable[[], _T]], concurrency: int | None
) -> AsyncIterator[tuple[int, _T]]:
    """Run blocking *jobs* on the shared executor; yield ``(index, result)``
    as each finishes. At most *concurrency* per call, and the executor's
    size process-wide.

    The first failure is raised (unwrapped) and every queued sibling is
    cancelled — also when the consumer stops iterating early (client
    disconnect, time budget): jobs still queued in the executor never run.
    """
    cap = concurrency or Settings.from_env().qlever_concurrency
    sem = asyncio.Semaphore(max(1, cap))
    executor = _get_executor()
    loop = asyncio.get_running_loop()
    failed = False

    async def one(index: int, job: Callable[[], _T]) -> tuple[int, _T]:
        nonlocal failed
        async with sem:
            if failed:  # a sibling failed while we were queued
                raise asyncio.CancelledError
            try:
                # cancelling this await cancels the queued executor future
                return index, await loop.run_in_executor(executor, job)
            except Exception:
                failed = True
                raise

    tasks = [asyncio.create_task(one(i, job)) for i, job in enumerate(jobs)]
    try:
        for finished in asyncio.as_completed(tasks):
            yield await finished
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _run_all(
    jobs: Sequence[Callable[[], _T]], concurrency: int | None
) -> list[_T]:
    """:func:`_run_iter` collected in job order."""
    results: list[_T | None] = [None] * len(jobs)
    async for index, result in _run_iter(jobs, concurrency):
        results[index] = result
    return results  # type: ignore[return-value]


async def fetch_edges_ex(  # pylint: disable=too-many-arguments
    frontier: Iterable[str],
    relations: Sequence[str],
    *,
    client: qlever.QleverClient | None = None,
    concurrency: int | None = None,
    chunk_size: int = CHUNK,
    multi: bool = False,
    limit: int | None = None,
) -> tuple[list[tuple[str, str, str]], bool]:
    """Deduplicated ``(s, p, o)`` IRI edges touching *frontier* (both ways),
    plus a *saturated* flag: some query returned >= 95% of *limit* rows, so its
    result may be incomplete.

    ``multi=False``: one query per (chunk, relation). ``multi=True``: one
    query per chunk over all *relations* (far fewer requests). *limit* caps
    each query's result rows (hub protection).
    """
    cli = client or qlever.get_client()
    if multi:
        queries = [
            templates.edges_multi_construct_query(
                frontier=chunk, relations=relations, limit=limit
            )
            for chunk in _chunks(frontier, chunk_size)
        ]
    else:
        queries = [
            templates.edges_construct_query(frontier=chunk, relation=rel, limit=limit)
            for chunk in _chunks(frontier, chunk_size)
            for rel in relations
        ]
    results = await _run_all([partial(cli.construct, q) for q in queries], concurrency)
    # 95%: the count is after invalid-IRI filtering, slightly below the raw rows
    saturated = limit is not None and any(len(r) >= 0.95 * limit for r in results)
    return list(dict.fromkeys(t for triples in results for t in triples)), saturated


async def fetch_edges(
    frontier: Iterable[str], relations: Sequence[str], **kwargs: Any
) -> list[tuple[str, str, str]]:
    """:func:`fetch_edges_ex` without the saturation flag."""
    return (await fetch_edges_ex(frontier, relations, **kwargs))[0]


def _fold_types(
    results: Iterable[qlever.SelectResult], nodes: Iterable[str]
) -> dict[str, NodeType]:
    cfg = graph_config.load()
    type_group = cfg.type_group()
    rank = {g.name: i for i, g in enumerate(cfg.groups)}
    skip = set(cfg.skip_iris())
    out = {n: NodeType(None, False) for n in nodes}
    for res in results:
        for row in res.rows:
            node, typ = row.get("n"), row.get("t")
            if node is None or typ is None or node.value not in out:
                continue
            group, is_skip = out[node.value]
            new = type_group.get(typ.value)
            if new is not None and (group is None or rank[new] < rank[group]):
                group = new
            out[node.value] = NodeType(group, is_skip or typ.value in skip)
    return {n: NodeType(t.group, t.skip and t.group is None) for n, t in out.items()}


def _fold_labels(results: Iterable[qlever.SelectResult]) -> dict[str, str]:
    prio = {p: i for i, p in enumerate(graph_config.load().label_iris())}
    best: dict[str, tuple[bool, int, str]] = {}
    for res in results:
        for row in res.rows:
            node, pred, lab = row.get("n"), row.get("p"), row.get("l")
            if node is None or pred is None or lab is None or pred.value not in prio:
                continue
            key = (lab.type != "literal", prio[pred.value], lab.value)
            if node.value not in best or key < best[node.value]:
                best[node.value] = key
    return {n: k[2] for n, k in best.items()}


async def iter_types(
    iris: Iterable[str],
    *,
    client: qlever.QleverClient | None = None,
    concurrency: int | None = None,
    chunk_size: int = CHUNK,
) -> AsyncIterator[dict[str, NodeType]]:
    """:func:`fetch_types`, yielding one ``iri -> NodeType`` dict per chunk as
    each chunk completes (completion order; same fail-fast policy)."""
    cfg = graph_config.load()
    cli = client or qlever.get_client()
    wanted = [*cfg.type_group(), *cfg.skip_iris()]
    chunks = _chunks(iris, chunk_size)
    queries = [templates.types_query(nodes=c, type_iris=wanted) for c in chunks]
    jobs = [partial(cli.select_tsv, q) for q in queries]
    async for index, res in _run_iter(jobs, concurrency):
        yield _fold_types([res], chunks[index])


async def fetch_types(
    iris: Iterable[str],
    *,
    client: qlever.QleverClient | None = None,
    concurrency: int | None = None,
    chunk_size: int = CHUNK,
) -> dict[str, NodeType]:
    """``iri -> NodeType`` for every input IRI.

    A node with several types gets the first group in the config's group
    order; ``skip`` is set when it has a ``skip_types`` type and no mapped group.
    """
    out: dict[str, NodeType] = {}
    async for part in iter_types(
        iris, client=client, concurrency=concurrency, chunk_size=chunk_size
    ):
        out.update(part)
    return out


async def iter_labels(
    iris: Iterable[str],
    *,
    client: qlever.QleverClient | None = None,
    concurrency: int | None = None,
    chunk_size: int = CHUNK,
) -> AsyncIterator[dict[str, str]]:
    """:func:`fetch_labels`, yielding one dict per completed chunk."""
    label_iris = graph_config.load().label_iris()
    cli = client or qlever.get_client()
    queries = [
        templates.labels_query(nodes=c, label_iris=label_iris)
        for c in _chunks(iris, chunk_size)
    ]
    jobs = [partial(cli.select_tsv, q) for q in queries]
    async for _, res in _run_iter(jobs, concurrency):
        yield _fold_labels([res])


async def fetch_labels(
    iris: Iterable[str],
    *,
    client: qlever.QleverClient | None = None,
    concurrency: int | None = None,
    chunk_size: int = CHUNK,
) -> dict[str, str]:
    """``iri -> label`` for nodes that have one (nodes without are absent).

    Folded by label-property priority (config order); a literal always beats
    an IRI-valued label; remaining ties pick the smallest string so the
    result is deterministic.
    """
    out: dict[str, str] = {}
    async for part in iter_labels(
        iris, client=client, concurrency=concurrency, chunk_size=chunk_size
    ):
        out.update(part)
    return out


class NodeSummary(NamedTuple):
    """Info-panel data of one node (see :func:`fetch_node_summary`)."""

    types: list[str]
    node_type: NodeType
    label: str | None
    relations: dict[str, tuple[int, int]]  # predicate -> (out, in), both > 0 total


async def fetch_node_summary(
    iri: str, *, client: qlever.QleverClient | None = None
) -> NodeSummary:
    """Types, group/skip, label and per-relation out/in counts of one node.

    Three queries run concurrently on the shared executor: all ``rdf:type``
    IRIs, the label candidates, and one aggregate for the relation counts.
    Group/skip/label use the same folds as the bulk fetchers. Relation counts
    are edges (triples), not distinct neighbours; a self-loop counts in both
    directions.
    """
    cfg = graph_config.load()
    cli = client or qlever.get_client()
    queries = [
        templates.types_query(nodes=[iri]),
        templates.labels_query(nodes=[iri], label_iris=cfg.label_iris()),
        templates.node_relations_query(iri=iri, relation_iris=cfg.relation_iris()),
    ]
    types_res, labels_res, counts_res = await _run_all(
        [partial(cli.select_tsv, q) for q in queries], None
    )
    counts: dict[str, list[int]] = {}
    for row in counts_res.rows:
        pred, direction, num = row.get("p"), row.get("dir"), row.get("n")
        if pred is None or direction is None or num is None:
            continue
        pair = counts.setdefault(pred.value, [0, 0])
        pair[0 if direction.value == "out" else 1] += int(num.value)
    return NodeSummary(
        types=sorted({r["t"].value for r in types_res.rows if "t" in r}),
        node_type=_fold_types([types_res], [iri])[iri],
        label=_fold_labels([labels_res]).get(iri),
        relations={p: (o, i) for p, (o, i) in counts.items() if o + i > 0},
    )
