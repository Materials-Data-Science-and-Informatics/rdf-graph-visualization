"""Pinned hkg_data_model dependency guard."""

from __future__ import annotations

import re
from pathlib import Path


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
