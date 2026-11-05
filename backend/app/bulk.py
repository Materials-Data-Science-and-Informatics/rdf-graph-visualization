# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Bulk fetch helpers for the BFS streaming endpoint (B3).

Edges and node attributes are fetched with flat queries over VALUES chunks
of :data:`CHUNK` IRIs (see the notes in ``app.templates``), one query per
(chunk, relation) for edges and per chunk for types/labels. Queries run on
worker threads (the QLever client is synchronous) with concurrency capped by
``QLEVER_CONCURRENCY`` (``Settings.qlever_concurrency``) — the endpoint
is shared, so the cap is also a politeness limit.

Failure policy: any failed chunk raises its :class:`app.qlever.QleverError`
(including truncated bodies) out of the TaskGroup (unwrapped from the ExceptionGroup); no retry, no partial
result. The caller (B3) decides how to surface the error.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterable, Sequence
from functools import partial
from typing import NamedTuple, TypeVar

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


async def _run_all(
    jobs: Sequence[Callable[[], _T]], concurrency: int | None
) -> list[_T]:
    """Run blocking *jobs* on threads, at most *concurrency* at once."""
    cap = concurrency or Settings.from_env().qlever_concurrency
    sem = asyncio.Semaphore(max(1, cap))

    failed = False

    async def one(job: Callable[[], _T]) -> _T:
        nonlocal failed
        async with sem:
            if failed:  # a sibling failed while we were queued: don't start
                raise asyncio.CancelledError
            try:
                return await asyncio.to_thread(job)
            except Exception:
                failed = True
                raise

    try:
        # TaskGroup: after the first failure queued jobs are cancelled.
        async with asyncio.TaskGroup() as tg:
            tasks = [tg.create_task(one(job)) for job in jobs]
    except ExceptionGroup as group:
        raise group.exceptions[0] from None
    return [t.result() for t in tasks]


async def fetch_edges(
    frontier: Iterable[str],
    relations: Sequence[str],
    *,
    client: qlever.QleverClient | None = None,
    concurrency: int | None = None,
    chunk_size: int = CHUNK,
) -> list[tuple[str, str, str]]:
    """Deduplicated ``(s, p, o)`` IRI edges touching *frontier* (both ways)."""
    cli = client or qlever.get_client()
    queries = [
        templates.edges_construct_query(frontier=chunk, relation=rel)
        for chunk in _chunks(frontier, chunk_size)
        for rel in relations
    ]
    results = await _run_all([partial(cli.construct, q) for q in queries], concurrency)
    return list(dict.fromkeys(t for triples in results for t in triples))


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
    cfg = graph_config.load()
    cli = client or qlever.get_client()
    wanted = [*cfg.type_group(), *cfg.skip_iris()]
    chunks = _chunks(iris, chunk_size)
    queries = [templates.types_query(nodes=c, type_iris=wanted) for c in chunks]
    results = await _run_all([partial(cli.select_tsv, q) for q in queries], concurrency)
    return _fold_types(results, (n for c in chunks for n in c))


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
    label_iris = graph_config.load().label_iris()
    cli = client or qlever.get_client()
    queries = [
        templates.labels_query(nodes=c, label_iris=label_iris)
        for c in _chunks(iris, chunk_size)
    ]
    results = await _run_all([partial(cli.select_tsv, q) for q in queries], concurrency)
    return _fold_labels(results)
