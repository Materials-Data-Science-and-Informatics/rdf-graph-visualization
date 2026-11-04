# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Shared test fixtures.

The B7 guard middleware (TTL cache + rate limit) keeps process-wide state;
each test gets a fresh cache and full token buckets so suites never leak
429s or stale cache entries across tests.
"""

from __future__ import annotations

import pytest

from app import middleware


@pytest.fixture(autouse=True)
def reset_middleware_state():
    middleware.reset_state()
    yield
    middleware.reset_state()
