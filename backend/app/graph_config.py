# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Graph filter config: the backend's single source for what the graph shows.

Loaded once from ``graph_config.toml`` (ported from the old main-branch
config.yml; path overridable via ``HKG_GRAPH_CONFIG``). A triple is an edge
only if its predicate is a configured relation AND its object is an IRI;
``skip_types`` are never rendered; labels follow ``label_properties`` order.
The groups here (type sets + colours) are authoritative for the graph; a test
guards them against the pinned data model (``presets.type_iri_groups``).
"""

from __future__ import annotations

import os
import tomllib
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, ValidationError, model_validator

DEFAULT_PATH = Path(__file__).with_name("graph_config.toml")


class GraphGroup(BaseModel):
    """One colour group and the schema.org type IRIs that map to it."""

    model_config = ConfigDict(extra="forbid")

    name: str
    types: list[str]
    color: str


class GraphConfig(BaseModel):
    """Typed view of graph_config.toml."""

    model_config = ConfigDict(extra="forbid")

    relation_properties: list[str]
    skip_types: list[str]
    label_properties: list[str]
    groups: list[GraphGroup]

    @model_validator(mode="after")
    def _check(self) -> GraphConfig:
        if not self.relation_properties:
            raise ValueError("relation_properties must not be empty")
        seen: set[str] = set()
        for group in self.groups:
            for type_iri in group.types:
                if type_iri in seen:
                    raise ValueError(f"type {type_iri} appears in two groups")
                seen.add(type_iri)
        return self

    def relation_iris(self) -> tuple[str, ...]:
        """Relation predicate IRIs."""
        return tuple(self.relation_properties)

    def label_iris(self) -> tuple[str, ...]:
        """Label predicate IRIs, priority order."""
        return tuple(self.label_properties)

    def skip_iris(self) -> tuple[str, ...]:
        """Type IRIs that are never rendered."""
        return tuple(self.skip_types)

    def type_group(self) -> dict[str, str]:
        """Type IRI -> group name."""
        return {t: g.name for g in self.groups for t in g.types}

    def group_color(self) -> dict[str, str]:
        """Group name -> colour."""
        return {g.name: g.color for g in self.groups}


@lru_cache(maxsize=1)
def load() -> GraphConfig:
    """Parse the config once (cached); env ``HKG_GRAPH_CONFIG`` overrides the path."""
    path = Path(os.environ.get("HKG_GRAPH_CONFIG") or DEFAULT_PATH)
    try:
        with path.open("rb") as handle:
            return GraphConfig.model_validate(tomllib.load(handle))
    except (OSError, tomllib.TOMLDecodeError, ValidationError) as exc:
        raise RuntimeError(f"graph config {path}: {exc}") from exc
