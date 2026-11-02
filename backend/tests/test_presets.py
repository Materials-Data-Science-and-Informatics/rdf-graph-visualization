"""Card B6: /api/config presets must be derived from the pinned hkg_data_model.

Nothing may come from YAML: the expected values below are pinned to the model
tag (1.1.0, see backend/pyproject.toml) and re-derived from the installed
package where possible, so a model bump that changes classes, relation fields
or value types updates the response and breaks these tests in the same commit.
"""

from __future__ import annotations

import inspect
import re

from fastapi.testclient import TestClient
from hkg_data_model import DATA_MODELS  # type: ignore[import-untyped]
from hkg_data_model.pydantic.models.structured_value_model import (  # type: ignore[import-untyped]
    StructuredValueModel,
)
from hkg_data_model.pydantic.models.thing_model import (  # type: ignore[import-untyped]
    ThingModel,
)

from app import contract, main, presets

# Pinned to hkg_data_model tag 1.1.0: every entity/URL-valued predicate on the
# entity models (verified against the installed package, 2026-11-02).
EXPECTED_RELATION_PROPERTIES = [
    "https://schema.org/affiliation",
    "https://schema.org/author",
    "https://schema.org/citation",
    "https://schema.org/codeRepository",
    "https://schema.org/contributor",
    "https://schema.org/creator",
    "https://schema.org/includedInDataCatalog",
    "https://schema.org/isPartOf",
    "https://schema.org/license",
    "https://schema.org/maintainer",
    "https://schema.org/organizer",
    "https://schema.org/parentOrganization",
    "https://schema.org/performer",
    "https://schema.org/provider",
    "https://schema.org/publisher",
    "https://schema.org/subOrganization",
]

EXPECTED_LABEL_PROPERTIES = [
    "https://schema.org/prefName",
    "https://schema.org/name",
    "https://schema.org/identifier",
]

# Value types of the pinned value models: values, never nodes.
EXPECTED_SKIP_TYPES = [
    "https://schema.org/Intangible",
    "https://schema.org/PropertyValue",
    "https://schema.org/StructuredValue",
]

# The eight data-model classes exposed by the pinned model (not the Unknown
# fallback), in frozen-contract NodeType order.
EXPECTED_GROUPS = [
    "DataCatalog",
    "Dataset",
    "Document",
    "Event",
    "Institution",
    "Instrument",
    "Software",
    "Person",
]


def test_presets_module_reads_no_yaml() -> None:
    """DoD: presets come from the pinned model, not YAML — no YAML anywhere."""
    assert "yaml" not in inspect.getsource(presets)


def test_relation_properties_match_pinned_model() -> None:
    assert presets.build_config().relation_properties == EXPECTED_RELATION_PROPERTIES


def test_every_relation_property_is_a_pinned_entity_field() -> None:
    """Independent check: each IRI names a real field on a pinned entity model."""
    entity_fields = {
        name
        for model in DATA_MODELS
        if issubclass(model, ThingModel) and not issubclass(model, StructuredValueModel)
        for name in model.model_fields
    }
    for iri in presets.build_config().relation_properties:
        assert iri.startswith("https://schema.org/")
        assert iri.rsplit("/", 1)[1] in entity_fields


def test_known_groups_match_pinned_model_wrappers() -> None:
    assert list(presets.known_groups()) == EXPECTED_GROUPS
    assert "Unknown" not in presets.known_groups()


def test_label_properties_are_thing_model_fields() -> None:
    label_properties = presets.build_config().label_properties
    assert label_properties == EXPECTED_LABEL_PROPERTIES
    for iri in label_properties:
        assert iri.rsplit("/", 1)[1] in ThingModel.model_fields


def test_skip_types_match_pinned_value_models() -> None:
    skip_types = presets.build_config().skip_types
    assert skip_types == EXPECTED_SKIP_TYPES
    # The MRO-wide allowed-types union drags in "Thing" (root of every entity);
    # guarding that the derivation never skips real entities.
    assert "https://schema.org/Thing" not in skip_types


def test_config_response_shape_and_determinism() -> None:
    first = presets.build_config()
    assert isinstance(first, contract.ConfigResponse)
    # Deterministic: same input model -> identical payload.
    assert first.model_dump() == presets.build_config().model_dump()

    groups = [preset.group for preset in first.types]
    assert groups == EXPECTED_GROUPS  # one preset per class, contract order
    assert len(set(groups)) == len(groups)
    for preset in first.types:
        assert preset.type == preset.group
        assert re.fullmatch(r"#[0-9A-Fa-f]{6}", preset.color)
    # All four sections non-empty; no duplicates.
    for section in (
        first.relation_properties,
        first.label_properties,
        first.skip_types,
    ):
        assert section
        assert len(set(section)) == len(section)


def test_api_config_endpoint() -> None:
    client = TestClient(main.app)
    response = client.get("/api/config")
    assert response.status_code == 200
    assert response.json() == presets.build_config().model_dump()
