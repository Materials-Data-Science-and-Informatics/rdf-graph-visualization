"""Card F6: pinned hkg_data_model integration + validated response wrappers.

DoD: one validated example per main class passes a test.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from app import hkg_wrappers
from app.hkg_wrappers import (
    DataCatalogWrapper,
    DatasetWrapper,
    DocumentWrapper,
    EventWrapper,
    InstitutionWrapper,
    InstrumentWrapper,
    PersonWrapper,
    SoftwareWrapper,
    UnknownWrapper,
)

FIXTURES = Path(__file__).parent / "fixtures" / "hkg"
SOURCE = "https://sparql.unhide.helmholtz-metadaten.de/sparql"

CASES = [
    ("person", "Person", PersonWrapper),
    ("dataset", "Dataset", DatasetWrapper),
    ("document", "Document", DocumentWrapper),
    ("event", "Event", EventWrapper),
    ("institution", "Institution", InstitutionWrapper),
    ("instrument", "Instrument", InstrumentWrapper),
    ("software", "Software", SoftwareWrapper),
    ("dataCatalog", "DataCatalog", DataCatalogWrapper),
]


@pytest.mark.parametrize(
    ("fixture", "expected_type", "wrapper_cls"),
    CASES,
    ids=[case[0] for case in CASES],
)
def test_one_validated_example_per_main_class(
    fixture: str,
    expected_type: str,
    wrapper_cls: type,
) -> None:
    """Each main hkg_data_model class validates one upstream example."""
    payload = json.loads((FIXTURES / f"{fixture}.min.example.json").read_text())
    wrapped = wrapper_cls.from_payload(payload, source=SOURCE)

    assert isinstance(wrapped.model, wrapper_cls.hkg_model)
    assert wrapped.node.type == expected_type
    assert wrapped.node.group == expected_type
    assert wrapped.node.id
    assert wrapped.node.label
    assert wrapped.node.purl is None

    # Only the frozen Node shape is serialized; the hkg model stays server-side.
    dumped = wrapped.model_dump(mode="json")
    assert set(dumped) == {"node"}
    assert dumped["node"]["type"] == expected_type
    assert hkg_wrappers.node_type_for(wrapped.model) == expected_type


def test_unknown_type_fallback() -> None:
    payload = {
        "@type": "MysteryThing",
        "name": "Mystery",
        "url": "https://example.org/mystery",
    }
    wrapped = UnknownWrapper.from_payload(payload, source=SOURCE)
    assert wrapped.node.type == "Unknown"
    assert hkg_wrappers.node_type_for(wrapped.model) == "Unknown"


def test_payload_type_mismatch_rejected() -> None:
    """A payload whose @type the class does not allow must fail validation."""
    payload = {"@type": "Person", "name": "John Doe"}
    with pytest.raises(ValidationError):
        DatasetWrapper.from_payload(payload, source=SOURCE)


def test_dependency_pinned_to_gitlab_tag() -> None:
    """pyproject.toml pins hkg_data_model to a GitLab tag, not a branch."""
    pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text()
    match = re.search(
        r'^\s*"hkg-data-model\s*@\s*(git\+https://[^\s"]+)"',
        pyproject,
        re.MULTILINE,
    )
    assert match, "pinned git dependency on hkg-data-model missing from pyproject.toml"
    url = match.group(1)
    assert "codebase.helmholtz.cloud" in url
    assert url.endswith("@1.1.0")
    assert "/main" not in url and "/development" not in url
