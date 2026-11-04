# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""FastAPI entrypoint for the HKG graph-explorer backend.

Only the health probe lives here at F2. Endpoint cards (B2-B7) mount their own
routers under /api; the QLever client (B1) is the single SPARQL gateway.
"""

from fastapi import FastAPI

from app import contract, presets
from app.search import router as search_router
from app.settings import Settings

app = FastAPI(title="HKG Graph Explorer API", version="0.4.0.dev0")

app.include_router(search_router)


@app.get("/api/health")
def health() -> dict[str, object]:
    """Liveness probe reporting the active endpoint configuration."""
    settings = Settings.from_env()
    return {
        "status": "ok",
        "qlever_url": settings.qlever_url,
        "default_limit": settings.default_limit,
        "max_limit": settings.max_limit,
    }


@app.get("/api/config", response_model=contract.ConfigResponse)
def config() -> contract.ConfigResponse:
    """Renderer presets (palette/relations) derived from the pinned data model.

    Card B6: replaces the old bundled frontend config.yml — no YAML is read;
    see app.presets for the derivation rules.
    """
    return presets.build_config()
