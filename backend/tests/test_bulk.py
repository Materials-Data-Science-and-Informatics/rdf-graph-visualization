# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Bulk BFS building blocks: bulk templates, N-Triples/TSV client parsing,
truncation detection and the chunked/concurrent fetchers (fake client)."""

from __future__ import annotations

import asyncio
import threading
import time

import httpx
import pytest

from app import bulk, graph_config, templates
from app.qlever import Binding as B
from app.qlever import QleverClient, QleverServerError, SelectResult

DEV_URL = "https://sparql.unhide.helmholtz-metadaten.de/sparql"
S = "https://schema.org/"
A, Bn, C = "https://x.org/a", "https://x.org/b", "https://x.org/c"


def client_for(body: str, accept: list[str] | None = None) -> QleverClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if accept is not None:
            accept.append(request.headers["accept"])
        return httpx.Response(200, content=body.encode())

    return QleverClient(DEV_URL, transport=httpx.MockTransport(handler))


# -- templates ------------------------------------------------------------------


def test_edges_query_is_per_relation_both_directions_iri_only() -> None:
    q = templates.edges_construct_query(frontier=[A, Bn], relation=S + "author")
    assert q.startswith(f"CONSTRUCT {{ ?s <{S}author> ?o }}")
    assert "VALUES ?s { <https://x.org/a> <https://x.org/b> }" in q
    assert "VALUES ?o { <https://x.org/a> <https://x.org/b> }" in q
    assert "FILTER(isIRI(?o))" in q and "FILTER(isIRI(?s))" in q
    assert "UNION" in q and "LIMIT" not in q
    assert templates.edges_construct_query(
        frontier=[A], relation=S + "author", limit=7
    ).endswith("LIMIT 7")


@pytest.mark.parametrize(
    "call",
    [
        lambda: templates.edges_construct_query(frontier=["a> } #"], relation=S),
        lambda: templates.edges_construct_query(frontier=[A], relation="x> ?s"),
        lambda: templates.types_query(nodes=["not an iri"]),
        lambda: templates.labels_query(nodes=[A], label_iris=["bad iri"]),
    ],
)
def test_bulk_templates_reject_unsafe_iris(call) -> None:
    with pytest.raises(ValueError):
        call()


def test_bulk_templates_reject_empty_and_bad_limit() -> None:
    with pytest.raises(ValueError):
        templates.edges_construct_query(frontier=[], relation=S)
    with pytest.raises(ValueError):
        templates.edges_construct_query(frontier=[A], relation=S, limit=0)
    with pytest.raises(ValueError):
        templates.labels_query(nodes=[A], label_iris=[])


def test_types_and_labels_queries_are_flat() -> None:
    t = templates.types_query(nodes=[A], type_iris=[S + "Person"])
    assert "VALUES ?n { <https://x.org/a> }" in t
    assert f"VALUES ?t {{ <{S}Person> }}" in t and "OPTIONAL" not in t
    assert "VALUES ?t" not in templates.types_query(nodes=[A])
    lab = templates.labels_query(nodes=[A], label_iris=[S + "name", S + "prefName"])
    assert f"VALUES ?p {{ <{S}name> <{S}prefName> }}" in lab
    assert "OPTIONAL" not in lab and "?n ?p ?l" in lab


# -- client parsing -------------------------------------------------------------


def test_construct_parses_iri_triples_and_skips_literals_and_bnodes() -> None:
    body = (
        f"<{A}> <{S}author> <{Bn}> .\n"
        f'<{A}> <{S}name> "Alice \\"x\\" ." .\n'
        f"_:b0 <{S}author> <{C}> .\n"
        f"<{A}> <{S}author> _:b1 .\n"
    )
    accept: list[str] = []
    triples = client_for(body, accept).construct("CONSTRUCT ...")
    assert triples == [(A, S + "author", Bn)]
    assert accept == ["application/n-triples"]


def test_construct_empty_body_is_no_triples() -> None:
    assert client_for("").construct("CONSTRUCT ...") == []


def test_construct_truncated_body_raises() -> None:
    body = f"<{A}> <{S}author> <{Bn}> .\n<{A}> <{S}author> <https://x.o"
    with pytest.raises(QleverServerError, match="truncated"):
        client_for(body).construct("CONSTRUCT ...")


def test_construct_garbage_line_raises() -> None:
    with pytest.raises(QleverServerError, match="N-Triples"):
        client_for("this is not a triple\n").construct("CONSTRUCT ...")


def test_select_tsv_parses_cells() -> None:
    body = (
        "?n\t?l\n"
        f'<{A}>\t"Alice\\tB"@en\n'
        f'<{Bn}>\t"7"^^<http://www.w3.org/2001/XMLSchema#int>\n'
        f"<{C}>\t\n"
    )
    accept: list[str] = []
    res = client_for(body, accept).select_tsv("SELECT ...")
    assert res.vars == ["n", "l"]
    assert res.rows[0] == {"n": B("uri", A), "l": B("literal", "Alice\tB", "en")}
    assert res.rows[1]["l"].datatype == "http://www.w3.org/2001/XMLSchema#int"
    assert res.rows[2] == {"n": B("uri", C)}  # unbound cell omitted
    assert accept == ["text/tab-separated-values"]


def test_select_tsv_truncated_or_malformed_raises() -> None:
    with pytest.raises(QleverServerError, match="truncated"):
        client_for(f"?n\t?t\n<{A}>\t<https://x").select_tsv("SELECT ...")
    with pytest.raises(QleverServerError, match="empty"):
        client_for("").select_tsv("SELECT ...")
    with pytest.raises(QleverServerError, match="malformed"):
        client_for(f"?n\t?t\n<{A}>\n").select_tsv("SELECT ...")


# -- bulk fetchers with a fake client ------------------------------------------


class FakeClient:
    """Records queries; tracks peak in-flight calls across threads."""

    def __init__(self, construct=None, select=None, delay: float = 0.0) -> None:
        self._construct, self._select, self._delay = construct, select, delay
        self.queries: list[str] = []
        self.inflight = self.peak = 0
        self._lock = threading.Lock()

    def _enter(self, query: str) -> None:
        with self._lock:
            self.queries.append(query)
            self.inflight += 1
            self.peak = max(self.peak, self.inflight)
        time.sleep(self._delay)
        with self._lock:
            self.inflight -= 1

    def construct(self, query: str):
        self._enter(query)
        return self._construct(query)

    def select_tsv(self, query: str) -> SelectResult:
        self._enter(query)
        return SelectResult(vars=[], rows=self._select(query))


def test_fetch_edges_ex_chunks_per_relation_dedupes_and_caps_concurrency() -> None:
    frontier = [f"https://x.org/n{i}" for i in range(5)]
    rels = [S + "author", S + "creator"]
    fake = FakeClient(
        construct=lambda q: [(A, S + "author", Bn), (A, S + "author", Bn)],
        delay=0.05,
    )
    edges, _ = asyncio.run(
        bulk.fetch_edges_ex(
            frontier + frontier, rels, client=fake, concurrency=2, chunk_size=2
        )
    )
    assert len(fake.queries) == 3 * 2  # ceil(5/2) chunks x 2 relations
    # the frontier appears twice per query (VALUES ?s and VALUES ?o)
    sizes = sorted(q.count("<https://x.org/n") // 2 for q in fake.queries)
    assert sizes == [1, 1, 2, 2, 2, 2]
    assert edges == [(A, S + "author", Bn)]
    assert fake.peak == 2  # semaphore cap reached and never exceeded


def test_fetch_edges_ex_failure_propagates() -> None:
    def boom(_q: str):
        raise QleverServerError("truncated")

    with pytest.raises(QleverServerError):
        asyncio.run(bulk.fetch_edges_ex([A], [S + "author"], client=FakeClient(boom)))


def test_fetch_types_picks_first_group_in_config_order_and_skip() -> None:
    cfg = graph_config.load()
    first, second = cfg.groups[0], cfg.groups[1]
    skip = cfg.skip_iris()[0]
    rows = [
        {"n": B("uri", A), "t": B("uri", second.types[0])},
        {"n": B("uri", A), "t": B("uri", first.types[0])},  # earlier group wins
        {"n": B("uri", Bn), "t": B("uri", skip)},
        {"n": B("uri", "https://x.org/unrelated"), "t": B("uri", first.types[0])},
    ]
    fake = FakeClient(select=lambda q: rows)
    out = asyncio.run(bulk.fetch_types([A, Bn, C], client=fake))
    assert out == {
        A: bulk.NodeType(first.name, False),
        Bn: bulk.NodeType(None, True),
        C: bulk.NodeType(None, False),
    }
    assert f"<{skip}>" in fake.queries[0]  # VALUES ?t restricts to known types


def test_fetch_labels_folds_by_priority_and_prefers_literals() -> None:
    p_pref, p_name, p_id = graph_config.load().label_iris()[:3]
    rows = [
        {"n": B("uri", A), "p": B("uri", p_name), "l": B("literal", "name")},
        {"n": B("uri", A), "p": B("uri", p_pref), "l": B("literal", "pref")},
        {"n": B("uri", Bn), "p": B("uri", p_pref), "l": B("uri", "https://i/x")},
        {"n": B("uri", Bn), "p": B("uri", p_id), "l": B("literal", "ident")},
        {"n": B("uri", C), "p": B("uri", S + "other"), "l": B("literal", "no")},
    ]
    out = asyncio.run(
        bulk.fetch_labels([A, Bn, C], client=FakeClient(select=lambda q: rows))
    )
    assert out == {A: "pref", Bn: "ident"}  # literal beats IRI; C has no label


def test_fetch_labels_chunks_in_parallel() -> None:
    fake = FakeClient(select=lambda q: [], delay=0.05)
    asyncio.run(
        bulk.fetch_labels(
            [f"https://x.org/n{i}" for i in range(6)],
            client=fake,
            concurrency=3,
            chunk_size=2,
        )
    )
    assert len(fake.queries) == 3 and fake.peak == 3


def test_fetch_edges_ex_first_failure_cancels_queued_chunks() -> None:
    def boom(_q: str):
        raise QleverServerError("boom")

    fake = FakeClient(construct=boom)
    with pytest.raises(QleverServerError, match="boom"):
        asyncio.run(
            bulk.fetch_edges_ex(
                [f"https://x.org/n{i}" for i in range(5)],
                [S + "author"],
                client=fake,
                concurrency=1,
                chunk_size=1,
            )
        )
    assert len(fake.queries) == 1


def test_skip_only_when_no_group() -> None:
    cfg = graph_config.load()
    skip, grouped = cfg.skip_iris()[0], cfg.groups[0].types[0]
    rows = [
        {"n": B("uri", A), "t": B("uri", skip)},
        {"n": B("uri", A), "t": B("uri", grouped)},
        {"n": B("uri", Bn), "t": B("uri", skip)},
    ]
    out = asyncio.run(
        bulk.fetch_types([A, Bn], client=FakeClient(select=lambda q: rows))
    )
    assert out[A] == bulk.NodeType(cfg.groups[0].name, False)
    assert out[Bn] == bulk.NodeType(None, True)


def test_invalid_iris_are_dropped() -> None:
    body = f"<{A}> <{S}author> <{Bn}> .\n"
    body += f"<{A}> <{S}author> <noscheme> .\n<> <{S}author> <{C}> .\n"
    assert client_for(body).construct("CONSTRUCT ...") == [(A, S + "author", Bn)]
    fake = FakeClient(select=lambda q: [])
    asyncio.run(bulk.fetch_types([A, "bad iri>", "noscheme"], client=fake))
    asyncio.run(bulk.fetch_labels(["bad iri>"], client=fake))
    assert len(fake.queries) == 1 and "bad iri" not in fake.queries[0]


def test_concurrency_setting_parsing_and_clamp(monkeypatch) -> None:
    from app.settings import Settings

    monkeypatch.delenv("QLEVER_CONCURRENCY", raising=False)
    assert Settings.from_env().qlever_concurrency == 4
    monkeypatch.setenv("QLEVER_CONCURRENCY", "7")
    assert Settings.from_env().qlever_concurrency == 7
    monkeypatch.setenv("QLEVER_CONCURRENCY", "0")
    assert Settings.from_env().qlever_concurrency == 1
