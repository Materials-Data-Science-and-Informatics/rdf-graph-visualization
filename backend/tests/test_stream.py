# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""/api/stream: BFS event protocol, limits, errors, middleware exemption.

A fake QLever client answers the bulk queries from an in-memory graph (no
network); the endpoint is exercised through ``TestClient`` and the event
generator directly.
"""

from __future__ import annotations

import asyncio
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from app import bulk, contract, graph_config, middleware, qlever, stream, templates
from app.main import app
from app.qlever import Binding as B
from app.qlever import QleverServerError, SelectResult
from app.settings import Settings

CFG = graph_config.load()
REL, REL2 = CFG.relation_iris()[:2]
LABEL = CFG.label_iris()[0]
GROUP = CFG.groups[0]
N = "https://x.org/"
R, A, Bn, C, D = (N + c for c in "RABCD")
EVENT = TypeAdapter(contract.StreamEvent)

#: R-A, R-B (hop 1), A-C (hop 2, incoming), C-D (hop 3); B-A links two seen nodes.
GRAPH = [(R, REL, A), (R, REL, Bn), (C, REL2, A), (D, REL, C), (Bn, REL, A)]


class FakeClient:
    """Answers edge/type/label queries from GRAPH; records every query."""

    def __init__(
        self,
        graph=GRAPH,
        delay: float = 0.0,
        fail_on: str | None = None,
        gate: threading.Event | None = None,
    ):
        self.graph, self.delay, self.fail_on = graph, delay, fail_on
        self.gate = gate  # queries block until it is set
        self.queries: list[str] = []
        self._lock = threading.Lock()

    def close(self) -> None:
        """Client protocol (``qlever.reset_client`` closes the old client)."""

    def _record(self, query: str) -> None:
        with self._lock:
            self.queries.append(query)
        if self.gate:
            self.gate.wait(10)
        time.sleep(self.delay)
        if self.fail_on and self.fail_on in query:
            raise QleverServerError("boom")

    def construct(self, query: str):
        self._record(query)
        front = set(re.search(r"VALUES \?s \{ (.*?) \}", query).group(1).split())
        front = {f.strip("<>") for f in front}
        out = [t for t in self.graph if t[0] in front or t[2] in front]
        limit = re.search(r"LIMIT (\d+)$", query)
        return out[: int(limit.group(1))] if limit else out

    def select_tsv(self, query: str) -> SelectResult:
        self._record(query)
        nodes = re.search(r"VALUES \?n \{ (.*?) \}", query).group(1).split()
        nodes = [n.strip("<>") for n in nodes]
        if "?n ?p ?l" in query:
            rows = [
                {
                    "n": B("uri", n),
                    "p": B("uri", LABEL),
                    "l": B("literal", f"L-{n[-1]}"),
                }
                for n in nodes
                if n != D  # D has no label
            ]
        else:
            rows = [
                {"n": B("uri", n), "t": B("uri", GROUP.types[0])}
                for n in nodes
                if n in (R, A)  # only R and A are typed
            ]
        return SelectResult(vars=[], rows=rows)


@pytest.fixture()
def fake():
    cli = FakeClient()
    qlever.set_client(cli)
    yield cli
    qlever.reset_client()


def run(path: str) -> tuple[list[dict[str, Any]], Any]:
    with TestClient(app) as client:
        resp = client.get(path)
    return [json.loads(line) for line in resp.text.splitlines()], resp


def url(root: str = R, **params: Any) -> str:
    query = "&".join(f"{k}={v}" for k, v in {"root": root, **params}.items())
    return f"/api/stream?{query}"


def kinds(events: list[dict[str, Any]]) -> list[str]:
    return [e["type"] for e in events]


def nodes_of(events: list[dict[str, Any]], hop: int) -> list[str]:
    return [
        n["id"]
        for e in events
        if e["type"] == "nodes" and e["hop"] == hop
        for n in e["nodes"]
    ]


# -- protocol --------------------------------------------------------------------


def test_stream_events_order_shapes_and_multi_hop(fake) -> None:
    events, resp = run(url(max_hops=6))
    assert resp.headers["content-type"].startswith("application/x-ndjson")
    for e in events:
        EVENT.validate_python(e)  # every line matches the documented contract
    assert events[0] == {
        "type": "meta",
        "root": R,
        "max_nodes": 100000,
        "max_hops": 6,
        "max_fanout": 200,
    }
    assert events[-1] == {"type": "done", "reason": "exhausted"}
    assert [nodes_of(events, h) for h in range(4)] == [[R], [A, Bn], [C], [D]]
    edges = [
        (x["s"], x["p"], x["o"])
        for e in events
        if e["type"] == "edges"
        for x in e["edges"]
    ]
    assert sorted(edges) == sorted(GRAPH)  # predicate carried, no duplicates
    # nodes precede their edges
    first_edge = kinds(events).index("edges")
    assert kinds(events)[1] == "nodes" and first_edge > 1
    types: dict[str, Any] = {}
    labels: dict[str, str] = {}
    for e in events:
        types.update(e.get("types", {}))
        labels.update(e.get("labels", {}))
    assert types == {R: GROUP.name, A: GROUP.name, Bn: None, C: None, D: None}
    assert labels == {R: "L-R", A: "L-A", Bn: "L-B", C: "L-C"}  # D has none
    last = [e for e in events if e["type"] == "progress"][-1]
    assert last == {"type": "progress", "hop": 4, "nodes": 5, "edges": 5}


def test_iter_types_and_labels_yield_per_completed_chunk() -> None:
    async def go():
        cli = FakeClient()
        types = [t async for t in bulk.iter_types([R, A, Bn], client=cli, chunk_size=1)]
        labels = [x async for x in bulk.iter_labels([R, D], client=cli, chunk_size=1)]
        return types, labels

    types, labels = asyncio.run(go())
    assert sorted(len(t) for t in types) == [1, 1, 1]
    assert {n for t in types for n in t} == {R, A, Bn}
    assert labels == [{R: "L-R"}, {}] or labels == [{}, {R: "L-R"}]


async def collect(root: str, chunk: int | None = None, **kw: Any):
    kw.setdefault("max_nodes", 1000)
    kw.setdefault("max_hops", 6)
    kw.setdefault("time_budget_s", 30)
    return [e async for e in stream.stream_events(root, **kw)]


def test_max_hops_stops_with_reason(fake) -> None:
    events, _ = run(url(max_hops=2))
    assert nodes_of(events, 3) == []
    assert events[-1] == {"type": "done", "reason": "max_hops"}
    events, _ = run(url(max_hops=0))
    assert nodes_of(events, 1) == [] and events[-1]["reason"] == "max_hops"


def test_max_nodes_keeps_deterministic_subset_and_inner_edges(fake) -> None:
    events, _ = run(url(max_nodes=2))
    assert nodes_of(events, 1) == [A]  # sorted first of {A, B}, budget 1
    edges = [
        (x["s"], x["p"], x["o"])
        for e in events
        if e["type"] == "edges"
        for x in e["edges"]
    ]
    assert edges == [(R, REL, A)]  # R-B, B-A dropped: B not kept
    assert events[-1] == {"type": "done", "reason": "max_nodes"}
    assert [e for e in events if e["type"] == "progress"][-1]["nodes"] == 2


def test_max_nodes_exact_fit_stops_with_max_nodes(fake) -> None:
    events, _ = run(url(max_nodes=3))
    ids = [i for h in range(4) for i in nodes_of(events, h)]
    assert ids == [R, A, Bn]
    edges = [
        (x["s"], x["p"], x["o"])
        for e in events
        if e["type"] == "edges"
        for x in e["edges"]
    ]
    # B-A is only discovered when B is expanded, which the budget prevents
    assert sorted(edges) == sorted([(R, REL, A), (R, REL, Bn)])
    assert events[-1]["reason"] == "max_nodes"


def test_edge_query_is_single_multi_relation_with_hub_limit(fake) -> None:
    run(url(max_nodes=500, max_hops=1))
    edge_queries = [q for q in fake.queries if q.startswith("CONSTRUCT")]
    assert len(edge_queries) == 1
    assert "CONSTRUCT { ?s ?p ?o }" in edge_queries[0]
    assert all(f"<{r}>" in edge_queries[0] for r in CFG.relation_iris())
    assert edge_queries[0].endswith(f"LIMIT {stream.LIMIT_FLOOR}")


def test_per_relation_switch(fake, monkeypatch) -> None:
    monkeypatch.setenv("STREAM_MULTI_RELATION", "0")
    run(url(max_hops=1))
    edge_queries = [q for q in fake.queries if q.startswith("CONSTRUCT")]
    assert len(edge_queries) == len(CFG.relation_iris())


def test_params_are_clamped_to_settings(fake, monkeypatch) -> None:
    monkeypatch.setenv("STREAM_MAX_NODES", "50")
    monkeypatch.setenv("STREAM_MAX_HOPS", "1")
    events, _ = run(url(max_nodes=999999, max_hops=99))
    assert events[0] == {
        "type": "meta",
        "root": R,
        "max_nodes": 50,
        "max_hops": 1,
        "max_fanout": 200,
    }


def test_invalid_root_is_422_before_streaming(fake) -> None:
    _, resp = run("/api/stream?root=not%20an%20iri")
    assert resp.status_code == 422
    assert not fake.queries


def test_failed_chunk_yields_error_then_done_error() -> None:
    qlever.set_client(FakeClient(fail_on="CONSTRUCT"))
    try:
        events, resp = run(url())
    finally:
        qlever.reset_client()
    assert resp.status_code == 200  # never a 500 mid-stream
    assert events[-2] == {
        "type": "error",
        "message": "query failed (QleverServerError)",
    }
    assert "boom" not in json.dumps(events)  # no raw exception text leaks
    assert events[-1] == {"type": "done", "reason": "error"}
    EVENT.validate_python(events[-2])


def test_failed_types_chunk_also_errors_early() -> None:
    qlever.set_client(FakeClient(fail_on="?n ?t"))
    try:
        events, _ = run(url())
    finally:
        qlever.reset_client()
    assert events[-1] == {"type": "done", "reason": "error"}
    assert "error" in kinds(events)


def test_time_budget_stops_and_cancels() -> None:
    cli = FakeClient(delay=0.4)
    events = asyncio.run(collect(R, time_budget_s=0.1, client=cli))
    assert events[-1] == {"type": "done", "reason": "time_budget"}
    assert kinds(events).count("done") == 1


def test_client_disconnect_cancels_queued_work(monkeypatch) -> None:
    started, release = threading.Event(), threading.Event()

    class Blocking(FakeClient):
        def _record(self, query: str) -> None:
            with self._lock:
                self.queries.append(query)
            started.set()
            release.wait(5)

    cli = Blocking()
    executor = ThreadPoolExecutor(max_workers=1)  # one running, rest queued
    monkeypatch.setattr(bulk, "_executor", executor)

    async def scenario() -> None:
        gen = stream.stream_events(
            R, max_nodes=100, max_hops=6, time_budget_s=30, client=cli
        )
        assert (await anext(gen))["type"] == "meta"
        assert (await anext(gen))["type"] == "nodes"
        await asyncio.to_thread(started.wait, 5)
        await gen.aclose()  # what Starlette does on disconnect
        release.set()

    asyncio.run(scenario())
    executor.shutdown(wait=True)  # drains whatever was not cancelled
    assert len(cli.queries) == 1  # the queued queries never reached QLever


def test_saturated_hop_keeps_expanding_and_ends_truncated(monkeypatch) -> None:
    """A LIMIT hit never stops the BFS nor yields "exhausted"/"max_hops"."""
    monkeypatch.setattr(stream, "LIMIT_FLOOR", 3)
    monkeypatch.setattr(stream, "LIMIT_MARGIN", 0)
    rel3 = CFG.relation_iris()[2]
    # hop 2 (frontier A) returns only rows among seen nodes, at the limit
    graph = [(R, REL, A), (A, REL2, A), (A, rel3, A), (A, REL, A)]
    events = asyncio.run(collect(R, client=FakeClient(graph), max_nodes=3))
    assert nodes_of(events, 2) == []
    assert events[-1] == {"type": "done", "reason": "truncated"}
    # saturation with new nodes under budget: next hop is still explored
    graph = [(Bn, REL, C), (R, REL, A), (R, REL2, A), (R, rel3, Bn)]
    monkeypatch.setattr(stream, "LIMIT_CAP", 3)  # pins the limit despite budget
    events = asyncio.run(collect(R, client=FakeClient(graph), max_nodes=100))
    assert nodes_of(events, 2) == [C]
    assert events[-1]["reason"] == "truncated"
    # max_hops while capped is truncated too; uncapped stays max_hops
    events = asyncio.run(collect(R, client=FakeClient(graph), max_hops=1))
    assert events[-1]["reason"] == "truncated"
    monkeypatch.setattr(stream, "LIMIT_CAP", 100)
    monkeypatch.setattr(stream, "LIMIT_FLOOR", 100)
    events = asyncio.run(collect(R, client=FakeClient(graph), max_hops=1))
    assert events[-1]["reason"] == "max_hops"


def test_max_nodes_zero_is_clamped_not_defaulted(fake) -> None:
    events, _ = run(url(max_nodes=0))
    assert events[0]["max_nodes"] == 1
    assert events[-1]["reason"] == "max_nodes"


def test_ping_when_silent_and_no_drain_after_budget(monkeypatch) -> None:
    monkeypatch.setattr(stream, "HEARTBEAT_S", 0.05)
    events = asyncio.run(collect(R, client=FakeClient(delay=0.3), max_hops=1))
    assert {"type": "ping"} in events
    EVENT.validate_python({"type": "ping"})
    events = asyncio.run(
        collect(R, client=FakeClient(delay=0.3), time_budget_s=0.1, max_hops=1)
    )
    assert events[-1] == {"type": "done", "reason": "time_budget"}


# -- process-wide concurrency cap ---------------------------------------------------


def test_shared_executor_caps_concurrent_streams(monkeypatch) -> None:
    monkeypatch.setenv("QLEVER_CONCURRENCY", "2")
    monkeypatch.setattr(bulk, "_executor", None)
    peak = 0
    inflight = 0
    lock = threading.Lock()

    class Counting(FakeClient):
        def _record(self, query: str) -> None:
            nonlocal peak, inflight
            with lock:
                inflight += 1
                peak = max(peak, inflight)
            time.sleep(0.05)
            with lock:
                inflight -= 1

    async def two_streams() -> None:
        cli = Counting()
        await asyncio.gather(
            collect(R, client=cli, max_hops=2), collect(R, client=cli, max_hops=2)
        )

    asyncio.run(two_streams())
    assert 1 <= peak <= 2


# -- middleware ----------------------------------------------------------------------


def test_stream_is_never_cached(fake) -> None:
    first, resp1 = run(url(max_hops=1))
    queries_after_first = len(fake.queries)
    second, resp2 = run(url(max_hops=1))
    assert "x-cache" not in resp1.headers and "x-cache" not in resp2.headers
    assert len(fake.queries) == 2 * queries_after_first  # second call hit QLever
    assert len(middleware._get_cache()) == 0
    assert first[0] == second[0]


def test_middleware_passes_stream_through_unbuffered() -> None:
    """The first chunk reaches the client while the app is still producing."""
    sent: list[dict[str, Any]] = []
    first_chunk_seen = asyncio.Event()

    async def slow_app(scope, receive, send) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"1\n", "more_body": True})
        # would deadlock if the middleware buffered the body until completion
        await asyncio.wait_for(first_chunk_seen.wait(), timeout=2)
        await send({"type": "http.response.body", "body": b"2\n", "more_body": False})

    async def client_send(message: dict[str, Any]) -> None:
        sent.append(message)
        if message["type"] == "http.response.body" and message["body"] == b"1\n":
            first_chunk_seen.set()

    async def receive() -> dict[str, Any]:
        return {"type": "http.disconnect"}

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/stream",
        "query_string": b"root=x",
        "client": ("1.2.3.4", 1),
    }
    asyncio.run(middleware.ApiGuardMiddleware(slow_app)(scope, receive, client_send))
    assert [m.get("body") for m in sent[1:]] == [b"1\n", b"2\n"]
    assert len(middleware._get_cache()) == 0


def test_stream_is_still_rate_limited(fake, monkeypatch) -> None:
    monkeypatch.setenv("HKG_RATE_LIMIT_PER_MIN", "1")
    _, ok = run(url(max_hops=0))
    _, limited = run(url(max_hops=0))
    assert ok.status_code == 200 and limited.status_code == 429
    assert "retry-after" in limited.headers


# -- template ---------------------------------------------------------------------------


def test_multi_relation_template_shape() -> None:
    q = templates.edges_multi_construct_query(
        frontier=[A, Bn], relations=[REL, REL2], limit=9
    )
    assert q.startswith("CONSTRUCT { ?s ?p ?o } WHERE {")
    assert q.count(f"VALUES ?p {{ <{REL}> <{REL2}> }}") == 2  # plain join, both
    assert f"VALUES ?s {{ <{A}> <{Bn}> }}" in q and f"VALUES ?o {{ <{A}> <{Bn}> }}" in q
    assert "FILTER(isIRI(?o))" in q and "FILTER(isIRI(?s))" in q
    assert "UNION" in q and "OPTIONAL" not in q and q.endswith("LIMIT 9")
    assert "LIMIT" not in templates.edges_multi_construct_query(
        frontier=[A], relations=[REL]
    )
    with pytest.raises(ValueError):
        templates.edges_multi_construct_query(frontier=[A], relations=[])
    with pytest.raises(ValueError):
        templates.edges_multi_construct_query(frontier=["a> }"], relations=[REL])


def test_fanout_caps_new_neighbours_per_frontier_node() -> None:
    # pylint: disable=protected-access
    hub, other = "https://x/hub", "https://x/other"
    leaves = [f"https://x/l{i:02d}" for i in range(10)]
    edges = [(hub, "p", leaf) for leaf in leaves] + [(leaves[0], "p", other)]
    seen = {hub}
    new, fresh, truncated, fanned = stream._fold_hop(
        edges, seen, set(), 100, frontier=[hub], fanout=3
    )
    assert new == leaves[:3]  # sorted first three; budget not hit
    assert (truncated, fanned) == (False, True)
    assert fresh == sorted((hub, "p", leaf) for leaf in leaves[:3])
    # no cap: every neighbour of the frontier is kept
    new, _, _, fanned = stream._fold_hop(edges, {hub}, set(), 100, frontier=[hub])
    assert len(new) == 11 and not fanned


def test_prewarm_keys_cover_default_root_and_presets(monkeypatch) -> None:
    monkeypatch.setenv("PREWARM_ROOTS", f"https://ror.org/02nv7yv05, {R}, not an iri")
    monkeypatch.setenv("DEFAULT_ROOT_IRI", R)
    keys = stream.prewarm_keys(Settings.from_env())
    assert [k[0] for k in keys] == [R, "https://ror.org/02nv7yv05"]
    assert all(k[1:] == (5000, 6, 200) for k in keys)
