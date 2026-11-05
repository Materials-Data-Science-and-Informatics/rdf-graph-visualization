# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Unit tests for the B7 guard middleware (TTL cache + per-client rate limit).

All QLever traffic is replayed through ``httpx.MockTransport`` — no network.
Coverage: the visible DoD (repeat call served from cache with
``X-Cache: HIT`` and no second QLever round-trip), cache keying
(query-order-insensitive, distinct queries miss), TTL disable/expiry,
LRU eviction, non-200s never cached, health-probe exemption, 429 +
``Retry-After`` on bucket exhaustion, cache hits spending tokens,
limiter disable (<=0), malformed env fallback, and the token-bucket
refill/prune rules.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import middleware, qlever
from app.main import app
from app.middleware import RateLimiter, TTLCache
from app.qlever import QleverClient

DEV_URL = "https://sparql.unhide.helmholtz-metadaten.de/sparql"
CENTER = "https://doi.org/10.1234/dataset123"
TYPE_DATASET = "https://schema.org/Dataset"
SEARCH_PATH = "/api/search?q=data"


def uri(value: str) -> dict[str, str]:
    return {"type": "uri", "value": value}


def lit(value: str) -> dict[str, str]:
    return {"type": "literal", "value": value}


def sparql_response(*rows: dict[str, Any]) -> httpx.Response:
    """Build a sparql-results+json body from raw binding dicts."""
    return httpx.Response(
        200,
        json={
            "head": {"vars": sorted({k for row in rows for k in row})},
            "results": {"bindings": list(rows)},
        },
    )


def dataset_entity() -> httpx.Response:
    """A minimal 200 /api/search payload (one Dataset hit)."""
    return sparql_response(
        {
            "node": uri(CENTER),
            "nodeType": uri(TYPE_DATASET),
            "lbl": uri("https://schema.org/name"),
            "label": lit("Dataset name"),
        }
    )


@pytest.fixture()
def mock_qlever():
    """Install a QleverClient whose transport yields scripted responses."""
    state: dict[str, Any] = {"responses": [], "requests": []}

    def handler(request: httpx.Request) -> httpx.Response:
        state["requests"].append(request)
        return state["responses"].pop(0)

    client = QleverClient(DEV_URL, transport=httpx.MockTransport(handler))
    qlever.set_client(client)
    yield state
    qlever.reset_client()


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


# -- TTL cache: repeat call -> visible HIT ------------------------------------


def test_repeat_get_is_cache_hit_without_qlever_roundtrip(mock_qlever, client):
    mock_qlever["responses"] = [dataset_entity()]
    first = client.get(SEARCH_PATH)
    assert first.status_code == 200
    assert first.headers["x-cache"] == "MISS"
    second = client.get(SEARCH_PATH)
    assert second.status_code == 200
    assert second.headers["x-cache"] == "HIT"
    # the DoD: the hit is visible in the header and costs no QLever traffic
    assert len(mock_qlever["requests"]) == 1
    assert second.json() == first.json()


def test_cache_hit_preserves_body_and_content_type(mock_qlever, client):
    mock_qlever["responses"] = [dataset_entity()]
    first = client.get(SEARCH_PATH)
    second = client.get(SEARCH_PATH)
    assert second.headers["content-type"].startswith("application/json")
    assert int(second.headers["content-length"]) == len(second.content)
    assert second.content == first.content


def test_config_endpoint_is_cached_like_any_get(client):
    first = client.get("/api/config")
    second = client.get("/api/config")
    assert first.status_code == 200
    assert first.headers["x-cache"] == "MISS"
    assert second.headers["x-cache"] == "HIT"


# -- cache keying --------------------------------------------------------------


def test_cache_key_is_query_order_insensitive(mock_qlever, client):
    mock_qlever["responses"] = [dataset_entity(), dataset_entity()]
    first = client.get("/api/search?q=data&x=1")
    assert first.status_code == 200
    assert first.headers["x-cache"] == "MISS"
    second = client.get("/api/search?x=1&q=data")
    assert second.status_code == 200
    assert second.headers["x-cache"] == "HIT"
    assert len(mock_qlever["requests"]) == 1


def test_distinct_query_is_cache_miss(mock_qlever, client):
    mock_qlever["responses"] = [dataset_entity(), dataset_entity()]
    first = client.get("/api/search?q=data")
    second = client.get("/api/search?q=other")
    assert first.headers["x-cache"] == "MISS"
    assert second.headers["x-cache"] == "MISS"
    assert len(mock_qlever["requests"]) == 2


def test_zero_ttl_disables_cache(mock_qlever, client, monkeypatch):
    monkeypatch.setenv("HKG_CACHE_TTL_S", "0")
    mock_qlever["responses"] = [dataset_entity(), dataset_entity()]
    first = client.get(SEARCH_PATH)
    second = client.get(SEARCH_PATH)
    assert first.headers["x-cache"] == "MISS"
    assert second.headers["x-cache"] == "MISS"
    assert len(mock_qlever["requests"]) == 2


def test_non_200_responses_are_not_cached(mock_qlever, client):
    # first call: upstream 500 -> 502; second: upstream recovered -> 200
    mock_qlever["responses"] = [httpx.Response(500, text="boom"), dataset_entity()]
    first = client.get(SEARCH_PATH)
    assert first.status_code == 502
    assert "x-cache" not in first.headers
    second = client.get(SEARCH_PATH)
    assert second.status_code == 200
    assert second.headers["x-cache"] == "MISS"  # the 502 was not stored
    assert len(mock_qlever["requests"]) == 2


# -- health-probe exemption ----------------------------------------------------


def test_health_is_never_cached_nor_rate_limited(mock_qlever, client, monkeypatch):
    monkeypatch.setenv("HKG_RATE_LIMIT_PER_MIN", "1")
    assert client.get("/api/health").status_code == 200
    mock_qlever["responses"] = [dataset_entity()]
    assert client.get(SEARCH_PATH).status_code == 200  # spends the one token
    # health stays up even with the bucket dry, and is never cached
    third = client.get("/api/health")
    assert third.status_code == 200
    assert "x-cache" not in third.headers


# -- rate limit -----------------------------------------------------------------


def test_rate_limit_429_with_retry_after(mock_qlever, client, monkeypatch):
    monkeypatch.setenv("HKG_RATE_LIMIT_PER_MIN", "2")
    mock_qlever["responses"] = [dataset_entity()]
    assert client.get(SEARCH_PATH).status_code == 200  # token 2 -> 1
    assert client.get(SEARCH_PATH).status_code == 200  # token 1 -> 0 (HIT)
    limited = client.get(SEARCH_PATH)  # bucket dry
    assert limited.status_code == 429
    assert "x-cache" not in limited.headers  # no cache header on the 429
    assert "detail" in limited.json()
    retry_after = int(limited.headers["retry-after"])
    assert 1 <= retry_after <= 30  # 1 minute for one token at 2/min


def test_rate_limit_counts_cache_hits(mock_qlever, client, monkeypatch):
    monkeypatch.setenv("HKG_RATE_LIMIT_PER_MIN", "2")
    mock_qlever["responses"] = [dataset_entity(), dataset_entity()]
    assert client.get(SEARCH_PATH).status_code == 200  # MISS
    hit = client.get(SEARCH_PATH)
    assert hit.headers["x-cache"] == "HIT"  # hits still spend a token
    assert client.get(SEARCH_PATH).status_code == 429
    assert len(mock_qlever["requests"]) == 1


def test_rate_limit_disabled_when_nonpositive(client, monkeypatch):
    monkeypatch.setenv("HKG_RATE_LIMIT_PER_MIN", "0")
    for _ in range(4):
        assert client.get("/api/config").status_code == 200


def test_malformed_env_falls_back_to_default(client, monkeypatch):
    monkeypatch.setenv("HKG_RATE_LIMIT_PER_MIN", "not-an-int")
    for _ in range(4):  # default is 120/min — no 429 here
        assert client.get("/api/config").status_code == 200


# -- TTLCache unit tests (explicit clock) ----------------------------------------


def _clock() -> list[float]:
    return [0.0]


def test_ttl_cache_expires_after_ttl():
    clock = _clock()
    cache = TTLCache(clock=lambda: clock[0])
    cache.put("k", b"body", "application/json", ttl_s=10, max_entries=4)
    clock[0] = 9.9
    assert cache.get("k") == (b"body", "application/json")
    clock[0] = 10.0
    assert cache.get("k") is None
    assert len(cache) == 0  # expired entries are dropped on access


def test_ttl_cache_lru_eviction_oldest_first():
    clock = _clock()
    cache = TTLCache(clock=lambda: clock[0])
    cache.put("a", b"1", "t", ttl_s=100, max_entries=2)
    cache.put("b", b"2", "t", ttl_s=100, max_entries=2)
    assert cache.get("a") is not None  # touch "a" so "b" becomes oldest
    cache.put("c", b"3", "t", ttl_s=100, max_entries=2)
    assert cache.get("b") is None  # "b" evicted
    assert cache.get("a") is not None
    assert cache.get("c") is not None
    assert len(cache) == 2


def test_ttl_cache_zero_ttl_is_noop():
    cache = TTLCache()
    cache.put("k", b"body", "t", ttl_s=0, max_entries=4)
    assert cache.get("k") is None
    assert len(cache) == 0


# -- RateLimiter unit tests (explicit time) ---------------------------------------


def test_token_bucket_refills_over_time():
    limiter = RateLimiter()
    # 2/min: capacity 2, refill 1 token per 30 s
    assert limiter.try_acquire("ip", 2.0, now=0.0) == (True, 0)
    assert limiter.try_acquire("ip", 2.0, now=0.0) == (True, 0)
    allowed, retry_after = limiter.try_acquire("ip", 2.0, now=0.0)
    assert allowed is False
    assert retry_after == 30
    assert limiter.try_acquire("ip", 2.0, now=29.0) == (False, 1)
    assert limiter.try_acquire("ip", 2.0, now=31.0) == (True, 0)  # refilled


def test_token_bucket_is_per_client():
    limiter = RateLimiter()
    assert limiter.try_acquire("a", 1.0, now=0.0) == (True, 0)
    assert limiter.try_acquire("a", 1.0, now=0.0) == (False, 60)
    assert limiter.try_acquire("b", 1.0, now=0.0) == (True, 0)  # other key: fresh


def test_prune_keeps_spent_buckets():
    limiter = RateLimiter(max_clients=1)
    # 1/min: capacity 1 — each acquire below fully spends its bucket
    limiter.try_acquire("a", 1.0, now=0.0)
    limiter.try_acquire("b", 1.0, now=0.0)
    limiter.try_acquire("c", 1.0, now=0.0)  # forces a prune pass
    # spent buckets must survive pruning, or clients could re-earn their burst
    assert limiter.try_acquire("a", 1.0, now=0.0) == (False, 60)


def test_reset_clears_all_state():
    middleware.reset_state()
    assert middleware.reset_state() is None  # safe before lazy init
