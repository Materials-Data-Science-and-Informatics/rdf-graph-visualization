# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""GET /api/subgraph — bounded, cursor-paginated graph slice (card B3).

One SPARQL call returns both node rows and edge rows (``?kind``
discriminator, see ``templates.subgraph_query``), so a slice always arrives
in a single endpoint call: nodes with their data-model ``type``/``group``
plus the edges between them (cross-type edges included).

Boundedness and paging:

- ``limit`` is the row budget for the slice (node + edge rows combined),
  clamped server-side into ``[1, max_limit]`` — a client can never pull an
  unbounded slice; ``None`` -> ``default_limit`` (both from the environment,
  see ``app.settings``).
- paging is cursor-based with opaque offset cursors
  (``templates.encode_cursor``/``decode_cursor``): the endpoint queries
  ``limit + 1`` rows; when the extra row exists the slice is ``truncated``
  and ``page.cursor`` continues exactly at the next offset, so a cursor
  round-trip neither skips nor repeats rows (the template's total ORDER BY
  plus the first-in-sort-order fold below is what makes that hold).
- every edge's endpoints are present in the same slice's ``nodes`` list
  (the frontend store only renders intra-slice edges). When an endpoint's
  own node row falls on another page, a minimal placeholder Node (label =
  IRI, the legacy fallback) is emitted for it; the real node row upgrades
  it on a later page (store is last-write-wins per IRI).

QLever failures map to HTTP and are never retried (shared-token 429
penalty ladder — see ``app.qlever``):

- 429 from QLever  -> 429 + ``Retry-After`` (server-declared wait)
- 4xx (parse etc.) -> 400 with the parser message
- 5xx / non-JSON   -> 502
- timeout/connect  -> 503
"""

from __future__ import annotations

import math
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from app import contract, presets, qlever, templates
from app.qlever import Binding
from app.settings import Settings

router = APIRouter(prefix="/api")

_SCHEMA_ORG = "https://schema.org/"


def _known_groups() -> frozenset[str]:
    """Data-model classes that exist in the pinned model (no ``Unknown``)."""
    return frozenset(presets.known_groups())


def _type_iris(type_name: contract.NodeType | None) -> list[str]:
    """schema.org IRIs for the requested class (or all known classes, in
    contract order — a stable query text, process to process).

    ``Unknown`` is a fallback, not a class — it has no IRI to filter on and
    is rejected with a ``ValueError`` (the endpoint answers 422).
    """
    if type_name is None:
        return [f"{_SCHEMA_ORG}{g}" for g in presets.known_groups()]
    if type_name == "Unknown":
        raise ValueError(
            "type=Unknown is a fallback class and cannot be used as a filter"
        )
    return [f"{_SCHEMA_ORG}{type_name}"]


def _node_type(iri: str | None) -> contract.NodeType:
    """Contract NodeType for a type IRI; anything outside the 8 classes -> Unknown."""
    if iri is not None and iri.startswith(_SCHEMA_ORG):
        local = iri[len(_SCHEMA_ORG) :]
        if local in _known_groups():
            return local  # type: ignore[return-value]
    return "Unknown"


def _uri(row: dict[str, Binding], var: str) -> str | None:
    cell = row.get(var)
    if cell is None or cell.type != "uri" or not cell.value:
        return None
    return cell.value


def _text(row: dict[str, Binding], var: str) -> str | None:
    cell = row.get(var)
    if cell is None or not cell.value:
        return None
    return cell.value


def _add_node(
    nodes: dict[str, contract.Node], iri: str, type_iri: str | None, label: str | None
) -> None:
    """Fold one (node, type, label) row for *iri*.

    Type/group is first-in-sort-order (deterministic across pages); the
    label is the first *real* label in sort order — a row with no label
    leaves the IRI fallback in place, so a later multi-type row carrying a
    real label still upgrades it.
    """
    ntype = _node_type(type_iri)
    if iri not in nodes:
        nodes[iri] = contract.Node(id=iri, label=label or iri, type=ntype, group=ntype)
    elif label and nodes[iri].label == iri:
        nodes[iri] = nodes[iri].model_copy(update={"label": label})


def _fold(
    rows: list[dict[str, Binding]], limit: int, offset_node: int, offset_edge: int
) -> contract.SubgraphResponse:
    """Fold a raw row slice (at most ``limit + 1`` rows) into the contract.

    The ``limit + 1``-th row only drives ``truncated``; served content is
    built from the first ``limit`` rows so every row belongs to exactly one
    page. The next cursor advances each stream by the number of rows of
    THAT stream the served page consumed — the merged page can be skewed
    (all-node or all-edge) and the streams must keep their own pace or
    rows would be skipped/repeated. Node rows are folded first so a real
    (node, type, label) row in this page always beats a placeholder
    synthesized from an edge row.
    """
    truncated = len(rows) > limit
    rows = rows[:limit]
    nodes: dict[str, contract.Node] = {}
    node_rows = 0
    for row in rows:
        if _text(row, "kind") == "node":
            node_rows += 1
            node = _uri(row, "node")
            if node is not None:
                _add_node(nodes, node, _uri(row, "nodeType"), _text(row, "label"))
    edges: dict[tuple[str, str], contract.Edge] = {}
    for row in rows:
        if _text(row, "kind") != "edge":
            continue
        source = _uri(row, "node")
        target = _uri(row, "other")
        pred = _uri(row, "pred")
        if source is None or target is None or pred is None:
            continue
        _add_node(nodes, source, _uri(row, "nodeType"), None)
        _add_node(nodes, target, _uri(row, "otherType"), None)
        key = (source, target)
        if key in edges:
            continue  # first predicate in sort order wins (store is non-multi)
        edges[key] = contract.build_edge(source, pred, target)
    edge_rows = len(rows) - node_rows
    return contract.SubgraphResponse(
        nodes=list(nodes.values()),
        edges=list(edges.values()),
        page=contract.Page(
            cursor=(
                templates.encode_subgraph_cursor(
                    offset_node + node_rows, offset_edge + edge_rows
                )
                if truncated
                else None
            ),
            limit=limit,
            truncated=truncated,
        ),
    )


@router.get("/subgraph", response_model=contract.SubgraphResponse)
def subgraph(
    type_name: Annotated[
        contract.NodeType | None,
        Query(
            alias="type",
            description="Restrict the slice to one data-model class (no filter = all).",
        ),
    ] = None,
    limit: Annotated[
        int | None,
        Query(
            description="Row budget for the slice; clamped to [1, max_limit].",
        ),
    ] = None,
    cursor: Annotated[
        str | None,
        Query(description="Opaque cursor from a previous page."),
    ] = None,
) -> contract.SubgraphResponse | JSONResponse:
    """Bounded, cursor-paginated node/edge slice of the graph (one SPARQL call)."""
    settings = Settings.from_env()
    page_limit = templates.clamp_limit(
        limit, default=settings.default_limit, max_=settings.max_limit
    )
    try:
        offset_node, offset_edge = templates.decode_subgraph_cursor(cursor)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        type_iris = _type_iris(type_name)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    config = presets.build_config()
    query = templates.subgraph_query(
        type_iris=type_iris,
        relation_iris=config.relation_properties,
        label_iris=config.label_properties,
        limit=page_limit,
        offset_node=offset_node,
        offset_edge=offset_edge,
    )
    try:
        result = qlever.get_client().select(query)
    except qlever.QleverRateLimited as exc:
        return JSONResponse(
            status_code=429,
            content={"detail": str(exc)},
            headers={"Retry-After": str(math.ceil(exc.wait_s))},
        )
    except qlever.QleverQueryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except qlever.QleverUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except qlever.QleverServerError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return _fold(result.rows, page_limit, offset_node, offset_edge)
