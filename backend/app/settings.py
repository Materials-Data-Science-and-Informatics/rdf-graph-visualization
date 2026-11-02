"""Runtime settings for the graph-explorer API.

All configuration is environment-driven so the same image runs against the QLever
dev and prod endpoints without a rebuild (replaces the old build-time config.yml
import). Values match the deployment contract in graphviz-deployment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

# Default is the HKG QLever SPARQL endpoint that was verified live during
# research (POST, JSON/CSV). Dev deployments override this with the dev host.
DEFAULT_QLEVER_URL = "https://sparql.unhide.helmholtz-metadaten.de/sparql"


@dataclass(frozen=True)
class Settings:
    qlever_url: str
    request_timeout_s: float
    default_limit: int
    max_limit: int

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            qlever_url=os.environ.get("QLEVER_URL", DEFAULT_QLEVER_URL).rstrip("/"),
            request_timeout_s=float(os.environ.get("QLEVER_TIMEOUT_S", "30")),
            default_limit=int(os.environ.get("QLEVER_DEFAULT_LIMIT", "500")),
            max_limit=int(os.environ.get("QLEVER_MAX_LIMIT", "5000")),
        )
