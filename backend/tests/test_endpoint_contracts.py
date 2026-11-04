# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Wire-level API contract tests (card B8).

The endpoint test files assert behaviour; this file pins the *wire shape*:
every 200 body must (a) validate against the frozen ``app.contract`` model
and (b) carry exactly the contract's keys — no extra server fields, no
omitted ones. Together with tests/test_contract.py (pydantic <-> TS field
drift) this is the guard that keeps the backend honest to the frozen F3
contract.

All QLever traffic is scripted via ``httpx.MockTransport`` — no network.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app import contract, qlever
from app.main import app
from app.qlever import QleverClient

DEV_URL = "https://sparql.unhide.helmholtz-metadaten.de/sparql"
CENTER = "https://doi.org/10.1234/dataset123"
NEIGHBOR = "https://orcid.org/0000-0001-2345-6789"
PRED_AUTHOR = "https://schema.org/author"
RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
TYPE_DATASET = "https://schema.org/Dataset"
TYPE_PERSON = "https://schema.org/Person"

# Wire key sets of the frozen contract models (FastAPI serializes every
# field, nulls included — so the client sees exactly these keys).
NODE_KEYS = {"id", "label", "type", "group", "purl"}
EDGE_KEYS = {"id", "source", "target", "predicate", "label"}
PAGE_KEYS = {"cursor", "limit", "truncated"}
HEALTH_KEYS = {"status", "qlever_url", "default_limit", "max_limit"}


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


def uri(value: str) -> dict[str, str]:
    return {"type": "uri", "value": value}


def lit(value: str) -> dict[str, str]:
    return {"type": "literal", "value": value}


def sparql_response(*rows: dict[str, Any]) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "head": {"vars": sorted({k for row in rows for k in row})},
            "results": {"bindings": list(rows)},
        },
    )


def assert_exact_keys(obj: dict[str, Any], keys: set[str], where: str) -> None:
    assert set(obj.keys()) == keys, (
        f"{where}: keys {sorted(obj.keys())} != {sorted(keys)}"
    )


def assert_validates(body: Any, model: type[BaseModel]) -> None:
    model.model_validate(body)  # raises ValidationError on drift


# -- /api/health ----------------------------------------------------------------


def test_health_wire_shape(client) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert_exact_keys(resp.json(), HEALTH_KEYS, "health")


# -- /api/config ----------------------------------------------------------------


def test_config_wire_shape(client) -> None:
    resp = client.get("/api/config")
    assert resp.status_code == 200
    body = resp.json()
    assert_exact_keys(body, set(contract.ConfigResponse.model_fields), "config")
    assert_validates(body, contract.ConfigResponse)
    for preset in body["types"]:
        assert_exact_keys(
            preset, set(contract.ConfigTypePreset.model_fields), "config.types[]"
        )


# -- /api/subgraph ----------------------------------------------------------------


def test_subgraph_wire_shape_is_frozen_contract(mock_qlever, client) -> None:
    mock_qlever["responses"] = [
        sparql_response(
            {
                "kind": lit("node"),
                "node": uri(CENTER),
                "nodeType": uri(TYPE_DATASET),
                "label": lit("Dataset 1234"),
            },
            {
                "kind": lit("edge"),
                "node": uri(CENTER),
                "other": uri(NEIGHBOR),
                "nodeType": uri(TYPE_DATASET),
                "otherType": uri(TYPE_PERSON),
                "pred": uri(PRED_AUTHOR),
            },
        )
    ]
    resp = client.get("/api/subgraph")
    assert resp.status_code == 200
    body = resp.json()

    assert_exact_keys(body, set(contract.SubgraphResponse.model_fields), "subgraph")
    assert_validates(body, contract.SubgraphResponse)
    for node in body["nodes"]:
        assert_exact_keys(node, NODE_KEYS, "subgraph.nodes[]")
        assert node["type"] == node["group"]  # vocabulary-agnostic invariant
    for edge in body["edges"]:
        assert_exact_keys(edge, EDGE_KEYS, "subgraph.edges[]")
    assert_exact_keys(body["page"], PAGE_KEYS, "subgraph.page")


# -- /api/expand/{iri} -------------------------------------------------------------


def test_expand_wire_shape_is_frozen_contract(mock_qlever, client) -> None:
    mock_qlever["responses"] = [
        sparql_response(
            {
                "kind": lit("node"),
                "node": uri(CENTER),
                "nodeType": uri(TYPE_DATASET),
                "label": lit("Dataset 1234"),
            },
            {
                "kind": lit("edge"),
                "dir": lit("out"),
                "node": uri(NEIGHBOR),
                "nodeType": uri(TYPE_PERSON),
                "label": lit("Ann"),
                "pred": lit(PRED_AUTHOR),
            },
        )
    ]
    resp = client.get(f"/api/expand/{CENTER}")
    assert resp.status_code == 200
    body = resp.json()

    assert_exact_keys(body, set(contract.SubgraphResponse.model_fields), "expand")
    assert_validates(body, contract.SubgraphResponse)
    for node in body["nodes"]:
        assert_exact_keys(node, NODE_KEYS, "expand.nodes[]")
    for edge in body["edges"]:
        assert_exact_keys(edge, EDGE_KEYS, "expand.edges[]")
    assert body["nodes"][0]["id"] == CENTER  # center first (contract invariant)
    assert_exact_keys(body["page"], PAGE_KEYS, "expand.page")


# -- /api/entity/{iri} --------------------------------------------------------------


def test_entity_wire_shape_is_frozen_contract(mock_qlever, client) -> None:
    mock_qlever["responses"] = [
        sparql_response(
            {"pred": uri(RDF_TYPE), "obj": uri(TYPE_PERSON)},
            {"pred": uri("https://schema.org/name"), "obj": lit("Ann")},
        )
    ]
    resp = client.get(f"/api/entity/{NEIGHBOR}")
    assert resp.status_code == 200
    body = resp.json()

    assert_exact_keys(body, set(contract.EntityResponse.model_fields), "entity")
    assert_validates(body, contract.EntityResponse)
    assert_exact_keys(body["node"], NODE_KEYS, "entity.node")
    assert body["node"]["type"] == "Person"
    assert body["properties"] == {"https://schema.org/name": ["Ann"]}
    for values in body["properties"].values():
        assert isinstance(values, list) and all(isinstance(v, str) for v in values)


# -- error dialect -----------------------------------------------------------------
# The frontend client codes on ``{"detail": str}`` bodies; pin the dialect.


def test_429_error_dialect_is_detail_plus_integer_retry_after(
    mock_qlever, client
) -> None:
    mock_qlever["responses"] = [httpx.Response(429, headers={"Retry-After": "20"})]
    resp = client.get("/api/subgraph")
    assert resp.status_code == 429
    assert_exact_keys(resp.json(), {"detail"}, "429 body")
    assert resp.headers["retry-after"].isdigit()


def test_5xx_maps_to_502_detail_dialect(mock_qlever, client) -> None:
    mock_qlever["responses"] = [httpx.Response(500, text="boom")]
    resp = client.get("/api/subgraph")
    assert resp.status_code == 502
    assert_exact_keys(resp.json(), {"detail"}, "502 body")
