# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Backend-only guard of the contract models.

No lock-step check against the frontend TypeScript types exists at the moment
(the frontend is being rebuilt); reintroduce one against the new frontend's
API types when they land.
"""

from __future__ import annotations

from app import contract


def test_config_response_exposes_graph_filter_config() -> None:
    assert "graph" in contract.ConfigResponse.model_fields
