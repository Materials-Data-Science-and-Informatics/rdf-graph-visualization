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

# Wire key sets of the frozen contract models (FastAPI serializes every
# field, nulls included — so the client sees exactly these keys).
CENTER = "https://doi.org/10.1234/dataset123"
TYPE_DATASET = "https://schema.org/Dataset"
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


# -- /api/search -----------------------------------------------------------------


def test_search_wire_shape_is_frozen_contract(mock_qlever, client) -> None:
    mock_qlever["responses"] = [
        sparql_response(
            {
                "node": uri(CENTER),
                "nodeType": uri(TYPE_DATASET),
                "lbl": uri("https://schema.org/name"),
                "label": lit("Dataset name"),
            }
        )
    ]
    resp = client.get("/api/search?q=data")
    assert resp.status_code == 200
    body = resp.json()
    assert_exact_keys(body, set(contract.SearchResponse.model_fields), "search")
    assert_validates(body, contract.SearchResponse)
    assert body["results"]
    for hit in body["results"]:
        assert_exact_keys(hit, set(contract.SearchResult.model_fields), "search[]")


# -- error dialect -----------------------------------------------------------------
# The frontend client codes on ``{"detail": str}`` bodies; pin the dialect.


def test_429_error_dialect_is_detail_plus_integer_retry_after(
    mock_qlever, client
) -> None:
    mock_qlever["responses"] = [httpx.Response(429, headers={"Retry-After": "20"})]
    resp = client.get("/api/search?q=abc")
    assert resp.status_code == 429
    assert_exact_keys(resp.json(), {"detail"}, "429 body")
    assert resp.headers["retry-after"].isdigit()


def test_5xx_maps_to_502_detail_dialect(mock_qlever, client) -> None:
    mock_qlever["responses"] = [httpx.Response(500, text="boom")]
    resp = client.get("/api/search?q=abc")
    assert resp.status_code == 502
    assert_exact_keys(resp.json(), {"detail"}, "502 body")
