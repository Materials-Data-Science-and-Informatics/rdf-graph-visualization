# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Endpoint tests for GET /api/aggregate (card B4).

All QLever traffic is replayed through ``httpx.MockTransport`` — no
network. Coverage: the per-class fold (exact ``schema.org`` match, unknown
IRIs summed into one ``Unknown`` bucket, deterministic count-descending
order with name tie-break, malformed rows skipped), the query shape
(ungrouped COUNT, GROUP BY, no LIMIT), and the error dialect
(429 + server-declared Retry-After, 429 no-header floor, 400 parser, 500,
non-JSON 200, connect error -> 503).
"""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient

from app import aggregate, qlever, templates
from app.main import app
from app.qlever import QleverClient

DEV_URL = "https://sparql.unhide.helmholtz-metadaten.de/sparql"
RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
TYPE_PERSON = "https://schema.org/Person"
TYPE_DATASET = "https://schema.org/Dataset"
TYPE_CATALOG = "https://schema.org/DataCatalog"
TYPE_THING = "https://schema.org/Thing"  # not a pinned class -> Unknown
TYPE_FOAF = "http://xmlns.com/foaf/0.1#Agent"  # outside schema.org -> Unknown


def _uri(v: str) -> dict[str, str]:
    return {"type": "uri", "value": v}


def _lit(
    v: str, datatype: str = "http://www.w3.org/2001/XMLSchema#integer"
) -> dict[str, str]:
    return {"type": "literal", "value": v, "datatype": datatype}


def _count_row(type_iri: str, count: str | int) -> dict[str, Any]:
    return {"type": _uri(type_iri), "count": _lit(str(count))}


def sparql_response(*rows: dict[str, Any]) -> httpx.Response:
    """Build a sparql-results+json body from raw binding dicts."""
    return httpx.Response(
        200,
        json={
            "head": {
                "vars": sorted({k for row in rows for k in row}) or ["type", "count"]
            },
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


# -- query shape ----------------------------------------------------------------


def test_sends_the_unbounded_count_query(mock_qlever, client):
    mock_qlever["responses"] = [sparql_response()]
    client.get("/api/aggregate")
    q = sent_query(mock_qlever["requests"][0])
    assert templates.aggregate_query() == q
    assert "COUNT(?s)" in q
    assert "GROUP BY ?type" in q
    assert "LIMIT" not in q


# -- fold -------------------------------------------------------------------------


def test_folds_known_classes_with_counts(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            _count_row(TYPE_PERSON, 33_200_000),
            _count_row(TYPE_DATASET, 412_000),
            _count_row(TYPE_CATALOG, 9_400),
        )
    ]
    resp = client.get("/api/aggregate")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "nodes": [
            {"group": "Person", "type": "Person", "count": 33_200_000},
            {"group": "Dataset", "type": "Dataset", "count": 412_000},
            {"group": "DataCatalog", "type": "DataCatalog", "count": 9_400},
        ]
    }


def test_unknown_type_iris_sum_into_one_unknown_bucket(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            _count_row(TYPE_PERSON, 100),
            _count_row(TYPE_THING, 40),
            _count_row(TYPE_FOAF, 25),
            _count_row(TYPE_DATASET, 15),
        )
    ]
    body = client.get("/api/aggregate").json()
    assert body["nodes"] == [
        {"group": "Person", "type": "Person", "count": 100},
        {"group": "Unknown", "type": "Unknown", "count": 65},
        {"group": "Dataset", "type": "Dataset", "count": 15},
    ]


def test_equal_counts_break_tie_by_group_name(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            _count_row(TYPE_PERSON, 7),
            _count_row(TYPE_DATASET, 7),
        )
    ]
    body = client.get("/api/aggregate").json()
    assert [n["group"] for n in body["nodes"]] == ["Dataset", "Person"]


def test_empty_result_is_empty_nodes(mock_qlever, client):
    mock_qlever["responses"] = [sparql_response()]
    resp = client.get("/api/aggregate")
    assert resp.status_code == 200
    assert resp.json() == {"nodes": []}


def test_malformed_rows_are_skipped_not_served(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            _count_row(TYPE_PERSON, "abc"),  # non-integer count
            _count_row(TYPE_DATASET, "-3"),  # negative count
            {"type": _lit("not-a-uri"), "count": _lit("5")},  # literal type
            {"type": _uri(TYPE_CATALOG)},  # missing count
            _count_row("", 9),  # empty type IRI
            _count_row(TYPE_PERSON, 3),
        )
    ]
    body = client.get("/api/aggregate").json()
    assert body["nodes"] == [{"group": "Person", "type": "Person", "count": 3}]


# -- error dialect -----------------------------------------------------------------


def test_429_surfaces_server_retry_after(mock_qlever, client):
    mock_qlever["responses"] = [httpx.Response(429, headers={"retry-after": "300"})]
    resp = client.get("/api/aggregate")
    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "300"


def test_429_without_header_uses_ladder_floor(mock_qlever, client):
    mock_qlever["responses"] = [httpx.Response(429)]
    resp = client.get("/api/aggregate")
    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "60"


def test_400_parser_error_maps_to_400(mock_qlever, client):
    mock_qlever["responses"] = [
        httpx.Response(400, json={"exception": "syntax error at line 2"})
    ]
    resp = client.get("/api/aggregate")
    assert resp.status_code == 400
    assert "syntax error" in resp.json()["detail"]


def test_500_maps_to_502(mock_qlever, client):
    mock_qlever["responses"] = [httpx.Response(500, json={"exception": "boom"})]
    resp = client.get("/api/aggregate")
    assert resp.status_code == 502


def test_non_json_200_maps_to_502(mock_qlever, client):
    mock_qlever["responses"] = [httpx.Response(200, content=b"<html>nope</html>")]
    resp = client.get("/api/aggregate")
    assert resp.status_code == 502


def test_connect_error_maps_to_503():
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    client = QleverClient(DEV_URL, transport=httpx.MockTransport(handler))
    qlever.set_client(client)
    try:
        resp = TestClient(app, raise_server_exceptions=False).get("/api/aggregate")
    finally:
        qlever.reset_client()
    assert resp.status_code == 503


# -- IRI -> class mapping ------------------------------------------------------------


def test_group_of_maps_exact_known_classes_only():
    assert aggregate._group_of(TYPE_PERSON) == "Person"
    assert aggregate._group_of(TYPE_CATALOG) == "DataCatalog"
    assert aggregate._group_of(TYPE_THING) == "Unknown"
    assert aggregate._group_of(TYPE_FOAF) == "Unknown"
    assert (
        aggregate._group_of("https://schema.org/pErson") == "Unknown"
    )  # exact match only
