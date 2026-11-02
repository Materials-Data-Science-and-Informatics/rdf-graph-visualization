"""Renderer presets for ``/api/config``, derived from the pinned hkg_data_model (card B6).

This module replaces the old bundled ``frontend/config.yml``: every preset is
computed at request time from the *pinned* data-model classes (GitLab tag, see
``backend/pyproject.toml``). Nothing here reads YAML or any other config file,
so changing the pinned model changes the response — and the tests pin exactly
that behaviour against model tag 1.1.0.

Derivation rules (all mechanical, no hand-maintained IRI lists):

- ``types`` (palette): one preset per non-fallback data-model class exposed by
  the pinned model (via the F6 wrappers in ``app.hkg_wrappers``). The colour
  values keep the previous visual identity of the retired config.yml, but the
  *set* of palette entries is derived: ``_palette()`` raises if it drifts from
  the model's groups.
- ``relation_properties``: schema.org predicates whose field values can link to
  another entity or a URL, reflected from the entity models' field annotations
  (``list[X | Y]``, unions, ``Optional`` included). Structural JSON-LD fields
  (``@id``/``@type``/``@context``/source) and the entity's own identity/alias
  fields (url, sameAs, identifier, subjectOf) are not relations.
- ``label_properties``: the label-bearing fields declared on the pinned
  ``ThingModel`` (``prefName``, ``name``, ``identifier``) — the same chain the
  F6 wrappers use for display labels.
- ``skip_types``: schema.org types the pinned model classifies as *values*
  (value/data-type models), never rendered as nodes.
"""

from __future__ import annotations

import types
import typing

from hkg_data_model import DATA_MODELS  # type: ignore[import-untyped]
from hkg_data_model.pydantic.models.base_model import (  # type: ignore[import-untyped]
    BaseModel as HkgBaseModel,
)
from hkg_data_model.pydantic.models.property_value_model import (  # type: ignore[import-untyped]
    PropertyValueModel,
)
from hkg_data_model.pydantic.models.structured_value_model import (  # type: ignore[import-untyped]
    StructuredValueModel,
)
from hkg_data_model.pydantic.models.thing_model import (  # type: ignore[import-untyped]
    ThingModel,
)
from hkg_data_model.pydantic.types import TypeExtension  # type: ignore[import-untyped]
from pydantic import AnyHttpUrl, AnyUrl

from app import contract
from app.hkg_wrappers import WRAPPER_BY_NODE_TYPE

SCHEMA_ORG = "https://schema.org/"

_URL_TYPES: frozenset[type] = frozenset({AnyUrl, AnyHttpUrl})
_UNIONS: tuple[object, ...] = (
    (
        typing.Union,
        *(types.UnionType,),
    )
    if hasattr(types, "UnionType")
    else (typing.Union,)
)

# Structural JSON-LD / provenance fields — not schema.org predicates.
_NON_PROPERTY_FIELDS = frozenset({"context", "id", "source", "type"})
# Identity/alias fields: they point at the node itself, never at another node.
_NON_RELATION_FIELDS = frozenset({"identifier", "sameAs", "subjectOf", "url"})

# Label-bearing ThingModel fields, in display priority order (mirrors
# app.hkg_wrappers._to_node: prefName -> name -> id).
_LABEL_FIELDS = ("prefName", "name", "identifier")

# Value models: their type sets mark types that hold *values*, not entities.
_VALUE_MODELS: tuple[type, ...] = (StructuredValueModel, PropertyValueModel)

# Colour per pinned data-model class (previous visual identity of the retired
# config.yml). Keys must cover exactly the non-Unknown groups — enforced in
# _palette() so a model bump that adds/loses a class fails loudly at startup.
_PALETTE: dict[str, str] = {
    "DataCatalog": "#4B0082",
    "Dataset": "#0000FF",
    "Document": "#FFA500",
    "Event": "#00FFFF",
    "Institution": "#008000",
    "Instrument": "#A52A2A",
    "Software": "#FFFF00",
    "Person": "#FF0000",
}


def known_groups() -> tuple[contract.NodeType, ...]:
    """Non-fallback data-model classes of the pinned model, in contract order.

    Derived from the F6 wrappers (one per pinned model class); ``Unknown`` is
    the fallback for types outside the HKG vocabulary and is not a preset.
    """
    known = {group for group in WRAPPER_BY_NODE_TYPE if group != "Unknown"}
    return tuple(
        group for group in typing.get_args(contract.NodeType) if group in known
    )


def _contains_linked(tp: object) -> bool:
    """True if ``tp`` (or any union/list member) is an hkg entity or URL type."""
    origin = typing.get_origin(tp)
    args = typing.get_args(tp)
    if origin in _UNIONS:
        return any(_contains_linked(arg) for arg in args)
    if tp in _URL_TYPES:
        return True
    if isinstance(tp, type) and issubclass(tp, HkgBaseModel):
        return True
    return any(_contains_linked(arg) for arg in args)


def _relation_properties() -> list[str]:
    """schema.org predicates linking an entity to another entity or a URL."""
    found: set[str] = set()
    for model in DATA_MODELS:
        # ThingModel subclasses are the entity models; StructuredValueModel
        # inherits ThingModel too, but its fields describe *values*, not links.
        if not issubclass(model, ThingModel) or issubclass(model, StructuredValueModel):
            continue
        for name, field in model.model_fields.items():
            if name in _NON_PROPERTY_FIELDS or name in _NON_RELATION_FIELDS:
                continue
            if field.alias is not None and field.alias.startswith("@"):
                continue
            if _contains_linked(field.annotation):
                found.add(f"{SCHEMA_ORG}{name}")
    return sorted(found)


def _skip_types() -> list[str]:
    """Types the pinned model classifies as values (never rendered as nodes).

    Uses each value model's *own* TypeExtension set + BASE_TYPE — never the
    MRO-wide ``get_allowed_types()`` union, which would drag in ``Thing``.
    """
    type_names: set[str] = set()
    for model in _VALUE_MODELS:
        base_type: set[str] = getattr(model, "BASE_TYPE", set())
        type_names |= TypeExtension.get_for_model(model) | set(base_type)
    return sorted(f"{SCHEMA_ORG}{name}" for name in type_names)


def _palette() -> dict[str, str]:
    """Colour per known group, raising on drift from the pinned model."""
    groups = set(known_groups())
    missing = groups - set(_PALETTE)
    extra = set(_PALETTE) - groups
    if missing or extra:
        raise ValueError(
            "palette out of sync with pinned hkg_data_model: "
            f"missing={sorted(missing)} extra={sorted(extra)}"
        )
    return dict(_PALETTE)


def build_config() -> contract.ConfigResponse:
    """Assemble the frozen ``ConfigResponse`` from the pinned data model."""
    groups = known_groups()
    palette = _palette()
    return contract.ConfigResponse(
        relation_properties=_relation_properties(),
        label_properties=[f"{SCHEMA_ORG}{field}" for field in _LABEL_FIELDS],
        skip_types=_skip_types(),
        types=[
            contract.ConfigTypePreset(group=group, type=group, color=palette[group])
            for group in groups
        ],
    )
