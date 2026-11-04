# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Endpoint tests for GET /api/search (card B5).

All QLever traffic is replayed through ``httpx.MockTransport`` — no
network. Coverage: the query shape (case-insensitive prefix regex, the
pinned label IRIs, ``LIMIT 20``, ``ORDER BY ?label``, the ``?lbl``
projection; metacharacters in ``q`` escaped as data, not pattern), the
order-independent fold (B2's primary-type rule for multiply-typed nodes,
label-property priority with alphabetical tie-break, malformed rows
skipped, ``(label, id)`` ordering, 20-hit cap), input validation
(missing/empty/whitespace/overlong ``q`` -> 422 with no QLever traffic),
and the error dialect (429 + server-declared Retry-After, 429 no-header
floor, 400 parser, 500, non-JSON 200, connect error -> 503).
"""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient

from app import presets, qlever, templates
from app.main import app
from app.qlever import QleverClient

DEV_URL = "https://sparql.unhide.helmholtz-metadaten.de/sparql"
TYPE_PERSON = "https://schema.org/Person"
TYPE_DATASET = "https://schema.org/Dataset"
TYPE_THING = "https://schema.org/Thing"  # not a pinned class -> Unknown
TYPE_FOAF = "http://xmlns.com/foaf/0.1#Agent"  # outside schema.org -> Unknown
PREFNAME = "https://schema.org/prefName"
NAME = "https://schema.org/name"
IDENTIFIER = "https://schema.org/identifier"
NODE_A = "https://purl.org/hkg/entity/a"
NODE_B = "https://purl.org/hkg/entity/b"
NODE_C = "https://purl.org/hkg/entity/c"
NODE_D = "https://purl.org/hkg/entity/d"


def _uri(v: str) -> dict[str, str]:
    return {"type": "uri", "value": v}


def _lit(v: str) -> dict[str, str]:
    return {"type": "literal", "value": v}


def _bnode(v: str) -> dict[str, str]:
    return {"type": "bnode", "value": v}


def _hit_row(
    node: str, type_iri: str | None, label: str | None, lbl: str = NAME
) -> dict[str, Any]:
    row: dict[str, Any] = {"node": _uri(node)}
    if type_iri is not None:
        row["nodeType"] = _uri(type_iri)
    row["lbl"] = _uri(lbl)
    if label is not None:
        row["label"] = _lit(label)
    return row


def sparql_response(*rows: dict[str, Any]) -> httpx.Response:
    """Build a sparql-results+json body from raw binding dicts."""
    return httpx.Response(
        200,
        json={
            "head": {"vars": ["node", "nodeType", "label", "lbl"]},
            "results": {"bindings": list(rows)},
        },
    )


def sent_query(request: httpx.Request) -> str:
    """The SPARQL text of a recorded POST (form field ``query``)."""
    return parse_qs(request.content.decode())["query"][0]


@pytest.fixture()
def mock_qlever():
    """Install a QleverClient whose transport yields scripted responses."""
    state: dict[str, Any] = {"responses": [], "requests": []}

    def handler(request: httpx.Request) -> httpx.Response:
        state["requests"].append(request)
        return state["responses"].pop(0)

    client = QleverClient(DEV_URL, transport=httpx.MockTransport(handler))
    qlever.set_client(client)
    yield state
    qlever.reset_client()


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


# -- query shape -----------------------------------------------------------------


def test_sends_the_prefix_search_query(mock_qlever, client):
    mock_qlever["responses"] = [sparql_response()]
    client.get("/api/search", params={"q": "hel"})
    q = sent_query(mock_qlever["requests"][0])
    assert q == templates.search_query(
        text="hel",
        label_iris=presets.build_config().label_properties,
        limit=templates.DEFAULT_SEARCH_LIMIT,
    )
    assert 'regex(str(?label), "^hel", "i")' in q
    assert "LIMIT 20" in q
    assert "ORDER BY ?label" in q


def test_query_uses_the_pinned_label_properties(mock_qlever, client):
    mock_qlever["responses"] = [sparql_response()]
    client.get("/api/search", params={"q": "x"})
    q = sent_query(mock_qlever["requests"][0])
    assert "SELECT ?node ?nodeType ?label ?lbl" in q
    for prop in ("prefName", "name", "identifier"):
        assert f"<https://schema.org/{prop}>" in q


def test_metacharacters_are_escaped_data_not_pattern(mock_qlever, client):
    mock_qlever["responses"] = [sparql_response()]
    client.get("/api/search", params={"q": "a.b*c"})
    q = sent_query(mock_qlever["requests"][0])
    assert '"^a\\.b\\*c"' in q  # ^ anchor, backslash-escaped . and *
    assert "a.b*c" not in q  # the raw metacharacters never reach the pattern


def test_query_text_is_trimmed_but_echoed_verbatim(mock_qlever, client):
    mock_qlever["responses"] = [sparql_response()]
    resp = client.get("/api/search", params={"q": "  hel  "})
    assert resp.status_code == 200
    assert 'regex(str(?label), "^hel", "i")' in sent_query(mock_qlever["requests"][0])
    assert resp.json()["query"] == "  hel  "


# -- fold --------------------------------------------------------------------------


def test_folds_rows_into_hits(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            _hit_row(NODE_A, TYPE_PERSON, "Alpha Doe"),
            _hit_row(NODE_B, TYPE_DATASET, "Beta Survey"),
        )
    ]
    resp = client.get("/api/search", params={"q": "a"})
    assert resp.status_code == 200
    assert resp.json() == {
        "query": "a",
        "results": [
            {"id": NODE_A, "label": "Alpha Doe", "type": "Person"},
            {"id": NODE_B, "label": "Beta Survey", "type": "Dataset"},
        ],
    }


def test_unknown_and_missing_types_map_to_unknown(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            _hit_row(NODE_A, TYPE_THING, "T"),
            _hit_row(NODE_B, TYPE_FOAF, "F"),
            {"node": _uri(NODE_C), "label": _lit("M")},  # missing nodeType
            {
                "node": _uri(NODE_D),
                "nodeType": _lit("not-a-uri"),
                "label": _lit("L"),
            },
        )
    ]
    body = client.get("/api/search", params={"q": "x"}).json()
    assert [(r["id"], r["label"]) for r in body["results"]] == [
        (NODE_B, "F"),
        (NODE_D, "L"),
        (NODE_C, "M"),
        (NODE_A, "T"),
    ]
    assert all(r["type"] == "Unknown" for r in body["results"])


def test_label_property_priority_beats_alphabetical_order(mock_qlever, client):
    # prefName "Zeta" must beat name "Alpha" even though "Alpha" < "Zeta".
    mock_qlever["responses"] = [
        sparql_response(
            _hit_row(NODE_A, TYPE_PERSON, "Alpha", NAME),
            _hit_row(NODE_A, TYPE_PERSON, "Zeta", PREFNAME),
        )
    ]
    body = client.get("/api/search", params={"q": "z"}).json()
    assert body["results"] == [{"id": NODE_A, "label": "Zeta", "type": "Person"}]


def test_same_property_tie_keeps_alphabetical_first(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            _hit_row(NODE_A, TYPE_PERSON, "Beta", NAME),
            _hit_row(NODE_A, TYPE_PERSON, "Alpha", NAME),
        )
    ]
    body = client.get("/api/search", params={"q": "a"}).json()
    assert body["results"] == [{"id": NODE_A, "label": "Alpha", "type": "Person"}]


def test_identifier_row_falls_below_name_row(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            _hit_row(NODE_A, TYPE_PERSON, "Aaa", IDENTIFIER),
            _hit_row(NODE_A, TYPE_PERSON, "Zzz", NAME),
        )
    ]
    body = client.get("/api/search", params={"q": "z"}).json()
    assert body["results"] == [{"id": NODE_A, "label": "Zzz", "type": "Person"}]


def test_multiply_typed_node_uses_primary_type_rule(mock_qlever, client):
    # Thing row first in engine order; Person is still the primary type.
    mock_qlever["responses"] = [
        sparql_response(
            _hit_row(NODE_A, TYPE_THING, "Forschung"),
            _hit_row(NODE_A, TYPE_PERSON, "Forschung"),
        )
    ]
    body = client.get("/api/search", params={"q": "fo"}).json()
    assert body["results"] == [{"id": NODE_A, "label": "Forschung", "type": "Person"}]


def test_known_types_resolve_in_contract_order(mock_qlever, client):
    # Dataset precedes Person in the contract declaration order.
    mock_qlever["responses"] = [
        sparql_response(
            _hit_row(NODE_A, TYPE_PERSON, "P"),
            _hit_row(NODE_A, TYPE_DATASET, "D"),
        )
    ]
    body = client.get("/api/search", params={"q": "d"}).json()
    assert body["results"] == [{"id": NODE_A, "label": "D", "type": "Dataset"}]


def test_fold_is_order_independent(mock_qlever, client):
    rows = [
        _hit_row(NODE_A, TYPE_PERSON, "Zeta", PREFNAME),
        _hit_row(NODE_A, TYPE_THING, "Alpha", NAME),
        _hit_row(NODE_B, TYPE_DATASET, "Mid"),
    ]
    mock_qlever["responses"] = [
        sparql_response(*rows),
        sparql_response(*reversed(rows)),
    ]
    r1 = client.get("/api/search", params={"q": "x"}).json()
    r2 = client.get("/api/search", params={"q": "y"}).json()
    assert r1["results"] == r2["results"]
    assert r1["results"] == [
        {"id": NODE_B, "label": "Mid", "type": "Dataset"},
        {"id": NODE_A, "label": "Zeta", "type": "Person"},
    ]


def test_malformed_rows_are_skipped_not_served(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            {
                "node": _lit("not-a-uri"),
                "nodeType": _uri(TYPE_PERSON),
                "label": _lit("L"),
            },
            {"node": _uri(""), "nodeType": _uri(TYPE_PERSON), "label": _lit("L")},
            {"node": _uri(NODE_A), "nodeType": _uri(TYPE_PERSON)},  # no label
            {
                "node": _uri(NODE_A),
                "nodeType": _uri(TYPE_PERSON),
                "label": _bnode("_:b0"),
            },
            {"node": _uri(NODE_B), "nodeType": _uri(TYPE_PERSON), "label": _lit("")},
            _hit_row(NODE_C, TYPE_PERSON, "Valid Row"),
        )
    ]
    body = client.get("/api/search", params={"q": "x"}).json()
    assert body["results"] == [{"id": NODE_C, "label": "Valid Row", "type": "Person"}]


def test_empty_result_is_empty_results(mock_qlever, client):
    mock_qlever["responses"] = [sparql_response()]
    resp = client.get("/api/search", params={"q": "zzzzz"})
    assert resp.status_code == 200
    assert resp.json() == {"query": "zzzzz", "results": []}


def test_results_capped_at_20_hits(mock_qlever, client):
    rows = [
        _hit_row(f"https://purl.org/hkg/entity/n{i}", TYPE_PERSON, f"Label {i:02d}")
        for i in range(25)
    ]
    mock_qlever["responses"] = [sparql_response(*rows)]
    body = client.get("/api/search", params={"q": "label"}).json()
    assert len(body["results"]) == 20
    assert [r["label"] for r in body["results"]][:2] == ["Label 00", "Label 01"]
    assert [r["label"] for r in body["results"]][-1] == "Label 19"


def test_result_order_is_label_then_id(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            _hit_row(NODE_B, TYPE_PERSON, "Tie"),
            _hit_row(NODE_A, TYPE_PERSON, "Tie"),
            _hit_row(NODE_C, TYPE_DATASET, "Aardvark"),
        )
    ]
    body = client.get("/api/search", params={"q": "x"}).json()
    assert [(r["id"], r["label"]) for r in body["results"]] == [
        (NODE_C, "Aardvark"),
        (NODE_A, "Tie"),
        (NODE_B, "Tie"),
    ]


# -- input validation ----------------------------------------------------------------


def test_missing_q_is_422_and_sends_nothing(mock_qlever, client):
    resp = client.get("/api/search")
    assert resp.status_code == 422
    assert mock_qlever["requests"] == []


def test_empty_q_is_422_and_sends_nothing(mock_qlever, client):
    resp = client.get("/api/search", params={"q": ""})
    assert resp.status_code == 422
    assert mock_qlever["requests"] == []


def test_whitespace_only_q_is_422_and_sends_nothing(mock_qlever, client):
    resp = client.get("/api/search", params={"q": "   "})
    assert resp.status_code == 422
    assert mock_qlever["requests"] == []


def test_overlong_q_is_422_and_sends_nothing(mock_qlever, client):
    resp = client.get("/api/search", params={"q": "a" * 201})
    assert resp.status_code == 422
    assert mock_qlever["requests"] == []


# -- error dialect --------------------------------------------------------------------


def test_429_surfaces_server_retry_after(mock_qlever, client):
    mock_qlever["responses"] = [httpx.Response(429, headers={"retry-after": "300"})]
    resp = client.get("/api/search", params={"q": "hel"})
    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "300"


def test_429_without_header_uses_ladder_floor(mock_qlever, client):
    mock_qlever["responses"] = [httpx.Response(429)]
    resp = client.get("/api/search", params={"q": "hel"})
    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "60"


def test_400_parser_error_maps_to_400(mock_qlever, client):
    mock_qlever["responses"] = [
        httpx.Response(400, json={"exception": "syntax error at line 2"})
    ]
    resp = client.get("/api/search", params={"q": "hel"})
    assert resp.status_code == 400
    assert "syntax error" in resp.json()["detail"]


def test_500_maps_to_502(mock_qlever, client):
    mock_qlever["responses"] = [httpx.Response(500, json={"exception": "boom"})]
    resp = client.get("/api/search", params={"q": "hel"})
    assert resp.status_code == 502


def test_non_json_200_maps_to_502(mock_qlever, client):
    mock_qlever["responses"] = [httpx.Response(200, content=b"<html>nope</html>")]
    resp = client.get("/api/search", params={"q": "hel"})
    assert resp.status_code == 502


def test_connect_error_maps_to_503():
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    client = QleverClient(DEV_URL, transport=httpx.MockTransport(handler))
    qlever.set_client(client)
    try:
        resp = TestClient(app, raise_server_exceptions=False).get(
            "/api/search", params={"q": "hel"}
        )
    finally:
        qlever.reset_client()
    assert resp.status_code == 503
