# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Frozen API contract (card F3).

These models are the single source of truth for the JSON shape exchanged with the
frontend (there is currently no lock-step check against frontend types).

Design rules carried over from research:
- every payload is bounded; ``truncated`` tells the client the server stopped early.
- node/edge shapes are vocabulary-agnostic; ``group`` is the data-model class name
  the renderer colours by, never a raw IRI.
"""

from __future__ import annotations

from typing import Annotated, Literal

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


class SearchResult(BaseModel):
    """One match returned by the label/entity search endpoint."""

    id: str
    label: str
    type: NodeType


class SearchResponse(BaseModel):
    """Search hits for the verbatim query string."""

    query: str
    results: list[SearchResult]


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


# -- /api/stream NDJSON events (documentation / consistency) -------------------
#
# One JSON object per line, flushed as produced. Nodes carry only id + group
# (data-model class name, null = no mapped group, including skip-typed nodes);
# labels arrive separately, edges carry their predicate IRI. Only the frontier
# is expanded: edges among last-hop or max_nodes-truncated nodes are not fetched.

#: ``max_nodes``: node budget reached. ``truncated``: an edge query hit its
#: LIMIT (hub) or the per-node ``max_fanout`` cap dropped neighbours, so the
#: result is partial although the BFS ran to exhaustion or
#: ``max_hops``. ``exhausted`` / ``max_hops`` therefore mean a complete BFS.
DoneReason = Literal[
    "exhausted", "max_nodes", "max_hops", "time_budget", "truncated", "error"
]


class NodeRelation(BaseModel):
    """IRI-edge counts of one configured relation at a node."""

    predicate: str
    out: int
    in_: int = Field(alias="in", serialization_alias="in")


class NodeInfo(BaseModel):
    """``GET /api/node/{iri}``: info-panel summary (no property list)."""

    id: str
    label: str | None
    group: str | None
    types: list[str] = Field(description="rdf:type IRIs, sorted.")
    relations: list[NodeRelation] = Field(
        description="Relations with out+in > 0, total desc."
    )


class StreamMeta(BaseModel):
    """First event: the effective (clamped) parameters."""

    type: Literal["meta"] = "meta"
    root: str
    max_nodes: int
    max_hops: int
    #: New neighbours taken per node and hop (0 = no cap).
    max_fanout: int = 0
    #: Set on a replay from the snapshot cache (``built_at``: ISO UTC build time).
    cached: bool | None = None
    built_at: str | None = None


class StreamNode(BaseModel):
    """A node as streamed: group is filled in later by a ``types`` event."""

    id: str
    group: str | None = None


class StreamNodes(BaseModel):
    """New nodes of one hop (hop 0 = the root)."""

    type: Literal["nodes"] = "nodes"
    hop: int
    nodes: list[StreamNode]


class StreamEdge(BaseModel):
    """Directed edge ``s --p--> o`` (all IRIs)."""

    s: str
    p: str
    o: str


class StreamEdges(BaseModel):
    """Edges of one hop; both endpoints were streamed before or with them."""

    type: Literal["edges"] = "edges"
    hop: int
    edges: list[StreamEdge]


class StreamTypes(BaseModel):
    """Groups of a completed chunk (``null`` = no mapped group)."""

    type: Literal["types"] = "types"
    types: dict[str, str | None]


class StreamLabels(BaseModel):
    """Labels of a completed chunk (nodes without a label are absent)."""

    type: Literal["labels"] = "labels"
    labels: dict[str, str]


class StreamProgress(BaseModel):
    """Running totals after a hop."""

    type: Literal["progress"] = "progress"
    hop: int
    nodes: int
    edges: int


class StreamError(BaseModel):
    """A failed fetch; always followed by ``done`` with reason ``error``."""

    type: Literal["error"] = "error"
    message: str


class StreamPing(BaseModel):
    """Keep-alive after ~15s without other events; carries no data."""

    type: Literal["ping"] = "ping"


class StreamDone(BaseModel):
    """Last event."""

    type: Literal["done"] = "done"
    reason: DoneReason


StreamEvent = Annotated[
    StreamMeta
    | StreamNodes
    | StreamEdges
    | StreamTypes
    | StreamLabels
    | StreamProgress
    | StreamError
    | StreamPing
    | StreamDone,
    Field(discriminator="type"),
]
