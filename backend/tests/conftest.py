# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Shared test fixtures.

The B7 guard middleware (TTL cache + rate limit) keeps process-wide state;
each test gets a fresh cache and full token buckets so suites never leak
429s or stale cache entries across tests.
"""

from __future__ import annotations

import pytest

from app import middleware, snapshot


@pytest.fixture(autouse=True)
def reset_middleware_state():
    middleware.reset_state()
    yield
    middleware.reset_state()


@pytest.fixture(autouse=True)
def stream_cache_off(monkeypatch):
    """No snapshot cache / prewarm unless a test opts in (STREAM_CACHE_TTL_S)."""
    monkeypatch.setenv("STREAM_CACHE_TTL_S", "0")
    monkeypatch.setenv("STREAM_REFRESH_S", "0")
    monkeypatch.setenv("PREWARM_ROOTS", "")  # prewarm tests cover the default root only
    snapshot.reset_state()
    yield
    snapshot.reset_state()
