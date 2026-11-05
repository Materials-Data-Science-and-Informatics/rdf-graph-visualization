# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Guard the F3 contract: backend pydantic model and frontend TS types must match.

Parses frontend/src/api/types.ts with a light regex (no Node needed) and compares
the field-name sets per shared interface against the pydantic model fields.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from pydantic import BaseModel

from app import contract

TS_TYPES = Path(__file__).resolve().parents[2] / "frontend" / "src" / "api" / "types.ts"

MODEL_TO_INTERFACE = {
    "Node": contract.Node,
    "Edge": contract.Edge,
    "Page": contract.Page,
    "SubgraphResponse": contract.SubgraphResponse,
    "AggregateNode": contract.AggregateNode,
    "AggregateResponse": contract.AggregateResponse,
    "SearchResult": contract.SearchResult,
    "SearchResponse": contract.SearchResponse,
    "EntityResponse": contract.EntityResponse,
    "ConfigTypePreset": contract.ConfigTypePreset,
    "ConfigResponse": contract.ConfigResponse,
}

# Backend-only fields the frontend rebuild has not mirrored in types.ts yet.
PENDING_FRONTEND_FIELDS = {"ConfigResponse": {"graph"}}


def _ts_interface_fields(text: str, name: str) -> set[str]:
    match = re.search(rf"interface {name}\s*\{{(.*?)\}}", text, re.DOTALL)
    assert match, f"interface {name} not found in types.ts"
    fields = set()
    for line in match.group(1).splitlines():
        line = line.strip()
        fm = re.match(r"(\w+)\??\s*:", line)
        if fm:
            fields.add(fm.group(1))
    return fields


@pytest.mark.parametrize("name,model", sorted(MODEL_TO_INTERFACE.items()))
def test_contract_fields_match(name: str, model: type[BaseModel]) -> None:
    text = TS_TYPES.read_text(encoding="utf-8")
    ts_fields = _ts_interface_fields(text, name)
    py_fields = set(model.model_fields) - PENDING_FRONTEND_FIELDS.get(name, set())
    assert ts_fields == py_fields, f"{name}: TS {ts_fields ^ py_fields} drift"
