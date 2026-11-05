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
from pathlib import Path

# Default is the HKG QLever *dev* endpoint (B1: dev endpoint until shipping);
# deployments point QLEVER_URL at the prod endpoint later. Verified live during
# research (POST, JSON/CSV).
DEFAULT_QLEVER_URL = "https://sparql.unhide.helmholtz-metadaten.de/sparql"
#: Backend-local snapshot cache dir (git-ignored); containers set STREAM_CACHE_DIR.
DEFAULT_STREAM_CACHE_DIR = str(
    Path(__file__).resolve().parents[1] / ".cache" / "stream"
)
DEFAULT_ROOT_IRI = "https://ror.org/0281dp749"
#: Root presets whose default view is prewarmed: the Helmholtz Association and its
#: 18 centres (ROR; same list as the frontend's ``lib/centers.ts``).
HELMHOLTZ_CENTRE_IRIS = (
    "https://ror.org/032e6b942",  # AWI
    "https://ror.org/02njgxr09",  # CISPA
    "https://ror.org/01js2sh04",  # DESY
    "https://ror.org/04cdgtt98",  # DKFZ
    "https://ror.org/04bwf3e34",  # DLR
    "https://ror.org/043j0f473",  # DZNE
    "https://ror.org/02nv7yv05",  # FZJ
    "https://ror.org/02h2x0161",  # GEOMAR
    "https://ror.org/04z8jg394",  # GFZ
    "https://ror.org/02k8cbn47",  # GSI
    "https://ror.org/00cfam450",  # Helmholtz Munich
    "https://ror.org/03qjp1d79",  # Hereon
    "https://ror.org/02aj13c28",  # HZB
    "https://ror.org/01zy2cs03",  # HZDR
    "https://ror.org/03d0p2685",  # HZI
    "https://ror.org/04t3en479",  # KIT
    "https://ror.org/04p5ggc03",  # MDC
    "https://ror.org/000h6jb29",  # UFZ
)


@dataclass(frozen=True)
class Settings:  # pylint: disable=too-many-instance-attributes
    """Environment-driven runtime settings (see module docstring)."""

    qlever_url: str
    request_timeout_s: float
    default_limit: int
    max_limit: int
    qlever_concurrency: int = 4
    #: /api/stream ceilings (query params are clamped to these) and switch
    #: between the one-query-per-chunk and per-relation edge templates.
    stream_max_nodes: int = 100_000
    stream_max_hops: int = 8
    stream_max_time_budget_s: float = 300.0
    stream_multi_relation: bool = True
    #: Max new neighbours taken per node and hop (0 = no cap): spends the node
    #: budget on deeper hops instead of one hub's leaves.
    stream_default_fanout: int = 200
    stream_max_fanout: int = 100_000
    #: /api/stream snapshot cache (see ``app.snapshot``): TTL <= 0 disables it
    #: (and the prewarm); the prewarm rebuilds the default view every
    #: ``stream_refresh_s`` (default 0.8 * TTL, clamped to <= 0.9 * TTL so the old
    #: snapshot cannot expire before the rebuild finishes; 0 disables it).
    stream_cache_dir: str = DEFAULT_STREAM_CACHE_DIR
    stream_cache_ttl_s: float = 6 * 3600.0
    stream_refresh_s: float = 0.8 * 6 * 3600.0
    stream_cache_max_bytes: int = 1 << 30
    default_root_iri: str = DEFAULT_ROOT_IRI
    #: Node budget of the prewarmed snapshots: the frontend's default fetch bucket (5000 nodes).
    default_max_nodes: int = 5_000
    #: Extra roots prewarmed after the default root (PREWARM_ROOTS, comma-separated).
    prewarm_roots: tuple[str, ...] = HELMHOLTZ_CENTRE_IRIS

    @classmethod
    def from_env(cls) -> Settings:
        """Build settings from the process environment (defaults in code)."""
        ttl = float(os.environ.get("STREAM_CACHE_TTL_S", str(6 * 3600)))
        refresh = float(os.environ.get("STREAM_REFRESH_S", str(0.8 * ttl)))
        if ttl > 0 and refresh > 0:
            refresh = min(refresh, 0.9 * ttl)
        return cls(
            qlever_url=os.environ.get("QLEVER_URL", DEFAULT_QLEVER_URL).rstrip("/"),
            request_timeout_s=float(os.environ.get("QLEVER_TIMEOUT_S", "30")),
            default_limit=int(os.environ.get("QLEVER_DEFAULT_LIMIT", "500")),
            max_limit=int(os.environ.get("QLEVER_MAX_LIMIT", "5000")),
            qlever_concurrency=max(1, int(os.environ.get("QLEVER_CONCURRENCY", "4"))),
            stream_max_nodes=max(1, int(os.environ.get("STREAM_MAX_NODES", "100000"))),
            stream_max_hops=max(0, int(os.environ.get("STREAM_MAX_HOPS", "8"))),
            stream_max_time_budget_s=max(
                1.0, float(os.environ.get("STREAM_MAX_TIME_BUDGET_S", "300"))
            ),
            stream_multi_relation=os.environ.get("STREAM_MULTI_RELATION", "1")
            not in ("0", "false", "no"),
            stream_default_fanout=max(0, int(os.environ.get("STREAM_FANOUT", "200"))),
            stream_cache_dir=os.environ.get("STREAM_CACHE_DIR")
            or DEFAULT_STREAM_CACHE_DIR,
            stream_cache_ttl_s=ttl,
            stream_refresh_s=refresh,
            stream_cache_max_bytes=max(
                0, int(os.environ.get("STREAM_CACHE_MAX_BYTES", str(1 << 30)))
            ),
            default_root_iri=os.environ.get("DEFAULT_ROOT_IRI", DEFAULT_ROOT_IRI),
            default_max_nodes=max(1, int(os.environ.get("DEFAULT_MAX_NODES", "5000"))),
            prewarm_roots=tuple(
                r.strip()
                for r in os.environ.get(
                    "PREWARM_ROOTS", ",".join(HELMHOLTZ_CENTRE_IRIS)
                ).split(",")
                if r.strip()
            ),
        )
