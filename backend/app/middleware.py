# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Card B7: process-level TTL response cache + per-client rate limit.

A single ASGI middleware (:class:`ApiGuardMiddleware`, mounted in
``app.main``) sits between the HTTP surface and the endpoint routers and
protects the *shared* QLever endpoint from redundant and abusive traffic:

- **TTL cache** — a thread-safe in-memory TTL+LRU map keyed on
  ``path + canonical query string``. GET requests under ``/api/`` (except
  the ``/api/health`` liveness probe) are served straight from the cache on
  a hit, so a repeated call costs no QLever round-trip; only ``200``
  responses are stored. The client sees ``X-Cache: HIT`` / ``X-Cache: MISS``
  on every cacheable response (this card's DoD).
- **rate limit** — a per-client-IP token bucket with
  capacity = refill rate = ``HKG_RATE_LIMIT_PER_MIN`` requests/minute.
  A request without a free token gets ``429`` + integer-seconds
  ``Retry-After`` before it ever reaches a router. Cached hits still spend
  a token: the limiter bounds request volume to this process, not just
  backend load.

Policy is environment-driven, re-read per request (same convention as
``app.settings``), defaults in code:

- ``HKG_CACHE_TTL_S`` (default 60; <= 0 disables the cache)
- ``HKG_CACHE_MAX_ENTRIES`` (default 512)
- ``HKG_RATE_LIMIT_PER_MIN`` (default 120; <= 0 disables the limiter)

State is per-process (the API runs one uvicorn worker; with N workers the
limits scale by N). Downstream responses are buffered in memory before
re-emit — every API payload is small and bounded by its endpoint limits.
"""

from __future__ import annotations

import json
import math
import os
import threading
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

DEFAULT_CACHE_TTL_S = 60
DEFAULT_CACHE_MAX_ENTRIES = 512
DEFAULT_RATE_LIMIT_PER_MIN = 120
#: Bound on distinct client keys the limiter tracks (prune when exceeded).
DEFAULT_MAX_CLIENTS = 4096

Message = dict[str, Any]
Scope = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


def _int_env(name: str, default: int) -> int:
    """Env int with a *default* fallback on absence or typo.

    A misconfigured knob must degrade to the default, never take the whole
    API down with an exception raised in the middleware.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


class TTLCache:
    """Thread-safe in-memory TTL + LRU cache of (body, content-type) pairs."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, tuple[bytes, str, float]] = OrderedDict()

    def get(self, key: str) -> tuple[bytes, str] | None:
        """Value for *key*, or None when absent/expired (expired = dropped)."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            body, content_type, expires_at = entry
            if self._clock() >= expires_at:
                del self._entries[key]
                return None
            self._entries.move_to_end(key)
            return body, content_type

    def put(
        self,
        key: str,
        body: bytes,
        content_type: str,
        ttl_s: float,
        max_entries: int,
    ) -> None:
        """Store *body* under *key*; TTL<=0 is a no-op (cache disabled)."""
        if ttl_s <= 0:
            return
        with self._lock:
            while len(self._entries) >= max_entries:
                self._entries.popitem(last=False)  # evict least-recently used
            self._entries[key] = (body, content_type, self._clock() + ttl_s)
            self._entries.move_to_end(key)

    def clear(self) -> None:
        """Drop all entries."""
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        """Number of live (non-expired-checked) entries stored."""
        with self._lock:
            return len(self._entries)


class RateLimiter:
    """Per-key in-memory token bucket (thread-safe).

    Refill is computed lazily from the time since the last acquire. Buckets
    are pruned only while *full*: a full bucket is state-equivalent to no
    bucket, so dropping one can never grant extra requests; spent buckets
    are kept, or a client could re-earn its burst by waiting for eviction.
    """

    def __init__(self, max_clients: int = DEFAULT_MAX_CLIENTS) -> None:
        self._max_clients = max_clients
        self._lock = threading.Lock()
        self._buckets: dict[str, list[float]] = {}

    def try_acquire(self, key: str, per_min: float, now: float) -> tuple[bool, int]:
        """Consume one token for *key*; (allowed, retry_after_seconds)."""
        rate = per_min / 60.0
        capacity = float(per_min)
        with self._lock:
            if len(self._buckets) > self._max_clients:
                self._prune(capacity)
            bucket = self._buckets.get(key)
            if bucket is None:
                tokens = capacity
            else:
                tokens = min(capacity, bucket[0] + (now - bucket[1]) * rate)
            if tokens >= 1.0:
                self._buckets[key] = [tokens - 1.0, now]
                return True, 0
            self._buckets[key] = [tokens, now]
            # seconds until one full token refills (exact in per-min units)
            wait_s = (1.0 - tokens) * 60.0 / per_min
            return False, max(1, math.ceil(wait_s))

    def _prune(self, capacity: float) -> None:
        """Drop full buckets (safe); called only past the client cap."""
        stale = [k for k, (tokens, _) in self._buckets.items() if tokens >= capacity]
        for key in stale:
            del self._buckets[key]

    def reset(self) -> None:
        """Drop all buckets."""
        with self._lock:
            self._buckets.clear()

    def __len__(self) -> int:
        """Number of client buckets currently tracked."""
        with self._lock:
            return len(self._buckets)


_state_lock = threading.Lock()
# Lazily-built process-wide state; module globals are deliberate (see qlever).
_cache: TTLCache | None = None  # pylint: disable=invalid-name
_limiter: RateLimiter | None = None  # pylint: disable=invalid-name


def _get_cache() -> TTLCache:
    """Process-wide cache (created lazily on first guarded request)."""
    global _cache  # pylint: disable=global-statement
    with _state_lock:
        if _cache is None:
            _cache = TTLCache()
        return _cache


def _get_limiter() -> RateLimiter:
    """Process-wide rate limiter (created lazily on first guarded request)."""
    global _limiter  # pylint: disable=global-statement
    with _state_lock:
        if _limiter is None:
            _limiter = RateLimiter()
        return _limiter


def reset_state() -> None:
    """Clear cache + limiter state (unit tests; not a runtime operation)."""
    with _state_lock:
        if _cache is not None:
            _cache.clear()
        if _limiter is not None:
            _limiter.reset()


def _guard_path(path: str) -> bool:
    """True for guarded /api/ routes; the health probe is exempt."""
    return path.startswith("/api/") and path != "/api/health"


def _client_host(scope: Mapping[str, Any]) -> str:
    client = scope.get("client")
    return client[0] if client else "unknown"


def _cache_key(path: str, query_string: bytes) -> str:
    """Path + sorted raw query pairs (parameter-order-insensitive)."""
    if not query_string:
        return path
    pairs = sorted(query_string.split(b"&"))
    return f"{path}?{b'&'.join(pairs).decode('latin-1')}"


def _content_type(headers: list[tuple[bytes, bytes]]) -> str:
    for name, value in headers:
        if name.lower() == b"content-type":
            return value.decode("latin-1")
    return "application/json"


class _Buffered:
    """Collects a downstream ASGI response (status/headers/body) for re-emit."""

    def __init__(self) -> None:
        self.status: int | None = None
        self.headers: list[tuple[bytes, bytes]] = []
        self._chunks: list[bytes] = []

    async def send(self, message: Message) -> None:
        """ASGI send sink: records start headers and body chunks."""
        if message["type"] == "http.response.start":
            self.status = message["status"]
            self.headers = list(message.get("headers", []))
        elif message["type"] == "http.response.body":
            self._chunks.append(message.get("body", b""))

    @property
    def body(self) -> bytes:
        """The fully collected response body."""
        return b"".join(self._chunks)


async def _send_json(send: Send, status: int, detail: str, retry_after: int) -> None:
    """Emit the dialect-standard error body (see ``app.errors``)."""
    body = json.dumps({"detail": detail}).encode()
    headers = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode()),
        (b"retry-after", str(retry_after).encode()),
    ]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body, "more_body": False})


async def _send_cached(send: Send, cached: tuple[bytes, str]) -> None:
    body, content_type = cached
    headers = [
        (b"content-type", content_type.encode()),
        (b"content-length", str(len(body)).encode()),
        (b"x-cache", b"HIT"),
    ]
    await send({"type": "http.response.start", "status": 200, "headers": headers})
    await send({"type": "http.response.body", "body": body, "more_body": False})


class ApiGuardMiddleware:
    """ASGI middleware: per-client rate limit, then TTL cache for GET /api/*.

    Order per request: (1) rate-limit the client (429 + Retry-After when the
    bucket is dry), (2) serve GET requests from the TTL cache (X-Cache:
    HIT), (3) otherwise run the app, buffer the response, store 200s in the
    cache (X-Cache: MISS) and re-emit it.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] != "http" or not _guard_path(path):
            await self.app(scope, receive, send)
            return
        per_min = _int_env("HKG_RATE_LIMIT_PER_MIN", DEFAULT_RATE_LIMIT_PER_MIN)
        if per_min > 0:
            allowed, retry_after = _get_limiter().try_acquire(
                _client_host(scope), float(per_min), time.monotonic()
            )
            if not allowed:
                await _send_json(
                    send,
                    429,
                    "rate limit exceeded; wait the declared Retry-After",
                    retry_after,
                )
                return
        key = None
        if scope["method"] == "GET":
            key = _cache_key(path, scope.get("query_string") or b"")
            cached = _get_cache().get(key)
            if cached is not None:
                await _send_cached(send, cached)
                return
        buffered = _Buffered()
        await self.app(scope, receive, buffered.send)
        headers = list(buffered.headers)
        if key is not None and buffered.status == 200:
            ttl_s = float(_int_env("HKG_CACHE_TTL_S", DEFAULT_CACHE_TTL_S))
            max_entries = _int_env("HKG_CACHE_MAX_ENTRIES", DEFAULT_CACHE_MAX_ENTRIES)
            _get_cache().put(
                key, buffered.body, _content_type(headers), ttl_s, max_entries
            )
            headers.append((b"x-cache", b"MISS"))
        await send(
            {
                "type": "http.response.start",
                "status": buffered.status if buffered.status is not None else 500,
                "headers": headers,
            }
        )
        await send(
            {"type": "http.response.body", "body": buffered.body, "more_body": False}
        )
