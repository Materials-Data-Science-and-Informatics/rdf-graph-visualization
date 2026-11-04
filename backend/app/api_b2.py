# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""B2 endpoint card: ``/api/expand/{iri}`` + ``/api/entity/{iri}``.

``expand`` — one entity plus its in/out 1-hop neighbours in a single QLever
call (``templates.expand_query``). The rows are folded into the frozen
``SubgraphResponse`` so the frontend store's existing cursor-page ingest path
merges the slice without a new shape: the center comes first, ``out`` edges
are ``center -> neighbour``, ``in`` edges ``neighbour -> center``; the
predicate IRI carries the edge identity/label.

``entity`` — the full property view of one entity (``templates.
entity_properties_query``, bounded at 200 rows). The node is validated via
the pinned hkg_data_model wrappers (card F6) before it is served: the
deterministic primary type picks the wrapper, and a payload the wrapper
rejects falls back to the permissive ``UnknownWrapper`` — raw JSON-LD never
leaks into the response.

IRIs arrive percent-encoded in the path (the frontend client uses
``encodeURIComponent``). The routes use Starlette's ``:path`` converter:
ASGI hands us an already-decoded ``scope["path"]``, so a ``%2F`` in the
request becomes a literal ``/`` and the plain ``str`` converter (``[^/]+``)
would 404 every real IRI. ``assert_valid_iri`` validates the decoded value.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from functools import lru_cache
from typing import Any, get_args

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app import contract, errors, presets, qlever, templates
from app.hkg_wrappers import WRAPPER_BY_NODE_TYPE, UnknownWrapper
from app.qlever import Binding
from app.settings import Settings

router = APIRouter()

RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
SCHEMA_ORG = "https://schema.org/"

#: Exact-IRI -> contract group for the pinned data-model classes (same
#: convention as scripts/generate-qllever-fixtures.py); any other type IRI
#: renders as "Unknown".
_KNOWN_TYPE_IRIS: dict[str, contract.NodeType] = {
    f"{SCHEMA_ORG}{group}": group for group in presets.known_groups()
}

#: Contract declaration order (DataCatalog..Person) — used to pick the
#: deterministic primary type of a multiply-typed entity.
_CONTRACT_ORDER: tuple[contract.NodeType, ...] = get_args(contract.NodeType)


def _type_of(type_iri: str | None) -> contract.NodeType:
    """Contract NodeType for a type IRI (exact match, else Unknown)."""
    if type_iri and type_iri in _KNOWN_TYPE_IRIS:
        return _KNOWN_TYPE_IRIS[type_iri]
    return "Unknown"


def _binding_str(binding: Binding | None) -> str | None:
    """Cell text: literals as-is, IRIs as the IRI, bnodes as ``_:id``."""
    if binding is None or not binding.value:
        return None
    if binding.type == "bnode":
        return f"_{binding.value}"
    return binding.value


def _local_name(iri: str) -> str:
    """IRI -> local name (``.../name`` or ``...#name``) for display/payloads."""
    if "#" in iri:
        return iri.rsplit("#", 1)[-1]
    return iri.rsplit("/", 1)[-1]


def _node(node_iri: str, type_iri: str | None, label: str | None) -> contract.Node:
    group = _type_of(type_iri)
    return contract.Node(id=node_iri, label=label or node_iri, type=group, group=group)


def _edge(center: str, direction: str, neighbor: str, pred: str) -> contract.Edge:
    """Directed edge; source->target encodes direction (in vs out)."""
    source, target = (center, neighbor) if direction == "out" else (neighbor, center)
    return contract.build_edge(source, pred, target)


@lru_cache(maxsize=1)
def _vocab() -> tuple[tuple[str, ...], tuple[str, ...]]:
    """(relation IRIs, label IRIs) of the pinned data model.

    Memoized: the pin is static for the process lifetime, and reflecting the
    model would burn the p95 budget for nothing.
    """
    cfg = presets.build_config()
    return tuple(cfg.relation_properties), tuple(cfg.label_properties)


def _resolve_relations(spec: str) -> tuple[str, ...]:
    """Resolve a comma-separated relation allow-list against the data model.

    Entries are either full property IRIs (kept when they are in the pinned
    vocabulary) or short names, matched against the vocabulary by local-name
    suffix (``…/name`` / ``…#name``, plus the schema.org convention). Input
    order wins; duplicates collapse. Raises ``ValueError`` when a non-empty
    spec resolves to nothing (a typo should surface, not silently widen).
    """
    vocab = _vocab()[0]
    by_iri = set(vocab)
    by_name: dict[str, str] = {}
    for iri in vocab:
        local = re.split(r"[/#]", iri)[-1]
        by_name.setdefault(local.lower(), iri)
    resolved: list[str] = []
    for raw in spec.split(","):
        entry = raw.strip()
        if not entry:
            continue
        iri = entry if entry in by_iri else by_name.get(entry.lower(), "")
        if iri and iri not in resolved:
            resolved.append(iri)
    if not resolved:
        raise ValueError(f"relations filter {spec!r} matches no data-model property")
    return tuple(resolved)


def _choose_type_iri(type_iris: set[str]) -> str:
    """Deterministic primary type IRI: known class in contract order first,
    else the lexicographically smallest type, else schema.org Thing."""
    for group in _CONTRACT_ORDER:
        if group == "Unknown":
            continue
        cand = f"{SCHEMA_ORG}{group}"
        if cand in type_iris:
            return cand
    if type_iris:
        return min(type_iris)
    return f"{SCHEMA_ORG}Thing"


def _validated_node(
    payload: Mapping[str, Any], type_iri: str, settings: Settings
) -> contract.Node:
    """Validate the entity payload via F6 and return its frozen Node.

    The wrapper is picked by the exact primary type IRI; if the pinned class
    rejects the payload (a real data-model mismatch, not a data gap) the
    permissive UnknownWrapper is the fallback so the entity stays visible.
    """
    group = _type_of(type_iri)
    wrapper_cls = WRAPPER_BY_NODE_TYPE.get(group, UnknownWrapper)
    try:
        return wrapper_cls.from_payload(payload, source=settings.qlever_url).node
    except ValidationError:
        pass
    try:
        return UnknownWrapper.from_payload(payload, source=settings.qlever_url).node
    except ValidationError as exc:
        raise HTTPException(
            status_code=422, detail=f"entity failed data-model validation: {exc}"
        ) from exc


def _fold_expand_rows(
    center_iri: str, rows: list[dict[str, Binding]]
) -> tuple[list[contract.Node], list[contract.Edge]]:
    """Fold expand rows into (nodes with the center first, directed edges).

    Neighbour nodes are deduped per IRI (the center is never re-listed as its
    own neighbour); edges are deduped per (source, predicate, target).
    """
    center: contract.Node | None = None
    nodes: list[contract.Node] = []
    edges: list[contract.Edge] = []
    seen_nodes: set[str] = {center_iri}
    seen_edges: set[str] = set()
    for row in rows:
        kind = _binding_str(row.get("kind"))
        node_iri = _binding_str(row.get("node"))
        if not node_iri:
            continue
        if kind == "node":
            center = _node(
                node_iri,
                _binding_str(row.get("nodeType")),
                _binding_str(row.get("label")),
            )
            continue
        if kind != "edge":
            continue
        direction = _binding_str(row.get("dir")) or ""
        pred = _binding_str(row.get("pred"))
        if direction not in ("in", "out") or not pred:
            continue
        edge = _edge(center_iri, direction, node_iri, pred)
        if edge.id in seen_edges:
            continue
        seen_edges.add(edge.id)
        edges.append(edge)
        if node_iri not in seen_nodes:
            seen_nodes.add(node_iri)
            nodes.append(
                _node(
                    node_iri,
                    _binding_str(row.get("nodeType")),
                    _binding_str(row.get("label")),
                )
            )
    if center is not None:
        nodes.insert(0, center)
    return nodes, edges


@router.get("/expand/{iri:path}", response_model=contract.SubgraphResponse)
def expand(
    iri: str,
    limit: int | None = Query(default=None),
    offset: int = Query(default=0, ge=0),
    relations: str | None = Query(default=None),
) -> contract.SubgraphResponse | JSONResponse:
    """One entity plus its 1-hop in/out neighbours — one QLever call.

    ``offset`` pages the deterministic neighbour stream (the root landing's
    "load more around this center" flow); ``relations`` is an allow-list of
    property names / IRIs restricting the traversed predicates.
    """
    try:
        templates.assert_valid_iri(iri)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    settings = Settings.from_env()
    page_limit = templates.clamp_limit(
        limit, default=settings.default_limit, max_=settings.max_limit
    )
    all_relations, labels = _vocab()
    if relations:
        try:
            relation_iris = _resolve_relations(relations)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    else:
        relation_iris = all_relations
    query = templates.expand_query(
        iri=iri,
        relation_iris=relation_iris,
        label_iris=labels,
        limit=page_limit + 1,
        offset=offset,
    )
    try:
        result = qlever.get_client().select(query)
    except qlever.QleverError as exc:
        return errors.qlever_error_response(exc)

    truncated = len(result.rows) > page_limit
    nodes, edges = _fold_expand_rows(iri, result.rows[:page_limit])
    return contract.SubgraphResponse(
        nodes=nodes,
        edges=edges,
        page=contract.Page(limit=page_limit, truncated=truncated),
    )


@router.get("/entity/{iri:path}", response_model=contract.EntityResponse)
def entity(iri: str) -> contract.EntityResponse | JSONResponse:
    """Node + all property values of one entity, node validated via F6."""
    try:
        templates.assert_valid_iri(iri)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    query = templates.entity_properties_query(iri=iri)  # bounded at 200 rows
    try:
        result = qlever.get_client().select(query)
    except qlever.QleverError as exc:
        return errors.qlever_error_response(exc)
    if not result.rows:
        raise HTTPException(status_code=404, detail=f"no triples for entity {iri}")

    type_iris: set[str] = set()
    properties: dict[str, list[str]] = {}
    for row in result.rows:
        pred = _binding_str(row.get("pred"))
        obj_str = _binding_str(row.get("obj"))
        if not pred:
            continue
        if pred == RDF_TYPE:
            if obj_str:
                type_iris.add(obj_str)
            continue
        properties.setdefault(pred, []).append(obj_str or "")

    type_iri = _choose_type_iri(type_iris)
    payload: dict[str, Any] = {"@id": iri, "@type": _local_name(type_iri)}
    for pred, values in properties.items():
        field = _local_name(pred)
        payload[field] = values[0] if len(values) == 1 else values
    node = _validated_node(payload, type_iri, Settings.from_env())
    return contract.EntityResponse(node=node, properties=properties)
