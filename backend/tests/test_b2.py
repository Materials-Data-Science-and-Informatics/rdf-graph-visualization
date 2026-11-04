# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Unit tests for the B2 endpoints: /api/expand/{iri} + /api/entity/{iri}.

All QLever traffic is replayed through ``httpx.MockTransport`` — no network.
Coverage: row folding (directions, dedup, self-loop, unknown types, missing
labels), the limit+1 truncation rule, limit clamping, the IRI->NodeType map,
the F6 validation path (known class, unknown class, no-type fallback,
wrapper-rejection fallback), 404 on an empty entity, and the error dialect
(422 bad IRI, 400 parser, 429 + Retry-After, 502, 503).
"""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs, quote

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import api_b2, qlever, templates
from app.hkg_wrappers import PersonWrapper
from app.main import app
from app.qlever import QleverClient

DEV_URL = "https://sparql.unhide.helmholtz-metadaten.de/sparql"
CENTER = "https://doi.org/10.1234/dataset123"
NEIGHBOR_A = "https://orcid.org/0000-0001-2345-6789"
NEIGHBOR_B = "https://ror.org/0000-0001-2345-6789"
PRED_AUTHOR = "https://schema.org/author"
PRED_PUBLISHER = "https://schema.org/publisher"
RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
TYPE_DATASET = "https://schema.org/Dataset"
TYPE_PERSON = "https://schema.org/Person"
TYPE_ORGANIZATION = "https://schema.org/Organization"  # outside the pinned model


def enc(iri: str) -> str:
    """Path-segment encoding the frontend client uses (encodeURIComponent)."""
    return quote(iri, safe="")


def uri(value: str) -> dict[str, str]:
    return {"type": "uri", "value": value}


def lit(value: str) -> dict[str, str]:
    return {"type": "literal", "value": value}


def sparql_response(*rows: dict[str, Any]) -> httpx.Response:
    """Build a sparql-results+json body from raw binding dicts."""
    return httpx.Response(
        200,
        json={
            "head": {"vars": sorted({k for row in rows for k in row})},
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


def expand_row(
    kind: str,
    node: str,
    direction: str,
    node_type: str | None,
    label: str | None,
    pred: str,
) -> dict[str, Any]:
    row: dict[str, Any] = {"kind": lit(kind), "dir": lit(direction), "node": uri(node)}
    if node_type is not None:
        row["nodeType"] = uri(node_type)
    if label is not None:
        row["label"] = lit(label)
    row["pred"] = lit(pred)
    return row


# -- /api/expand/{iri} ---------------------------------------------------------


def test_expand_folds_center_and_neighbours(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            expand_row("node", CENTER, "", TYPE_DATASET, "A Dataset", ""),
            expand_row("edge", NEIGHBOR_A, "out", TYPE_PERSON, "Ann", PRED_AUTHOR),
            expand_row(
                "edge", NEIGHBOR_B, "in", TYPE_ORGANIZATION, None, PRED_PUBLISHER
            ),
        )
    ]
    resp = client.get(f"/api/expand/{enc(CENTER)}")
    assert resp.status_code == 200
    body = resp.json()
    # center first, then neighbours in row order
    assert [n["id"] for n in body["nodes"]] == [CENTER, NEIGHBOR_A, NEIGHBOR_B]
    assert body["nodes"][0] == {
        "id": CENTER,
        "label": "A Dataset",
        "type": "Dataset",
        "group": "Dataset",
        "purl": None,
    }
    # Organization is an Institution subtype; missing label -> IRI
    assert body["nodes"][2]["type"] == "Institution"
    assert body["nodes"][2]["label"] == NEIGHBOR_B
    # directions: out = center -> neighbour, in = neighbour -> center
    assert [e["source"] for e in body["edges"]] == [CENTER, NEIGHBOR_B]
    assert [e["target"] for e in body["edges"]] == [NEIGHBOR_A, CENTER]
    assert body["edges"][0]["predicate"] == PRED_AUTHOR
    assert body["edges"][0]["label"] == "author"
    assert body["edges"][0]["id"] == f"{CENTER}|{PRED_AUTHOR}|{NEIGHBOR_A}"
    assert body["page"] == {"cursor": None, "limit": 500, "truncated": False}


def test_expand_dedups_neighbour_with_two_predicates(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            expand_row("node", CENTER, "", TYPE_DATASET, "D", ""),
            expand_row("edge", NEIGHBOR_A, "out", TYPE_PERSON, "Ann", PRED_AUTHOR),
            expand_row("edge", NEIGHBOR_A, "out", TYPE_PERSON, "Ann", PRED_PUBLISHER),
        )
    ]
    body = client.get(f"/api/expand/{enc(CENTER)}").json()
    assert [n["id"] for n in body["nodes"]] == [CENTER, NEIGHBOR_A]
    assert len(body["edges"]) == 2  # two distinct relationships survive
    assert {e["id"] for e in body["edges"]} == {
        f"{CENTER}|{PRED_AUTHOR}|{NEIGHBOR_A}",
        f"{CENTER}|{PRED_PUBLISHER}|{NEIGHBOR_A}",
    }


def test_expand_keeps_edge_but_not_duplicate_node_for_self_loop(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            expand_row("node", CENTER, "", TYPE_DATASET, "D", ""),
            expand_row("edge", CENTER, "out", TYPE_DATASET, "D", PRED_PUBLISHER),
        )
    ]
    body = client.get(f"/api/expand/{enc(CENTER)}").json()
    assert [n["id"] for n in body["nodes"]] == [CENTER]  # no second center
    assert len(body["edges"]) == 1
    assert body["edges"][0]["source"] == body["edges"][0]["target"] == CENTER


def test_expand_truncates_at_limit_plus_one(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            expand_row("node", CENTER, "", TYPE_DATASET, "D", ""),
            expand_row("edge", NEIGHBOR_A, "out", TYPE_PERSON, "Ann", PRED_AUTHOR),
            expand_row("edge", NEIGHBOR_B, "out", TYPE_PERSON, "Bob", PRED_PUBLISHER),
        )
    ]
    body = client.get(f"/api/expand/{enc(CENTER)}?limit=2").json()
    assert body["page"]["truncated"] is True
    assert body["page"]["limit"] == 2
    # only the center + the first edge row survive
    assert [n["id"] for n in body["nodes"]] == [CENTER, NEIGHBOR_A]


def test_expand_limit_clamped_to_max(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(expand_row("node", CENTER, "", TYPE_DATASET, "D", "")),
        sparql_response(expand_row("node", CENTER, "", TYPE_DATASET, "D", "")),
    ]
    resp = client.get(f"/api/expand/{enc(CENTER)}?limit=1000000")
    assert "LIMIT 5001" in sent_query(mock_qlever["requests"][0])  # max 5000, +1 probe
    body = resp.json()
    assert body["page"]["limit"] == 5000
    assert body["page"]["truncated"] is False


def test_expand_uses_pinned_vocabulary_iris(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(expand_row("node", CENTER, "", TYPE_DATASET, "D", ""))
    ]
    client.get(f"/api/expand/{enc(CENTER)}")
    query = sent_query(mock_qlever["requests"][0])
    assert "<https://schema.org/author>" in query  # relation from the pinned model
    assert "<https://schema.org/prefName>" in query  # label from the pinned model
    assert f"<{CENTER}>" in query
    assert "ORDER BY ?dir ?node ?pred" in query


def test_expand_offset_pages_the_deterministic_stream(mock_qlever, client):
    """`offset` + the ORDER BY give stable neighbor pages (root landing)."""
    mock_qlever["responses"] = [
        sparql_response(
            expand_row("edge", NEIGHBOR_A, "out", TYPE_PERSON, "Ann", PRED_AUTHOR)
        )
    ]
    client.get(f"/api/expand/{enc(CENTER)}?limit=10&offset=30")
    query = sent_query(mock_qlever["requests"][0])
    assert "LIMIT 11 OFFSET 30" in query  # +1 truncation probe carries the window


def test_expand_offset_negative_is_rejected(mock_qlever, client):
    mock_qlever["responses"] = []
    resp = client.get(f"/api/expand/{enc(CENTER)}?offset=-1")
    assert resp.status_code == 422


def test_expand_relations_allowlist_resolves_short_names(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(expand_row("node", CENTER, "", TYPE_DATASET, "D", ""))
    ]
    client.get(f"/api/expand/{enc(CENTER)}?relations=author,parentOrganization")
    query = sent_query(mock_qlever["requests"][0])
    assert "<https://schema.org/author>" in query
    assert "<https://schema.org/parentOrganization>" in query
    # NOT the full vocabulary: an unrelated pinned property stays out.
    assert "<https://schema.org/affiliation>" not in query


def test_expand_relations_dedups_full_iri_and_name(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(expand_row("node", CENTER, "", TYPE_DATASET, "D", ""))
    ]
    client.get(
        f"/api/expand/{enc(CENTER)}?relations={quote(PRED_AUTHOR)},{quote(PRED_AUTHOR)},author"
    )
    query = sent_query(mock_qlever["requests"][0])
    assert (
        query.count("<https://schema.org/author>") == 2
    )  # one VALUES block per branch


def test_expand_relations_with_nothing_resolvable_is_a_422(mock_qlever, client):
    mock_qlever["responses"] = []
    resp = client.get(f"/api/expand/{enc(CENTER)}?relations=notAProperty")
    assert resp.status_code == 422
    assert "notAProperty" in resp.json()["detail"]


def test_expand_query_offset_defaults_to_zero():
    q = templates.expand_query(
        iri=CENTER,
        relation_iris=[PRED_AUTHOR],
        label_iris=["https://schema.org/name"],
        limit=10,
    )
    assert "LIMIT 10 OFFSET 0" in q


def test_expand_template_selects_pred_and_orders():
    q = templates.expand_query(
        iri=CENTER,
        relation_iris=[PRED_AUTHOR],
        label_iris=["https://schema.org/name"],
        limit=10,
    )
    assert "?pred" in q.split("WHERE")[0]  # ?pred is selected
    assert "ORDER BY ?dir ?node ?pred" in q
    assert "GROUP BY ?node ?pred" in q
    assert "GROUP BY ?node" in q  # center branch: one row even with multiple types


def test_expand_template_label_shape_is_fast_form():
    q = templates.expand_query(
        iri=CENTER,
        relation_iris=[PRED_AUTHOR],
        label_iris=["https://schema.org/prefName", "https://schema.org/name"],
        limit=10,
    )
    assert "VALUES ?lbl" not in q
    assert "?lblval" not in q
    assert q.count("OPTIONAL { ?node <https://schema.org/prefName> ?l0 }") == 3
    assert q.count("OPTIONAL { ?node <https://schema.org/name> ?l1 }") == 3
    assert q.count("COALESCE(MIN(?l0), MIN(?l1)) AS ?label") == 3
    assert q.count('GROUP_CONCAT(DISTINCT STR(?nt); separator=" ") AS ?nodeType') == 3
    assert "MIN(?nt)" not in q


SCHEMA = "https://schema.org/"


def test_expand_folds_group_concat_types(mock_qlever, client):
    row = expand_row("node", CENTER, "", None, "Root", "")
    row["nodeType"] = lit(f"{SCHEMA}Thing {SCHEMA}FundingAgency")
    mock_qlever["responses"] = [sparql_response(row)]
    body = client.get(f"/api/expand/{enc(CENTER)}").json()
    assert body["nodes"][0]["type"] == "Institution"


def test_expand_invalid_iri_422(mock_qlever, client):
    assert client.get("/api/expand/not-an-iri").status_code == 422
    assert client.get(f"/api/expand/{enc('https://a b.org/x')}").status_code == 422


# -- /api/expand error dialect --------------------------------------------------


def test_expand_429_surfaces_retry_after(mock_qlever, client):
    mock_qlever["responses"] = [httpx.Response(429, headers={"retry-after": "120"})]
    resp = client.get(f"/api/expand/{enc(CENTER)}")
    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "120"
    assert "rate-limited" in resp.json()["detail"]


def test_expand_query_error_400(mock_qlever, client):
    mock_qlever["responses"] = [
        httpx.Response(400, json={"exception": "Invalid SPARQL query"})
    ]
    resp = client.get(f"/api/expand/{enc(CENTER)}")
    assert resp.status_code == 400
    assert "Invalid SPARQL query" in resp.json()["detail"]


def test_expand_server_error_502(mock_qlever, client):
    mock_qlever["responses"] = [httpx.Response(500)]
    assert client.get(f"/api/expand/{enc(CENTER)}").status_code == 502


def test_expand_unavailable_503(mock_qlever, client):
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    qlever.set_client(QleverClient(DEV_URL, transport=httpx.MockTransport(handler)))
    assert client.get(f"/api/expand/{enc(CENTER)}").status_code == 503


# -- /api/entity/{iri} -----------------------------------------------------------


def entity_row(pred: str, obj: dict[str, Any]) -> dict[str, Any]:
    return {"pred": uri(pred), "obj": obj}


def test_entity_validates_node_via_f6_and_returns_properties(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            entity_row(RDF_TYPE, uri(TYPE_DATASET)),
            entity_row("https://schema.org/name", lit("Dataset name")),
            entity_row(
                "https://schema.org/license", uri("https://spdx.org/licenses/CC-BY-4.0")
            ),
            entity_row("https://schema.org/author", uri(NEIGHBOR_A)),
            entity_row("https://schema.org/author", uri(NEIGHBOR_B)),
        )
    ]
    resp = client.get(f"/api/entity/{enc(CENTER)}")
    assert resp.status_code == 200
    body = resp.json()
    # F6 validation: Dataset class, label from the prefName/name chain
    assert body["node"] == {
        "id": CENTER,
        "label": "Dataset name",
        "type": "Dataset",
        "group": "Dataset",
        "purl": None,
    }
    # properties keyed by predicate IRI; rdf:type excluded; multi-value lists
    assert body["properties"] == {
        "https://schema.org/name": ["Dataset name"],
        "https://schema.org/license": ["https://spdx.org/licenses/CC-BY-4.0"],
        "https://schema.org/author": [NEIGHBOR_A, NEIGHBOR_B],
    }


def test_entity_unknown_type_falls_back_to_unknown_wrapper(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            entity_row(RDF_TYPE, uri("http://xmlns.com/foaf/0.1#Person")),
            entity_row("https://schema.org/name", lit("Mystery")),
        )
    ]
    body = client.get(f"/api/entity/{enc(CENTER)}").json()
    assert body["node"]["type"] == "Unknown"
    assert body["node"]["group"] == "Unknown"
    assert body["node"]["label"] == "Mystery"


def test_entity_without_type_uses_thing_fallback(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(entity_row("https://schema.org/name", lit("No Type")))
    ]
    body = client.get(f"/api/entity/{enc(CENTER)}").json()
    assert body["node"]["type"] == "Unknown"
    assert body["node"]["label"] == "No Type"


def test_entity_prefers_known_type_in_contract_order(mock_qlever, client):
    mock_qlever["responses"] = [
        sparql_response(
            entity_row(RDF_TYPE, uri(TYPE_ORGANIZATION)),
            entity_row(RDF_TYPE, uri(TYPE_DATASET)),
            entity_row("https://schema.org/name", lit("Both")),
        )
    ]
    body = client.get(f"/api/entity/{enc(CENTER)}").json()
    # Dataset (a pinned class) wins over the unknown Organization type
    assert body["node"]["type"] == "Dataset"


def _real_validation_error() -> ValidationError:
    """A genuine pydantic ValidationError (v2 can't be built from a dict list)."""

    from pydantic import BaseModel

    class _M(BaseModel):
        x: int

    try:
        _M(x="not-an-int")
    except ValidationError as err:
        return err
    raise AssertionError("expected a ValidationError")  # pragma: no cover


def test_entity_validation_rejection_falls_back_to_unknown(
    mock_qlever, client, monkeypatch
):
    mock_qlever["responses"] = [
        sparql_response(
            entity_row(RDF_TYPE, uri(TYPE_PERSON)),
            entity_row("https://schema.org/name", lit("Ann")),
        )
    ]

    def reject(_payload, **_kwargs):
        raise _real_validation_error()

    monkeypatch.setattr(PersonWrapper, "from_payload", staticmethod(reject))
    body = client.get(f"/api/entity/{enc(CENTER)}").json()
    assert body["node"]["type"] == "Unknown"
    assert body["properties"] == {"https://schema.org/name": ["Ann"]}


def test_entity_empty_404(mock_qlever, client):
    mock_qlever["responses"] = [
        httpx.Response(
            200, json={"head": {"vars": ["pred", "obj"]}, "results": {"bindings": []}}
        )
    ]
    resp = client.get(f"/api/entity/{enc('https://nope.example/missing')}")
    assert resp.status_code == 404
    assert "no triples" in resp.json()["detail"]


def test_entity_invalid_iri_422(mock_qlever, client):
    assert client.get("/api/entity/not-an-iri").status_code == 422
    assert client.get(f"/api/entity/{enc('https://a b.org/x')}").status_code == 422


def test_entity_429_surfaces_retry_after(mock_qlever, client):
    mock_qlever["responses"] = [httpx.Response(429, headers={"retry-after": "300"})]
    resp = client.get(f"/api/entity/{enc(CENTER)}")
    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "300"


# -- IRI -> NodeType mapping ------------------------------------------------------


def test_type_map_is_exact_iri_match():
    assert api_b2._type_of(TYPE_PERSON) == "Person"
    assert api_b2._type_of("http://xmlns.com/foaf/0.1#Person") == "Unknown"
    assert api_b2._type_of(None) == "Unknown"


def test_type_map_covers_pinned_subtypes():
    assert api_b2._type_of("https://schema.org/FundingAgency") == "Institution"
    assert api_b2._type_of("https://schema.org/GovernmentOrganization") == "Institution"
    assert api_b2._type_of("https://schema.org/ScholarlyArticle") == "Document"
    assert api_b2._type_of("https://schema.org/SoftwareSourceCode") == "Software"
    assert api_b2._type_of("https://schema.org/PhysicalInstrument") == "Instrument"
    assert api_b2._type_of("https://schema.org/Thing") == "Unknown"


def test_group_of_types_picks_contract_order_else_unknown():
    s = "https://schema.org/"
    # Institution precedes Person in contract order regardless of cell order.
    assert api_b2._group_of_types(f"{s}Person {s}Organization") == "Institution"
    assert api_b2._group_of_types(f"{s}Thing {s}Article") == "Document"
    assert api_b2._group_of_types(f"{s}Thing http://xmlns.com/foaf/0.1#X") == "Unknown"
    assert api_b2._group_of_types("") == "Unknown"
    assert api_b2._group_of_types(None) == "Unknown"


def test_local_name_prefers_fragment():
    assert api_b2._local_name("http://xmlns.com/foaf/0.1#Person") == "Person"
    assert api_b2._local_name("https://schema.org/author") == "author"
