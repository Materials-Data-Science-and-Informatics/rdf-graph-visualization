# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Unit tests for app.templates (card B8): query guards.

The endpoint test files exercise the happy paths of these helpers through
the API; this file pins the limit type-guard and floor.
"""

from __future__ import annotations

import pytest

from app import templates


@pytest.mark.parametrize("limit", [True, False, "10", 10.0])
def test_search_query_rejects_non_int_limit(limit: object) -> None:
    with pytest.raises(TypeError, match="limit must be an int"):
        templates.search_query(
            text="abc",
            label_iris=["https://x/l"],
            limit=limit,  # type: ignore[arg-type]
        )


def test_search_query_floors_limit_at_one() -> None:
    query = templates.search_query(text="abc", label_iris=["https://x/l"], limit=0)
    assert "LIMIT 1" in query
