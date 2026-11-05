"""Wrappers mapping hkg_data_model.

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

The model classes come from the *pinned* hkg_data_model (GitLab tag, see
backend/pyproject.toml); app.presets derives its type-IRI groups from them.
"""

from __future__ import annotations

from typing import ClassVar

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

from app.contract import NodeType


class HkgEntityWrapper:
    """Maps one hkg_data_model class to its contract NodeType."""

    hkg_model: ClassVar[type[ThingModel]] = ThingModel
    node_type: ClassVar[NodeType] = "Unknown"


class PersonWrapper(HkgEntityWrapper):
    """Mapping for a validated ``PersonModel``."""

    hkg_model = PersonModel
    node_type = "Person"


class DatasetWrapper(HkgEntityWrapper):
    """Mapping for a validated ``DatasetModel``."""

    hkg_model = DatasetModel
    node_type = "Dataset"


class DocumentWrapper(HkgEntityWrapper):
    """Mapping for a validated ``DocumentModel``."""

    hkg_model = DocumentModel
    node_type = "Document"


class EventWrapper(HkgEntityWrapper):
    """Mapping for a validated ``EventModel``."""

    hkg_model = EventModel
    node_type = "Event"


class InstitutionWrapper(HkgEntityWrapper):
    """Mapping for a validated ``InstitutionModel``."""

    hkg_model = InstitutionModel
    node_type = "Institution"


class InstrumentWrapper(HkgEntityWrapper):
    """Mapping for a validated ``InstrumentModel``."""

    hkg_model = InstrumentModel
    node_type = "Instrument"


class SoftwareWrapper(HkgEntityWrapper):
    """Mapping for a validated ``SoftwareModel``."""

    hkg_model = SoftwareModel
    node_type = "Software"


class DataCatalogWrapper(HkgEntityWrapper):
    """Mapping for a validated ``DataCatalogModel``."""

    hkg_model = DataCatalogModel
    node_type = "DataCatalog"


class UnknownWrapper(HkgEntityWrapper):
    """Mapping for an entity of a type outside the HKG vocabulary."""

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
