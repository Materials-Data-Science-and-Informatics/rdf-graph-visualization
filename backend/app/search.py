# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""GET /api/search — prefix search over entity labels (card B5).

The autocomplete source: one *bounded* QLever call (``templates.search_query``,
``LIMIT 20``) runs a case-insensitive *prefix* match over the pinned label
properties of the data model (``prefName``/``name``/``identifier`` — the same
chain the F6 wrappers use for display labels, derived by ``app.presets``).
``q`` is regex-escaped in the template, so user text is data, never a pattern.

Folding into the frozen ``SearchResponse`` (order-independent — the engine's
row order can never change the output):

- one node can match through several rows (multiple label properties,
  values, or rdf:types — the dataset types many entities both as their
  specific class and as ``schema.org/Thing``); it is folded into a single
  hit per node:
- ``type``: B2's primary-type rule over the node's type IRIs — a known
  data-model class in contract declaration order, else ``Unknown``;
- ``label``: the matched label with the highest label-property priority
  (``prefName`` > ``name`` > ``identifier``, the F6 display chain); ties
  broken by the alphabetically-first label.
- malformed rows (missing/non-URI node, missing/blank/bnode label) are
  skipped rather than served.
- output is ordered ``(label, id)`` for determinism and capped at 20 hits.
  Note the cap applies to the folded hits; the engine's ``LIMIT 20`` counts
  raw rows, so duplicate label rows can make the returned list land under
  20 (and a node's type set may be incomplete at the row cut). The frozen
  contract carries no pagination for autocomplete.

``q`` is a required query parameter: 1..200 characters (server-side cap —
an autocomplete prefix, not a query language); empty, whitespace-only or
missing values are rejected with 422 before any QLever traffic is sent. The
response's ``query`` field echoes the verbatim request string.

QLever failures map to HTTP and are never retried (shared-token 429
penalty ladder — see ``app.qlever``):

- 429 from QLever  -> 429 + ``Retry-After`` (server-declared wait)
- 4xx (parse etc.) -> 400 with the parser message
- 5xx / non-JSON   -> 502
- timeout/connect  -> 503
"""

from __future__ import annotations

from typing import Annotated, get_args

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from app import contract, errors, presets, qlever, templates
from app.qlever import Binding

router = APIRouter(prefix="/api")

_SCHEMA_ORG = "https://schema.org/"

#: Server-side cap on the search prefix — autocomplete input, not a query.
_MAX_QUERY_LEN = 200

#: Hit cap for one search (pinned by card B5; the template default).
_SEARCH_LIMIT = templates.DEFAULT_SEARCH_LIMIT

#: Label properties of the pinned data model, once per process — the same
#: derivation ``/api/config`` serves to the frontend (see ``app.presets``).
_LABEL_IRIS: list[str] = list(presets.build_config().label_properties)

#: Display priority of the pinned label properties — the F6 display chain
#: (prefName > name > identifier), once per process.
_LABEL_RANK: dict[str, int] = {iri: i for i, iri in enumerate(_LABEL_IRIS)}
_FALLBACK_RANK = len(_LABEL_RANK)

#: Contract declaration order (DataCatalog..Person, then ``Unknown``) — the
#: B2 rule that picks the deterministic primary type of a multiply-typed
#: node.
_CONTRACT_ORDER: tuple[contract.NodeType, ...] = get_args(contract.NodeType)


def _primary_type(type_iris: set[str]) -> contract.NodeType:
    """Deterministic primary type of a multiply-typed node (B2's rule):
    a known data-model class in contract declaration order, else the
    ``Unknown`` fallback."""
    for group in _CONTRACT_ORDER:
        if group != "Unknown" and f"{_SCHEMA_ORG}{group}" in type_iris:
            return group  # type: ignore[return-value]
    return "Unknown"


def _fold(rows: list[dict[str, Binding]], limit: int) -> list[contract.SearchResult]:
    """Fold raw ``(?node, ?nodeType, ?label, ?lbl)`` rows into search hits.

    A node can match through several rows (multiple label properties,
    values, or rdf:types — e.g. the dataset types many entities both as
    their specific class and as ``schema.org/Thing``); the fold is
    order-independent, so the engine's row order can never change the
    output:

    - ``type``: B2's primary-type rule over the node's type IRIs — a known
      class in contract order, else ``Unknown``.
    - ``label``: the matched label with the highest label-property priority
      (prefName > name > identifier); ties broken by the alphabetically
      first label (the engine's ``ORDER BY ?label``).
    - malformed rows (missing/non-URI node, missing/blank/bnode label) are
      skipped rather than served.

    Output is ordered ``(label, id)`` for determinism and capped at
    *limit* hits.
    """
    best_label: dict[str, tuple[int, str]] = {}
    type_iris: dict[str, set[str]] = {}
    for row in rows:
        node = row.get("node")
        label = row.get("label")
        if node is None or node.type != "uri" or not node.value:
            continue
        if label is None or label.type == "bnode" or not label.value:
            continue
        lbl = row.get("lbl")
        rank = (
            _LABEL_RANK.get(lbl.value, _FALLBACK_RANK)
            if lbl is not None and lbl.type == "uri"
            else _FALLBACK_RANK
        )
        candidate = (rank, label.value)
        current = best_label.get(node.value)
        if current is None or candidate < current:
            best_label[node.value] = candidate
        t = row.get("nodeType")
        if t is not None and t.type == "uri" and t.value:
            type_iris.setdefault(node.value, set()).add(t.value)
    hits = [
        contract.SearchResult(
            id=node,
            label=label,
            type=_primary_type(type_iris.get(node, set())),
        )
        for node, (_, label) in best_label.items()
    ]
    return sorted(hits, key=lambda hit: (hit.label, hit.id))[:limit]


@router.get("/search", response_model=contract.SearchResponse)
def search(
    q: Annotated[
        str,
        Query(
            min_length=1,
            max_length=_MAX_QUERY_LEN,
            description="Case-insensitive prefix, matched against entity labels.",
        ),
    ],
) -> contract.SearchResponse | JSONResponse:
    """Prefix search over entity labels — the autocomplete source (B5).

    ``q`` is matched case-insensitively as a *prefix* of any pinned label
    property; at most 20 hits. The response's ``query`` echoes the verbatim
    request string.
    """
    text = q.strip()
    if not text:
        raise HTTPException(status_code=422, detail="search text must be non-empty")
    try:
        result = qlever.get_client().select(
            templates.search_query(
                text=text, label_iris=_LABEL_IRIS, limit=_SEARCH_LIMIT
            )
        )
    except qlever.QleverError as exc:
        return errors.qlever_error_response(exc)
    return contract.SearchResponse(query=q, results=_fold(result.rows, _SEARCH_LIMIT))
