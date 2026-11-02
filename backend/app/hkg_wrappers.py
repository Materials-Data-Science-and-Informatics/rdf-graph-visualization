"""Pydantic response wrappers over hkg_data_model (card F6).

Each main hkg_data_model class maps 1:1 to a NodeType in app.contract:

    PersonModel      -> "Person"
    DatasetModel     -> "Dataset"
    DocumentModel    -> "Document"
    EventModel       -> "Event"
    InstitutionModel -> "Institution"
    InstrumentModel  -> "Instrument"
    SoftwareModel    -> "Software"
    DataCatalogModel -> "DataCatalog"
    UnknownTypeModel -> "Unknown"

The wrappers validate a raw JSON-LD payload against the *pinned*
hkg_data_model (GitLab tag, see backend/pyproject.toml), then expose only the
frozen API shape (contract.Node) — raw JSON-LD never leaks into responses.
Endpoint cards (B2–B7) build responses via ``XxxWrapper.from_payload``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, ClassVar

from hkg_data_model import (  # type: ignore[import-untyped]
    DataCatalogModel,
    DatasetModel,
    DocumentModel,
    EventModel,
    InstitutionModel,
    InstrumentModel,
    PersonModel,
    SoftwareModel,
    UnknownTypeModel,
)
from hkg_data_model.pydantic.models.thing_model import (  # type: ignore[import-untyped]
    ThingModel,
)
from pydantic import BaseModel, Field

from app.contract import Node, NodeType
from app.settings import Settings


def _to_node(model: ThingModel, node_type: NodeType) -> Node:
    """Map a validated hkg_data_model entity to the frozen API Node shape."""
    entity_id = model.id or ""
    label = model.prefName or model.name or entity_id
    return Node(
        id=entity_id,
        label=label,
        type=node_type,
        group=node_type,
    )


class HkgEntityWrapper(BaseModel):
    """A validated hkg_data_model entity as an API response payload.

    ``node`` is what clients receive; ``model`` keeps the validated
    hkg_data_model instance for server-side use (linked-entity expansion,
    property lookup in later cards) and is excluded from serialization.
    """

    node: Node
    model: ThingModel = Field(exclude=True)

    hkg_model: ClassVar[type[ThingModel]] = ThingModel
    node_type: ClassVar[NodeType] = "Unknown"

    @classmethod
    def from_payload(
        cls,
        payload: Mapping[str, Any],
        *,
        source: str | None = None,
    ) -> HkgEntityWrapper:
        """Validate a raw JSON-LD dict via the pinned hkg_data_model class.

        ``source`` attributes the record (hkg_data_model requires one); it
        defaults to the configured QLever endpoint. Raises
        pydantic.ValidationError on payloads the class rejects.
        """
        source = source or Settings.from_env().qlever_url
        validated = cls.hkg_model.model_validate(payload, context={"source": source})
        return cls(node=_to_node(validated, cls.node_type), model=validated)


class PersonWrapper(HkgEntityWrapper):
    """Response wrapper for a validated ``PersonModel``."""

    hkg_model = PersonModel
    node_type = "Person"


class DatasetWrapper(HkgEntityWrapper):
    """Response wrapper for a validated ``DatasetModel``."""

    hkg_model = DatasetModel
    node_type = "Dataset"


class DocumentWrapper(HkgEntityWrapper):
    """Response wrapper for a validated ``DocumentModel``."""

    hkg_model = DocumentModel
    node_type = "Document"


class EventWrapper(HkgEntityWrapper):
    """Response wrapper for a validated ``EventModel``."""

    hkg_model = EventModel
    node_type = "Event"


class InstitutionWrapper(HkgEntityWrapper):
    """Response wrapper for a validated ``InstitutionModel``."""

    hkg_model = InstitutionModel
    node_type = "Institution"


class InstrumentWrapper(HkgEntityWrapper):
    """Response wrapper for a validated ``InstrumentModel``."""

    hkg_model = InstrumentModel
    node_type = "Instrument"


class SoftwareWrapper(HkgEntityWrapper):
    """Response wrapper for a validated ``SoftwareModel``."""

    hkg_model = SoftwareModel
    node_type = "Software"


class DataCatalogWrapper(HkgEntityWrapper):
    """Response wrapper for a validated ``DataCatalogModel``."""

    hkg_model = DataCatalogModel
    node_type = "DataCatalog"


class UnknownWrapper(HkgEntityWrapper):
    """Response wrapper for an entity of a type outside the HKG vocabulary."""

    hkg_model = UnknownTypeModel
    node_type = "Unknown"


WRAPPER_BY_NODE_TYPE: dict[NodeType, type[HkgEntityWrapper]] = {
    wrapper.node_type: wrapper
    for wrapper in (
        PersonWrapper,
        DatasetWrapper,
        DocumentWrapper,
        EventWrapper,
        InstitutionWrapper,
        InstrumentWrapper,
        SoftwareWrapper,
        DataCatalogWrapper,
        UnknownWrapper,
    )
}


def node_type_for(model: ThingModel) -> NodeType:
    """Contract NodeType for an already-validated hkg_data_model instance."""
    for wrapper in WRAPPER_BY_NODE_TYPE.values():
        if isinstance(model, wrapper.hkg_model):
            return wrapper.node_type
    return "Unknown"
