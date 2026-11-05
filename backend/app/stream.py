# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""``GET /api/stream``: progressive BFS as NDJSON (one event per line).

Event shapes are documented in ``app.contract`` (``Stream*``). The BFS runs
hop by hop from the root: the frontier (nodes first seen in the previous hop)
is fetched over all configured relations (``app.bulk``), new nodes are
emitted as soon as their edges are known, and their types/labels stream in
per completed chunk.

Overlap: the types/labels of hop *h* are fetched by a background task while
the BFS already fetches the edges of hop *h+1*; both feed one queue that the
response drains, so events interleave in completion order. A node's ``nodes``
event always precedes its ``edges``/``types``/``labels`` events.

Only the frontier is expanded: edges among nodes of the last hop, or among
nodes dropped/kept by a ``max_nodes`` truncation, are never fetched (so the
graph is not the induced subgraph of its nodes).

Limits: ``max_nodes`` is exact (a hop that would exceed it keeps the sorted
first IRIs; only edges between kept nodes are emitted); each edge query gets
a LIMIT (see ``LIMIT_FLOOR``) so a hub cannot blow up a query. A query that
hits it (>= 95% of the limit) does not stop the BFS; the run is marked capped
and ends with ``done(truncated)`` instead of ``exhausted``/``max_hops``.
Concurrency against QLever is capped process-wide in ``app.bulk``.
Failures become an ``error`` event + ``done(error)`` — never an HTTP error
once the response has started. Time budget and client disconnect cancel all
outstanding work.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app import bulk, graph_config, qlever, templates
from app.settings import Settings

router = APIRouter()
log = logging.getLogger(__name__)

#: Edge query LIMIT = clamp(remaining budget * 3 + margin, FLOOR, CAP). LIMIT
#: counts triples, and back-edges to already-seen nodes also consume it, hence
#: the factor and the floor; a query that still hits it marks the hop truncated.
LIMIT_MARGIN = 100
LIMIT_FLOOR = 20_000
LIMIT_CAP = 500_000
#: Seconds of silence after which a ``ping`` line is sent (keep-alive).
HEARTBEAT_S = 15.0
#: Bounded event queue: producers wait when the client reads slowly.
QUEUE_MAX = 64
#: Max items per ``nodes`` / ``edges`` event (keeps lines and frames bounded).
BATCH = 10_000

Event = dict[str, Any]
Emit = Callable[[Event], Awaitable[None]]
_DONE = object()


def _batches(items: list[Any]) -> Iterable[list[Any]]:
    for i in range(0, len(items), BATCH):
        yield items[i : i + BATCH]


async def _attrs(
    nodes: list[str], client: qlever.QleverClient | None, emit: Emit
) -> None:
    """Stream types and labels of *nodes* per completed chunk."""

    async def types() -> None:
        async for part in bulk.iter_types(nodes, client=client):
            await emit(
                {"type": "types", "types": {n: t.group for n, t in part.items()}}
            )

    async def labels() -> None:
        async for part in bulk.iter_labels(nodes, client=client):
            if part:
                await emit({"type": "labels", "labels": part})

    try:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(types())
            tg.create_task(labels())
    except ExceptionGroup as group:
        raise group.exceptions[0] from None


def _fold_hop(
    edges: list[tuple[str, str, str]],
    seen: set[str],
    seen_edges: set[tuple[str, str, str]],
    budget: int,
) -> tuple[list[str], list[tuple[str, str, str]], bool]:
    """Update *seen*/*seen_edges* with one hop's edges.

    Returns ``(new nodes, new edges, truncated)``: at most *budget* new nodes
    (the sorted first ones — deterministic) and only edges whose endpoints
    are both kept.
    """
    found = {x for s, _, o in edges for x in (s, o)} - seen
    new = sorted(found)[:budget]
    seen.update(new)
    fresh = sorted({e for e in edges if e[0] in seen and e[2] in seen} - seen_edges)
    seen_edges.update(fresh)
    return new, fresh, len(new) < len(found)


def _hop_events(
    hop: int, new: list[str], fresh: list[tuple[str, str, str]]
) -> Iterable[Event]:
    for part in _batches(new):
        yield {
            "type": "nodes",
            "hop": hop,
            "nodes": [{"id": n, "group": None} for n in part],
        }
    for part in _batches(fresh):
        yield {
            "type": "edges",
            "hop": hop,
            "edges": [{"s": s, "p": p, "o": o} for s, p, o in part],
        }


async def _fail_fast(main: asyncio.Task[Any], others: list[asyncio.Task[Any]]) -> Any:
    """Await *main*, but raise at once if any of *others* fails meanwhile."""
    try:
        while not main.done():
            pending = [t for t in others if not t.done()]
            await asyncio.wait([main, *pending], return_when=asyncio.FIRST_COMPLETED)
            for task in others:
                if task.done() and not task.cancelled() and task.exception():
                    raise task.exception()  # type: ignore[misc]
        return main.result()
    finally:
        main.cancel()
        await asyncio.gather(main, return_exceptions=True)


async def _bfs(  # pylint: disable=too-many-locals
    root: str,
    max_nodes: int,
    max_hops: int,
    client: qlever.QleverClient | None,
    multi: bool,
    emit: Emit,
) -> str:
    """Run the BFS, emitting events; return the ``done`` reason."""
    relations = graph_config.load().relation_iris()
    seen = {root}
    seen_edges: set[tuple[str, str, str]] = set()
    await emit({"type": "nodes", "hop": 0, "nodes": [{"id": root, "group": None}]})
    await emit({"type": "progress", "hop": 0, "nodes": 1, "edges": 0})
    attr_tasks = [asyncio.create_task(_attrs([root], client, emit))]
    frontier = [root]
    reason = "max_hops"
    capped = False  # some edge query hit its LIMIT (BFS goes on, result partial)
    try:
        if len(seen) >= max_nodes:
            reason = "max_nodes"
        else:
            for hop in range(1, max_hops + 1):
                budget = max_nodes - len(seen)
                fetch = asyncio.create_task(
                    bulk.fetch_edges_ex(
                        frontier,
                        relations,
                        client=client,
                        multi=multi,
                        limit=min(
                            max(budget * 3 + LIMIT_MARGIN, LIMIT_FLOOR), LIMIT_CAP
                        ),
                    )
                )
                edges, saturated = await _fail_fast(fetch, attr_tasks)
                new, fresh, truncated = _fold_hop(edges, seen, seen_edges, budget)
                capped = capped or saturated  # a LIMIT hit may hide nodes/edges
                for event in _hop_events(hop, new, fresh):
                    await emit(event)
                await emit(
                    {
                        "type": "progress",
                        "hop": hop,
                        "nodes": len(seen),
                        "edges": len(seen_edges),
                    }
                )
                if new:
                    attr_tasks.append(asyncio.create_task(_attrs(new, client, emit)))
                if truncated or (new and len(seen) >= max_nodes):
                    reason = "max_nodes"
                    capped = False
                    break
                if not new:
                    reason = "exhausted"
                    break
                frontier = new
            if capped and reason in ("exhausted", "max_hops"):
                reason = "truncated"
        await asyncio.gather(*attr_tasks)
    except BaseException:
        for task in attr_tasks:
            task.cancel()
        await asyncio.gather(*attr_tasks, return_exceptions=True)
        raise
    return reason


async def stream_events(
    root: str,
    *,
    max_nodes: int,
    max_hops: int,
    time_budget_s: float,
    client: qlever.QleverClient | None = None,
    multi: bool = True,
) -> AsyncIterator[Event]:
    """The event sequence of one stream (see module doc)."""
    yield {"type": "meta", "root": root, "max_nodes": max_nodes, "max_hops": max_hops}
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=QUEUE_MAX)

    async def drive() -> None:
        try:
            reason = await _bfs(root, max_nodes, max_hops, client, multi, queue.put)
            await queue.put({"type": "done", "reason": reason})
        except Exception as exc:  # pylint: disable=broad-exception-caught
            log.warning("stream from %s failed", root, exc_info=True)
            # generic on purpose: exception texts may carry query/endpoint URL
            await queue.put(
                {"type": "error", "message": f"query failed ({type(exc).__name__})"}
            )
            await queue.put({"type": "done", "reason": "error"})
        await queue.put(_DONE)

    deadline = time.monotonic() + time_budget_s
    driver = asyncio.create_task(drive())
    # One pending get() across iterations: wait_for(queue.get()) can drop an
    # item on cancellation before Python 3.12.
    getter: asyncio.Task[Any] | None = None
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:  # stop draining even if events keep coming
                yield {"type": "done", "reason": "time_budget"}
                return
            getter = getter or asyncio.create_task(queue.get())
            await asyncio.wait({getter}, timeout=min(remaining, HEARTBEAT_S))
            if getter.done():
                item, getter = getter.result(), None
            else:
                if deadline - time.monotonic() <= 0:
                    yield {"type": "done", "reason": "time_budget"}
                    return
                yield {"type": "ping"}
                continue
            if item is _DONE:
                return
            yield item
    finally:  # normal end, time budget, or client disconnect (generator closed)
        if getter is not None:
            getter.cancel()
        driver.cancel()
        await asyncio.gather(driver, return_exceptions=True)


def _line(event: Event) -> bytes:
    return json.dumps(event, separators=(",", ":")).encode() + b"\n"


@router.get("/api/stream")
async def stream(
    root: str = Query(description="Root entity IRI (hop 0)."),
    max_nodes: int | None = Query(default=None),
    max_hops: int | None = Query(default=None),
    time_budget_s: float | None = Query(default=None),
) -> StreamingResponse:
    """Progressive BFS from *root* as ``application/x-ndjson``."""
    try:
        templates.assert_valid_iri(root)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    cfg = Settings.from_env()
    nodes = min(
        max(cfg.stream_max_nodes if max_nodes is None else max_nodes, 1),
        cfg.stream_max_nodes,
    )
    hops = min(max(6 if max_hops is None else max_hops, 0), cfg.stream_max_hops)
    budget = min(
        max(120.0 if time_budget_s is None else time_budget_s, 1.0),
        cfg.stream_max_time_budget_s,
    )

    async def body() -> AsyncIterator[bytes]:
        async for event in stream_events(
            root,
            max_nodes=nodes,
            max_hops=hops,
            time_budget_s=budget,
            multi=cfg.stream_multi_relation,
        ):
            yield _line(event)

    return StreamingResponse(
        body(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
