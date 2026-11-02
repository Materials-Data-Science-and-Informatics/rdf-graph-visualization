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
    id: str = Field(description="Entity IRI (stable key).")
    label: str
    type: NodeType
    group: str = Field(description="Data-model class used for colour/grouping.")
    purl: str | None = None


class Edge(BaseModel):
    id: str
    source: str
    target: str
    predicate: str
    label: str


class Page(BaseModel):
    """Pagination envelope for bounded, cursor-paginated slices."""

    cursor: str | None = None
    limit: int
    truncated: bool = False


class Subgraph(Node):
    pass


class SubgraphResponse(BaseModel):
    nodes: list[Node]
    edges: list[Edge]
    page: Page


class AggregateNode(BaseModel):
    group: str
    type: NodeType
    count: int


class AggregateResponse(BaseModel):
    nodes: list[AggregateNode]


class SearchResult(BaseModel):
    id: str
    label: str
    type: NodeType


class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]


class EntityResponse(BaseModel):
    node: Node
    properties: dict[str, list[str]] = Field(
        default_factory=dict,
        description="predicate IRI -> literal/object values, validated via hkg_data_model.",
    )


class ConfigTypePreset(BaseModel):
    group: str
    type: NodeType
    color: str


class ConfigResponse(BaseModel):
    relation_properties: list[str]
    label_properties: list[str]
    skip_types: list[str]
    types: list[ConfigTypePreset]
