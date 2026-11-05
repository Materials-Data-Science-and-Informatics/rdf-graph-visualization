# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""``GET /api/node/{iri:path}``: info-panel summary of one node.

Id, label, group, rdf:type IRIs and the per-relation out/in edge counts (see
``bulk.fetch_node_summary``). IRIs arrive percent-encoded and decoded by
ASGI, hence the ``:path`` converter (same as ``/api/expand``). An IRI with
no types, no label and no relation edges is unknown (404).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app import bulk, contract, errors, qlever, templates

router = APIRouter()


@router.get(
    "/api/node/{iri:path}",
    response_model=contract.NodeInfo,
    response_model_by_alias=True,
)
async def node(iri: str) -> contract.NodeInfo | JSONResponse:
    """Quick summary of one node for the click-info panel."""
    try:
        templates.assert_valid_iri(iri)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        info = await bulk.fetch_node_summary(iri)
    except qlever.QleverError as exc:
        return errors.qlever_error_response(exc)
    if not info.types and info.label is None and not info.relations:
        raise HTTPException(status_code=404, detail=f"unknown node {iri}")
    ordered = sorted(info.relations.items(), key=lambda kv: (-sum(kv[1]), kv[0]))
    return contract.NodeInfo(
        id=iri,
        label=info.label,
        group=info.node_type.group,
        types=info.types,
        relations=[
            contract.NodeRelation(predicate=p, out=o, **{"in": i})
            for p, (o, i) in ordered
        ],
    )
