# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""FastAPI entrypoint for the HKG graph-explorer backend.

The health and config probes live here; the search, stream and node routers
are mounted under /api. The QLever client is the single SPARQL gateway. The
guard middleware (TTL cache + rate limit) wraps all /api traffic, excluding
the health probe.
"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import bulk, contract, presets, stream
from app.middleware import ApiGuardMiddleware
from app.node import router as node_router
from app.search import router as search_router
from app.settings import Settings
from app.stream import router as stream_router


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Prewarm the default /api/stream snapshot; release workers on shutdown."""
    prewarm = stream.start_prewarm()
    try:
        yield
    finally:
        if prewarm:
            prewarm.cancel()
            await asyncio.gather(prewarm, return_exceptions=True)
        await stream.shutdown()
        bulk.shutdown_executor()


app = FastAPI(title="HKG Graph Explorer API", version="0.4.0.dev0", lifespan=lifespan)

app.add_middleware(ApiGuardMiddleware)
app.include_router(search_router)
app.include_router(stream_router)
app.include_router(node_router)


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
