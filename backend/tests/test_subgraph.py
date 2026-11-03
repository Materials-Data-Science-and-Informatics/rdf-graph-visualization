# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Endpoint tests for GET /api/subgraph (card B3).

DoD coverage:

- LIMIT enforced: the SPARQL query always carries a server-clamped
  ``LIMIT <clamped>+1`` (row budget, never unbounded) and ``page.limit``
  reports the clamped budget;
- cursor round-trip: the cursor of a truncated page, sent back on the next
  call, carries each stream's own offset forward by the rows of THAT
  stream the page consumed (the merged page can be all-edge or all-node) —
  a full traversal walks the canonical streams without gaps, overlaps or
  phantom pages;
- edges+types one call: the single SPARQL call returns node rows (with
  data-model ``type``/``group``) and edge rows together, and every edge's
  endpoints are present in the same slice's ``nodes`` list (the intra-slice
  guarantee the frontend store relies on).

The QLever side is simulated: a fake transport serves deterministic slices
of a canonical, pre-sorted row stream (as the engine's total ORDER BY would
produce) and records the (offset, limit) of every request. Error paths
(429/400/500/connect) replay the recorded fixtures from card B1.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient

from app import qlever, templates
from app.main import app
from app.qlever import QleverClient

DEV_URL = "https://sparql.unhide.helmholtz-metadaten.de/sparql"
FIXTURES = Path(__file__).parent / "fixtures" / "qlever"

PERSON = "https://schema.org/Person"
DATASET = "https://schema.org/Dataset"
CATALOG = "https://schema.org/DataCatalog"
AUTHOR = "https://schema.org/author"
CITATION = "https://schema.org/citation"
IS_PART_OF = "https://schema.org/isPartOf"
AFFILIATION = "https://schema.org/affiliation"
PUB = "https://schema.org/publisher"
INCLUDED = "https://schema.org/includedInDataCatalog"


def _uri(v: str) -> dict:
    return {"type": "uri", "value": v}


def _lit(v: str) -> dict:
    return {"type": "literal", "value": v}


def node_row(iri: str, ntype: str, label: str | None = None) -> dict:
    row: dict = {
        "kind": _lit("node"),
        "node": _uri(iri),
        "other": _lit(""),
        "nodeType": _uri(ntype),
    }
    if label is not None:
        row["label"] = _lit(label)
    return row


def edge_row(src: str, src_type: str, dst: str, dst_type: str, pred: str) -> dict:
    return {
        "kind": _lit("edge"),
        "node": _uri(src),
        "other": _uri(dst),
        "nodeType": _uri(src_type),
        "otherType": _uri(dst_type),
        "pred": _uri(pred),
    }


# -- the canonical row streams ----------------------------------------------------
# Two independent streams the template serves: edge rows (the template's edge
# branch orders them by ?node ?pred ?other ?nodeType ?otherType) and node rows
# (?node ?nodeType ?label). The global order (what the outer ORDER BY yields)
# interleaves them "edge" < "node".
P = "https://x/p"  # person IRIs share a prefix -> IRI order is predictable
D1, D2, D3 = "https://x/d1", "https://x/d2", "https://x/d3"
C1 = "https://x/c1"
P1, P2, P7 = f"{P}1", f"{P}2", f"{P}7"

_STREAM: list[dict] = [
    # dataset self-loop and dataset->dataset edge (d1's rows sort first)
    edge_row(D1, DATASET, D1, DATASET, IS_PART_OF),
    edge_row(D1, DATASET, D2, DATASET, IS_PART_OF),
    # cross-class dataset -> catalog edge
    edge_row(D2, DATASET, C1, CATALOG, INCLUDED),
    # p1's rows: cross-type edge + duplicate pair (second predicate deduped)
    edge_row(P1, PERSON, D1, DATASET, AUTHOR),
    edge_row(P1, PERSON, D1, DATASET, CITATION),
    edge_row(P1, PERSON, P2, PERSON, AUTHOR),
    edge_row(P2, PERSON, P1, PERSON, AFFILIATION),
    # publisher edges whose source node rows are NOT in the stream
    edge_row(f"{P}4", PERSON, D1, DATASET, PUB),
    edge_row(f"{P}5", PERSON, D1, DATASET, PUB),
    edge_row(f"{P}6", PERSON, D2, DATASET, PUB),
    # ...and one more beyond page one
    edge_row(P7, PERSON, D3, DATASET, PUB),
    # node rows (multi-type p2: two rows, first type in sort order wins)
    node_row(C1, CATALOG, "Catalog One"),
    node_row(D1, DATASET, "Data Set One"),
    node_row(D2, DATASET, None),  # no label -> IRI fallback
    node_row(P1, PERSON, "Ann"),
    node_row(P2, DATASET, None),  # p2 also typed Dataset (no label)
    node_row(P2, PERSON, "Bob"),  # real label arrives on the 2nd type row
]


def _sort_key(r: dict) -> tuple[str, ...]:
    """The template's OUTER (global) order over the merged row batches."""
    return (
        r["kind"]["value"],
        r["node"]["value"],
        r["other"].get("value", ""),
        r.get("pred", {}).get("value", ""),
        r.get("nodeType", {}).get("value", ""),
        r.get("otherType", {}).get("value", ""),
        r.get("label", {}).get("value", ""),
    )


def _node_key(r: dict) -> tuple[str, ...]:
    """The node branch's ORDER BY: ?node ?nodeType ?label."""
    return (
        r["node"]["value"],
        r.get("nodeType", {}).get("value", ""),
        r.get("label", {}).get("value", ""),
    )


def _edge_key(r: dict) -> tuple[str, ...]:
    """The edge branch's ORDER BY: ?node ?pred ?other ?nodeType ?otherType."""
    return (
        r["node"]["value"],
        r["pred"]["value"],
        r["other"]["value"],
        r.get("nodeType", {}).get("value", ""),
        r.get("otherType", {}).get("value", ""),
    )


_EDGE_STREAM: list[dict] = sorted(
    (r for r in _STREAM if r["kind"]["value"] == "edge"), key=_edge_key
)
_NODE_STREAM: list[dict] = sorted(
    (r for r in _STREAM if r["kind"]["value"] == "node"), key=_node_key
)


def _assert_pre_sorted() -> None:
    """The global stream must equal the global-order merge of the two
    branch-sorted streams (what the outer ORDER BY yields)."""
    assert sorted(_EDGE_STREAM + _NODE_STREAM, key=_sort_key) == _STREAM


# -- fake QLever transport ------------------------------------------------------


class FakeQlever:
    """Emulates the template's two-branch query: slices each stream at its
    own (probe, offset), merges in the global order, cuts at the outer
    probe. Records (offset_node, offset_edge, probe) and query texts."""

    def __init__(self) -> None:
        self.calls: list[tuple[int, int, int]] = []
        self.queries: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        text = parse_qs(request.content.decode())["query"][0]
        self.queries.append(text)
        # node branch, edge branch, outer — in that textual order
        (probe, off_n), (_, off_e), (outer, _) = (
            (int(a), int(b)) for a, b in re.findall(r"LIMIT (\d+) OFFSET (\d+)", text)
        )
        self.calls.append((off_n, off_e, probe))
        batch = (
            _NODE_STREAM[off_n : off_n + probe] + _EDGE_STREAM[off_e : off_e + probe]
        )
        rows = sorted(batch, key=_sort_key)[:outer]
        return httpx.Response(
            200,
            headers={"Content-Type": "application/sparql-results+json"},
            content=json.dumps(
                {
                    "head": {
                        "vars": [
                            "kind",
                            "node",
                            "other",
                            "nodeType",
                            "otherType",
                            "label",
                            "pred",
                        ]
                    },
                    "results": {"bindings": rows},
                    "meta": {"query-time-ms": 1, "result-size-total": len(rows)},
                }
            ).encode(),
        )


@pytest.fixture()
def fake_client(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("QLEVER_DEFAULT_LIMIT", "500")
    monkeypatch.setenv("QLEVER_MAX_LIMIT", "5000")
    monkeypatch.setenv("QLEVER_URL", DEV_URL)
    fake = FakeQlever()
    qlever.set_client(
        QleverClient(DEV_URL, transport=httpx.MockTransport(fake.handler))
    )
    yield fake
    qlever.reset_client()


@pytest.fixture()
def api():
    return TestClient(app)


def _node(body: dict, iri: str) -> dict:
    for n in body["nodes"]:
        if n["id"] == iri:
            return n
    raise AssertionError(f"node {iri} not in page")


def _edge(body: dict, src: str, dst: str) -> dict:
    for e in body["edges"]:
        if e["source"] == src and e["target"] == dst:
            return e
    raise AssertionError(f"edge {src}->{dst} not in page")


def _assert_intra_slice(body: dict) -> None:
    """Every edge's endpoints must be in the same slice's node list."""
    ids = {n["id"] for n in body["nodes"]}
    assert len(ids) == len(body["nodes"]), "duplicate node ids in one page"
    pairs = {(e["source"], e["target"]) for e in body["edges"]}
    assert len(pairs) == len(body["edges"]), "duplicate (source,target) in one page"
    for e in body["edges"]:
        assert e["source"] in ids and e["target"] in ids


def _walk(api, limit: int) -> list[dict]:
    """Follow cursors until the slice is complete."""
    pages: list[dict] = []
    cursor: str | None = None
    for _ in range(len(_STREAM) + 2):  # hard stop: catches cursor loops
        params: dict[str, object] = {"limit": limit}
        if cursor is not None:
            params["cursor"] = cursor  # omitted on the first page (client contract)
        resp = api.get("/api/subgraph", params=params)
        assert resp.status_code == 200
        body = resp.json()
        pages.append(body)
        _assert_intra_slice(body)
        if not body["page"]["truncated"]:
            return pages
        assert body["page"]["cursor"] is not None
        cursor = body["page"]["cursor"]
    raise AssertionError("cursor walk did not terminate")


# -- cursor round-trip (DoD) ----------------------------------------------------


def test_cursor_round_trip_walks_stream_without_gaps_or_overlaps(api, fake_client):
    fake = fake_client
    _assert_pre_sorted()
    limit = 10
    pages = _walk(api, limit)

    # 17 rows at limit=10 -> exactly two pages: 10 served + 7 served
    assert len(pages) == 2
    assert [p["page"]["truncated"] for p in pages] == [True, False]
    assert pages[1]["page"]["cursor"] is None
    for p in pages:
        assert p["page"]["limit"] == limit
    # the cursor round-trips into the exact next per-stream offsets: the
    # first page is all edges, so only the edge stream advances (0 -> 10);
    # every request queried limit+1 rows per branch (truncation probe)
    assert fake.calls == [(0, 0, limit + 1), (0, limit, limit + 1)]


def test_cursor_values_are_opaque_offsets(api, fake_client):
    fake = fake_client
    body1 = api.get("/api/subgraph", params={"limit": 10}).json()
    assert body1["page"]["truncated"] is True
    c1 = body1["page"]["cursor"]
    assert c1 is not None
    # opaque, decodes to the per-stream next offsets (edge stream advanced
    # by the 10 edge rows of page one; node stream untouched)
    assert templates.decode_subgraph_cursor(c1) == (0, 10)

    body2 = api.get("/api/subgraph", params={"limit": 10, "cursor": c1}).json()
    assert body2["page"]["truncated"] is False
    assert body2["page"]["cursor"] is None

    assert fake.calls == [(0, 0, 11), (0, 10, 11)]
    # page one: 10 edge rows -> 9 unique pairs + 8 synthesized endpoint nodes
    assert len(body1["edges"]) == 9
    assert len(body1["nodes"]) == 8
    # page two: 1 edge row (p7->d3) + 6 node rows -> 7 nodes, 1 edge
    assert len(body2["edges"]) == 1
    assert len(body2["nodes"]) == 7


def test_each_row_is_served_by_exactly_one_page(api, fake_client):
    _assert_pre_sorted()
    body1 = api.get("/api/subgraph", params={"limit": 10}).json()
    body2 = _walk(api, 10)[1]

    # rows 0-1 (d1's edges) belong to page one only
    assert _edge(body1, D1, D1)["predicate"] == IS_PART_OF
    assert _edge(body1, D1, D2)["predicate"] == IS_PART_OF
    # row 10 (p7->d3) belongs to page two only
    assert body2["edges"] == [_expected_edge(P7, PERSON, D3, DATASET, PUB)]
    assert all(e["source"] != D1 for e in body2["edges"])
    # row 12 (d1's node row) belongs to page two only: page one only knows
    # d1 as an edge endpoint (placeholder), page two upgrades it
    assert _node(body1, D1)["label"] == D1  # placeholder: label = IRI
    d1p2 = _node(body2, D1)
    assert d1p2["label"] == "Data Set One"  # real node row
    assert d1p2["type"] == "Dataset" and d1p2["group"] == "Dataset"
    # same for p1: placeholder on page one, real label on page two
    assert _node(body1, P1)["label"] == P1
    assert _node(body2, P1)["label"] == "Ann"
    # page two's node fold order: node rows in sort order, then synthesized
    assert [n["id"] for n in body2["nodes"]] == [C1, D1, D2, P1, P2, P7, D3]


def _expected_edge(src, src_type, dst, dst_type, pred) -> dict:
    return {
        "id": f"{src}|{pred}|{dst}",
        "source": src,
        "target": dst,
        "predicate": pred,
        "label": pred.rsplit("/", 1)[-1],
    }


def test_exact_multiple_of_limit_has_no_phantom_page(api, fake_client):
    # 17 rows, limit=7 -> 7/7/3, last page NOT truncated, no fourth page
    pages = _walk(api, 7)
    assert len(pages) == 3
    assert [p["page"]["truncated"] for p in pages] == [True, True, False]


def test_last_page_shorter_than_limit_is_not_truncated(api, fake_client):
    pages = _walk(api, 10)
    last = pages[-1]
    assert len(last["nodes"]) + len(last["edges"]) < 10
    assert last["page"]["truncated"] is False


# -- LIMIT enforcement (DoD) -----------------------------------------------------


def test_limit_is_clamped_to_max(api, fake_client):
    fake = fake_client
    resp = api.get("/api/subgraph", params={"limit": 10**9})
    assert resp.status_code == 200
    assert resp.json()["page"]["limit"] == 5000  # QLEVER_MAX_LIMIT
    assert fake.calls[0] == (0, 0, 5001)  # server queried clamped+1 per branch


def test_limit_defaults_to_default_limit(api, fake_client):
    fake = fake_client
    resp = api.get("/api/subgraph")
    assert resp.status_code == 200
    assert resp.json()["page"]["limit"] == 500
    assert fake.calls[0] == (0, 0, 501)


@pytest.mark.parametrize("raw", [0, -5, 1])
def test_tiny_and_negative_limits_clamp_to_one(api, fake_client, raw):
    fake = fake_client
    resp = api.get("/api/subgraph", params={"limit": raw})
    assert resp.status_code == 200
    assert resp.json()["page"]["limit"] == 1
    assert fake.calls[0] == (0, 0, 2)


def test_non_integer_limit_rejected(api):
    resp = api.get("/api/subgraph", params={"limit": "abc"})
    assert resp.status_code == 422


def test_limit_of_one_serves_exactly_one_row(api, fake_client):
    body = api.get("/api/subgraph", params={"limit": 1}).json()
    # the first canonical row is the d1 self-loop edge row
    assert len(body["edges"]) == 1
    assert body["edges"][0]["source"] == D1
    _assert_intra_slice(body)
    assert body["page"]["truncated"] is True


# -- type filter + one-call shape (DoD: edges+types one call) --------------------


def test_default_call_selects_all_eight_classes(api, fake_client):
    fake = fake_client
    api.get("/api/subgraph")
    text = fake.queries[-1]
    for cls in (
        "DataCatalog",
        "Dataset",
        "Document",
        "Event",
        "Institution",
        "Instrument",
        "Software",
        "Person",
    ):
        assert f"<https://schema.org/{cls}>" in text


def test_type_filter_restricts_values(api, fake_client):
    fake = fake_client
    resp = api.get("/api/subgraph", params={"type": "Person"})
    assert resp.status_code == 200
    text = fake.queries[-1]
    m = re.search(r"VALUES \?nodeType \{ (.*?) \}", text, re.DOTALL)
    assert m is not None
    assert m.group(1).strip() == "<https://schema.org/Person>"


def test_unknown_type_is_not_filterable(api):
    resp = api.get("/api/subgraph", params={"type": "Unknown"})
    assert resp.status_code == 422


def test_invalid_type_rejected(api):
    resp = api.get("/api/subgraph", params={"type": "Bogus"})
    assert resp.status_code == 422


def test_single_call_returns_nodes_with_types_and_edges(api, fake_client):
    # one page big enough for the whole canonical stream: everything below
    # comes from a SINGLE HTTP (and SPARQL) call
    resp = api.get("/api/subgraph", params={"limit": 25})
    assert resp.status_code == 200
    body = resp.json()
    assert body["page"]["truncated"] is False
    assert "nodes" in body and "edges" in body  # one call, both sets
    # nodes carry the contract type/group
    assert _node(body, P1)["type"] == "Person"
    assert _node(body, P1)["group"] == "Person"
    assert _node(body, P1)["label"] == "Ann"
    assert _node(body, C1)["type"] == "DataCatalog"
    assert _node(body, C1)["label"] == "Catalog One"
    # cross-type edge (Person -> Dataset) with predicate local-name label
    e = _edge(body, P1, D1)
    assert e["predicate"] == AUTHOR
    assert e["label"] == "author"
    assert e["id"] == f"{P1}|{AUTHOR}|{D1}"
    # duplicate (src,dst) pair folded to the first predicate in sort order
    same = [x for x in body["edges"] if x["source"] == P1 and x["target"] == D1]
    assert len(same) == 1 and same[0]["predicate"] == AUTHOR
    # dataset self-loop kept, endpoints present
    assert _edge(body, D1, D1)["predicate"] == IS_PART_OF
    # cross-class dataset -> catalog edge
    assert _edge(body, D2, C1)["predicate"] == INCLUDED
    # label-less node falls back to its IRI
    assert _node(body, D2)["label"] == D2
    # endpoint whose node row is outside the slice gets a placeholder node
    assert _node(body, f"{P}4")["label"] == f"{P}4"
    assert _node(body, f"{P}4")["type"] == "Person"
    assert _node(body, D3)["label"] == D3


def test_multi_type_node_folds_deterministically(api, fake_client):
    body = api.get("/api/subgraph", params={"limit": 25}).json()
    p2 = _node(body, P2)
    # first type in sort order wins: Dataset < Person
    assert p2["type"] == "Dataset"
    assert p2["group"] == "Dataset"
    # the real label from the later type row upgrades the IRI fallback
    assert p2["label"] == "Bob"


def test_fold_is_deterministic_across_traversals(api, fake_client):
    assert _walk(api, 6) == _walk(api, 6)


# -- invalid cursors --------------------------------------------------------------


@pytest.mark.parametrize(
    "bad",
    [
        "",  # empty string is not a cursor we ever issued
        "!!!not-base64!!!",
        "Y29uc3RhbnQ=",  # valid base64, not a cursor payload
        templates.encode_cursor(10)[:-2] + "==",
    ],
)
def test_invalid_cursor_rejected(api, fake_client, bad):
    resp = api.get("/api/subgraph", params={"cursor": bad})
    assert resp.status_code == 422


# -- QLever error mapping (never retried) ------------------------------------------


def _recorded(name: str) -> httpx.Response:
    status = 200
    headers: dict[str, str] = {}
    with (FIXTURES / f"{name}.headers").open(encoding="latin-1") as fh:
        for line in fh:
            line = line.strip()
            if line.startswith("HTTP/"):
                status = int(line.split()[1])
            elif ":" in line:
                key, _, val = line.partition(":")
                headers[key.strip().lower()] = val.strip()
    body = (FIXTURES / f"{name}.body").read_bytes()
    return httpx.Response(status, headers=headers, content=body)


@pytest.fixture()
def replaying_client(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("QLEVER_DEFAULT_LIMIT", "500")
    monkeypatch.setenv("QLEVER_MAX_LIMIT", "5000")

    def make(handler: Callable[[httpx.Request], httpx.Response]) -> list[httpx.Request]:
        calls: list[httpx.Request] = []

        def rec(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return handler(request)

        qlever.set_client(QleverClient(DEV_URL, transport=httpx.MockTransport(rec)))
        return calls

    yield make
    qlever.reset_client()


def test_429_maps_to_429_with_retry_after_and_no_retry(api, replaying_client):
    calls = replaying_client(lambda r: _recorded("rate_limited_429"))
    resp = api.get("/api/subgraph", params={"limit": 5})
    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "120"
    assert "wait" in resp.json()["detail"]
    assert len(calls) == 1  # never blind-retries a 429


def test_400_parser_error_maps_to_400(api, replaying_client):
    replaying_client(lambda r: _recorded("select_parse_error_400"))
    resp = api.get("/api/subgraph", params={"limit": 5})
    assert resp.status_code == 400
    assert "Invalid SPARQL query" in resp.json()["detail"]


def test_500_maps_to_502(api, replaying_client):
    replaying_client(lambda r: _recorded("server_error_500"))
    resp = api.get("/api/subgraph", params={"limit": 5})
    assert resp.status_code == 502


def test_connect_error_maps_to_503(api, replaying_client):
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    replaying_client(handler)
    resp = api.get("/api/subgraph", params={"limit": 5})
    assert resp.status_code == 503


# -- pure helpers -------------------------------------------------------------------


def test_node_type_mapping():
    from app import subgraph

    assert subgraph._node_type(PERSON) == "Person"
    assert subgraph._node_type("https://schema.org/Organization") == "Unknown"
    assert subgraph._node_type(None) == "Unknown"
    assert subgraph._node_type("http://other.example/T") == "Unknown"
    assert subgraph._type_iris("Person") == [PERSON]
    assert len(subgraph._type_iris(None)) == 8
    with pytest.raises(ValueError):
        subgraph._type_iris("Unknown")


def test_local_name():
    from app import subgraph

    assert subgraph._local_name("https://schema.org/author") == "author"
    assert subgraph._local_name("http://x/y#partOf") == "partOf"
    assert subgraph._local_name("opaque") == "opaque"
