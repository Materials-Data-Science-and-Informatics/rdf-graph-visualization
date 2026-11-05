# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Frozen API contract (card F3).

These models are the single source of truth for the JSON shape exchanged with the
frontend. The TypeScript types in frontend/src/api/types.ts are kept in lock-step
with this module by the contract test in tests/test_contract.py.

Design rules carried over from research:
- every payload is bounded; a ``cursor`` paginates slices; ``truncated`` tells the
  client the server stopped early.
- node/edge shapes are vocabulary-agnostic; ``group`` is the data-model class name
  the renderer colours by, never a raw IRI.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

NodeType = Literal[
    "DataCatalog",
    "Dataset",
    "Document",
    "Event",
    "Institution",
    "Instrument",
    "Software",
    "Person",
    "Unknown",
]


class Node(BaseModel):
    """One graph node: an entity IRI with display metadata."""

    id: str = Field(description="Entity IRI (stable key).")
    label: str
    type: NodeType
    group: str = Field(description="Data-model class used for colour/grouping.")
    purl: str | None = None


class Edge(BaseModel):
    """One directed, labelled relationship between two nodes."""

    id: str
    source: str
    target: str
    predicate: str
    label: str


def edge_label(predicate_iri: str) -> str:
    """Display name of a predicate IRI (last ``#``- or ``/``-segment)."""
    tail = predicate_iri.rsplit("/", 1)[-1]
    return tail.rsplit("#", 1)[-1] or predicate_iri


def build_edge(source: str, predicate: str, target: str) -> Edge:
    """Canonical Edge: id ``source|predicate|target``, label the predicate's
    local name. Every endpoint folds SPARQL rows through this single factory
    so the edge identity/label convention has exactly one definition."""
    return Edge(
        id=f"{source}|{predicate}|{target}",
        source=source,
        target=target,
        predicate=predicate,
        label=edge_label(predicate),
    )


class Page(BaseModel):
    """Pagination envelope for bounded, cursor-paginated slices."""

    cursor: str | None = None
    limit: int
    truncated: bool = False


class Subgraph(Node):
    """Backward-compatible alias kept for the frozen API contract."""


class SubgraphResponse(BaseModel):
    """Bounded node/edge slice of the graph plus its pagination state."""

    nodes: list[Node]
    edges: list[Edge]
    page: Page


class AggregateNode(BaseModel):
    """Per-group node count for the aggregate/legend endpoint."""

    group: str
    type: NodeType
    count: int


class AggregateResponse(BaseModel):
    """Counts of all graph nodes grouped by data-model class."""

    nodes: list[AggregateNode]


class SearchResult(BaseModel):
    """One match returned by the label/entity search endpoint."""

    id: str
    label: str
    type: NodeType


class SearchResponse(BaseModel):
    """Search hits for the verbatim query string."""

    query: str
    results: list[SearchResult]


class EntityResponse(BaseModel):
    """Full entity view: the node plus its property values."""

    node: Node
    properties: dict[str, list[str]] = Field(
        default_factory=dict,
        description="predicate IRI -> literal/object values, validated via hkg_data_model.",
    )


class ConfigTypePreset(BaseModel):
    """Renderer preset for one data-model class (group, colour)."""

    group: str
    type: NodeType
    color: str


class GraphGroupConfig(BaseModel):
    """Graph colour group: name, member type IRIs, colour."""

    name: str
    types: list[str]
    color: str


class GraphConfigResponse(BaseModel):
    """Graph filter config served from app/graph_config.toml."""

    relation_properties: list[str]
    label_properties: list[str]
    skip_types: list[str]
    groups: list[GraphGroupConfig]


class ConfigResponse(BaseModel):
    """Static frontend configuration derived from the data model."""

    # Top-level label_properties/skip_types are legacy (data-model derived);
    # graph.* is authoritative for graph filtering and queries.
    relation_properties: list[str]
    label_properties: list[str]
    skip_types: list[str]
    types: list[ConfigTypePreset]
    graph: GraphConfigResponse
