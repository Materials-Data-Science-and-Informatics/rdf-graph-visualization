# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Runtime settings for the graph-explorer API.

All configuration is environment-driven so the same image runs against the QLever
dev and prod endpoints without a rebuild (replaces the old build-time config.yml
import). Values match the deployment contract in graphviz-deployment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

# Default is the HKG QLever *dev* endpoint (B1: dev endpoint until shipping);
# deployments point QLEVER_URL at the prod endpoint later. Verified live during
# research (POST, JSON/CSV).
DEFAULT_QLEVER_URL = "https://sparql.unhide.helmholtz-metadaten.de/sparql"


@dataclass(frozen=True)
class Settings:
    """Environment-driven runtime settings (see module docstring)."""

    qlever_url: str
    request_timeout_s: float
    default_limit: int
    max_limit: int

    @classmethod
    def from_env(cls) -> Settings:
        """Build settings from the process environment (defaults in code)."""
        return cls(
            qlever_url=os.environ.get("QLEVER_URL", DEFAULT_QLEVER_URL).rstrip("/"),
            request_timeout_s=float(os.environ.get("QLEVER_TIMEOUT_S", "30")),
            default_limit=int(os.environ.get("QLEVER_DEFAULT_LIMIT", "500")),
            max_limit=int(os.environ.get("QLEVER_MAX_LIMIT", "5000")),
        )
