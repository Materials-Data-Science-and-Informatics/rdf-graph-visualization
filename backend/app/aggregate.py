# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""GET /api/aggregate — node counts per data-model class (card B4).

One unbounded QLever call (``templates.aggregate_query``) counts the
instances of *every* ``rdf:type`` in the dataset. The endpoint groups the
rows by the pinned data model's classes: an exact ``schema.org/<group>``
match maps to that class, and every other type IRI is folded into a single
``Unknown`` bucket. The response is therefore small and bounded (<= 9
rows) regardless of how many type IRIs the dataset carries — counts, not
rows, are what the legend/cluster landing renders.

QLever failures map to HTTP and are never retried (shared-token 429
penalty ladder — see ``app.qlever``):

- 429 from QLever  -> 429 + ``Retry-After`` (server-declared wait)
- 4xx (parse etc.) -> 400 with the parser message
- 5xx / non-JSON   -> 502
- timeout/connect  -> 503
"""

from __future__ import annotations

import math

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app import contract, presets, qlever, templates
from app.qlever import Binding

router = APIRouter(prefix="/api")

_SCHEMA_ORG = "https://schema.org/"

#: Pinned data-model classes (no ``Unknown``), once per process.
_KNOWN_GROUPS = frozenset(presets.known_groups())


def _group_of(type_iri: str) -> contract.NodeType:
    """Contract class for a type IRI: exact known ``schema.org`` class, else
    the ``Unknown`` fallback."""
    if type_iri.startswith(_SCHEMA_ORG):
        local = type_iri[len(_SCHEMA_ORG) :]
        if local in _KNOWN_GROUPS:
            return local  # type: ignore[return-value]
    return "Unknown"


def _fold(rows: list[dict[str, Binding]]) -> contract.AggregateResponse:
    """Fold raw ``(?type, ?count)`` rows into per-class counts.

    Unknown type IRIs are summed into one ``Unknown`` bucket. Rows with a
    non-URI type or a non-integer count (a malformed engine answer) are
    skipped rather than served. Output is count-descending with the group
    name as deterministic tie-break.
    """
    counts: dict[contract.NodeType, int] = {}
    for row in rows:
        t = row.get("type")
        c = row.get("count")
        if t is None or t.type != "uri" or not t.value:
            continue
        if c is None or c.type != "literal" or not c.value:
            continue
        try:
            n = int(c.value)
        except ValueError:
            continue
        if n < 0:
            continue
        group = _group_of(t.value)
        counts[group] = counts.get(group, 0) + n
    nodes = [
        contract.AggregateNode(group=group, type=group, count=n)
        for group, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    return contract.AggregateResponse(nodes=nodes)


@router.get("/aggregate", response_model=contract.AggregateResponse)
def aggregate() -> contract.AggregateResponse | JSONResponse:
    """Node counts per data-model class — one unbounded QLever call."""
    try:
        result = qlever.get_client().select(templates.aggregate_query())
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
    return _fold(result.rows)
