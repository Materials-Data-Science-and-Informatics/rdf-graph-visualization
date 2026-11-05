# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""/api/stream snapshot cache: replay, single-flight, TTL, atomic writes, prewarm.

Uses the fake QLever client of ``test_stream`` (no network) and a temp cache dir.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import os
import threading
import time
from collections.abc import AsyncGenerator, AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from app import bulk, contract, qlever, snapshot, stream
from app.main import app
from tests.test_stream import FakeClient, R, run, url

EVENT = TypeAdapter(contract.StreamEvent)
KEY = (R, 1000, 6, 200)


@pytest.fixture()
def cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("STREAM_CACHE_TTL_S", "3600")
    monkeypatch.setenv("STREAM_CACHE_DIR", str(tmp_path))
    monkeypatch.setenv("DEFAULT_ROOT_IRI", R)  # the default root is always cached
    return tmp_path


@pytest.fixture()
def fake_client():
    cli = FakeClient()
    qlever.set_client(cli)
    yield cli
    qlever.reset_client()


def files(directory: Path) -> list[Path]:
    return sorted(directory.iterdir())


def rest(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return events[1:]


def test_miss_builds_then_hit_replays_identical_events(cache, fake_client) -> None:
    first, _ = run(url(max_hops=6))
    queries = len(fake_client.queries)
    assert queries > 0 and first[-1]["reason"] == "exhausted"
    assert "cached" not in first[0]
    assert [f.name for f in files(cache)] == [
        snapshot.path_for(cache, (R, 100000, 6, 200)).name
    ]  # hashed name, no leftovers

    second, resp = run(url(max_hops=6))
    assert len(fake_client.queries) == queries  # no QLever traffic on a hit
    assert resp.headers["content-type"].startswith("application/x-ndjson")
    assert rest(second) == rest(first)
    assert second[0]["cached"] is True
    assert (
        datetime.fromisoformat(second[0]["built_at"]).utcoffset().total_seconds() == 0
    )
    assert {k: second[0][k] for k in first[0]} == first[0]
    for event in second:
        EVENT.validate_python(event)
    # the effective (clamped) limits are the key: other limits are another entry
    run(url(max_hops=2))
    assert len(files(cache)) == 2


def test_replay_is_batched(cache, fake_client, monkeypatch) -> None:
    run(url())
    chunks = []

    async def go() -> None:
        replay = await snapshot.open_fresh(cache, (R, 100000, 6, 200), 3600)
        assert replay is not None
        chunks.extend([c async for c in replay])

    asyncio.run(go())
    assert len(chunks) == 1 and chunks[0].count(b"\n") > 5  # one write, many lines


@pytest.mark.parametrize(
    ("reason", "stored"),
    [
        ("exhausted", True),
        ("max_nodes", True),
        ("max_hops", True),
        ("truncated", True),
        ("error", False),
        ("time_budget", False),
    ],
)
def test_only_complete_runs_are_stored(cache, reason, stored) -> None:
    async def events() -> AsyncGenerator[dict[str, Any], None]:
        yield {"type": "meta", "root": R, "max_nodes": 1000, "max_hops": 6}
        yield {"type": "done", "reason": reason}

    async def go() -> None:
        build = snapshot.start_build(KEY, events, cache, 3600)
        assert build and build.task
        await build.task

    asyncio.run(go())
    assert bool(files(cache)) is stored


def test_failed_build_is_not_stored_and_not_replayed(cache) -> None:
    qlever.set_client(FakeClient(fail_on="CONSTRUCT"))
    try:
        events, _ = run(url())
    finally:
        qlever.reset_client()
    assert events[-1] == {"type": "done", "reason": "error"}
    assert files(cache) == []


def test_expired_snapshot_is_rebuilt(cache, fake_client) -> None:
    run(url())
    queries = len(fake_client.queries)
    (path,) = files(cache)
    old = time.time() - 7200
    os.utime(path, (old, old))  # older than the 3600 s TTL
    events, _ = run(url())
    assert len(fake_client.queries) == 2 * queries  # rebuilt
    assert "cached" not in events[0]
    assert time.time() - path.stat().st_mtime < 60  # swapped in a fresh file


def test_ttl_zero_disables_cache(cache, fake_client, monkeypatch) -> None:
    monkeypatch.setenv("STREAM_CACHE_TTL_S", "0")
    run(url())
    queries = len(fake_client.queries)
    run(url())
    assert len(fake_client.queries) == 2 * queries  # no replay
    assert files(cache) == []


def test_unreadable_snapshot_is_a_miss(cache, fake_client) -> None:
    path = snapshot.path_for(cache, (R, 100000, 6, 200))
    path.write_bytes(b"not gzip")
    events, _ = run(url())
    assert events[-1]["reason"] == "exhausted" and "cached" not in events[0]
    assert run(url())[0][0]["cached"] is True  # rebuilt file is good


def test_single_flight_two_subscribers_one_bfs(cache, monkeypatch) -> None:
    ref = FakeClient()
    qlever.set_client(ref)
    monkeypatch.setenv("STREAM_CACHE_TTL_S", "0")
    reference, _ = run(url())
    monkeypatch.setenv("STREAM_CACHE_TTL_S", "3600")
    single = len(ref.queries)

    gate = threading.Event()  # the BFS cannot progress until both attached
    cli = FakeClient(gate=gate)
    qlever.set_client(cli)

    async def get() -> list[dict[str, Any]]:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://t"
        ) as client:
            resp = await client.get(url())
        return [json.loads(line) for line in resp.text.splitlines()]

    async def go() -> tuple[Any, ...]:
        first = asyncio.create_task(get())
        while not snapshot._builds:  # pylint: disable=protected-access
            await asyncio.sleep(0.005)
        second = asyncio.create_task(get())  # attaches to the running build
        await asyncio.sleep(0.1)
        gate.set()
        return await asyncio.gather(first, second)

    try:
        one, two = asyncio.run(go())
    finally:
        gate.set()
        qlever.reset_client()
    assert len(cli.queries) == single  # exactly one BFS
    assert one == two  # same recorded stream, same order
    # interleaving of attrs vs nodes depends on timing: compare as multisets
    assert sorted(map(json.dumps, one)) == sorted(map(json.dumps, reference))
    assert len(files(cache)) == 1


def test_build_survives_subscriber_disconnect_and_is_stored(cache) -> None:
    cli = FakeClient(delay=0.05)
    qlever.set_client(cli)

    async def go() -> None:
        cfg = stream.Settings.from_env()
        build = stream._ensure_build(cfg, (R, 100000, 6, 200))  # pylint: disable=protected-access
        assert build and build.task
        gen = snapshot.follow(build, deadline=time.monotonic() + 30, heartbeat_s=5)
        await anext(gen)
        await gen.aclose()  # subscriber leaves early
        assert not build.finished
        await build.task

    try:
        asyncio.run(go())
    finally:
        qlever.reset_client()
    assert len(files(cache)) == 1


def test_subscriber_time_budget_ends_only_its_response(cache) -> None:
    async def events() -> AsyncGenerator[dict[str, Any], None]:
        yield {"type": "meta", "root": R, "max_nodes": 1000, "max_hops": 6}
        await asyncio.sleep(0.3)
        yield {"type": "done", "reason": "exhausted"}

    async def go() -> None:
        build = snapshot.start_build(KEY, events, cache, 3600)
        assert build and build.task
        lines = b"".join(
            [
                c
                async for c in snapshot.follow(
                    build, deadline=time.monotonic() + 0.05, heartbeat_s=0.02
                )
            ]
        )
        assert b'"ping"' in lines and lines.endswith(
            b'{"type":"done","reason":"time_budget"}\n'
        )
        await build.task
        assert build.reason == "exhausted"

    asyncio.run(go())
    assert len(files(cache)) == 1


def test_max_builds_cap_falls_back_to_uncached_stream(
    cache, fake_client, monkeypatch
) -> None:
    monkeypatch.setattr(snapshot, "MAX_BUILDS", 0)
    events, _ = run(url())
    assert events[-1]["reason"] == "exhausted"
    assert files(cache) == []


# -- atomic writes -----------------------------------------------------------------


def lines(reason: str) -> list[bytes]:
    return [
        snapshot.encode({"type": "meta", "root": R, "max_nodes": 1000, "max_hops": 6}),
        snapshot.encode({"type": "done", "reason": reason}),
    ]


def test_failed_write_leaves_old_snapshot_and_no_partial_file(
    cache, monkeypatch
) -> None:
    snapshot.write(cache, KEY, lines("exhausted"), 3600)
    (path,) = files(cache)
    before = path.read_bytes()

    def boom(*_a: Any) -> None:
        # the temp file is complete here, the final name still the old file
        assert len(files(cache)) == 2 and path.read_bytes() == before
        raise OSError("disk")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        snapshot.write(cache, KEY, lines("max_nodes"), 3600)
    assert files(cache) == [path] and path.read_bytes() == before  # no tmp left


def test_sweep_drops_expired_and_stale_tmp(cache) -> None:
    snapshot.write(cache, KEY, lines("exhausted"), 3600)
    (old,) = files(cache)
    stale = cache / ".x.tmp"
    stale.write_bytes(b"")
    past = time.time() - 7200
    for f in (old, stale):
        os.utime(f, (past, past))
    snapshot.write(cache, (R, 5, 1, 200), lines("exhausted"), 3600)
    assert [f.name for f in files(cache)] == [
        snapshot.path_for(cache, (R, 5, 1, 200)).name
    ]


# -- prewarm / lifespan --------------------------------------------------------------


def test_prewarm_disabled_by_default_in_tests(cache) -> None:
    assert stream.start_prewarm() is None  # STREAM_REFRESH_S=0 (conftest)


def test_prewarm_disabled_without_cache(monkeypatch) -> None:
    monkeypatch.setenv("STREAM_CACHE_TTL_S", "0")
    monkeypatch.setenv("STREAM_REFRESH_S", "10")
    assert stream.start_prewarm() is None


def test_refresh_default_and_clamp_stay_below_ttl(monkeypatch) -> None:
    monkeypatch.delenv("STREAM_REFRESH_S")
    monkeypatch.setenv("STREAM_CACHE_TTL_S", "100")
    assert stream.Settings.from_env().stream_refresh_s == pytest.approx(80)
    monkeypatch.setenv("STREAM_REFRESH_S", "500")
    assert stream.Settings.from_env().stream_refresh_s == pytest.approx(90)
    monkeypatch.setenv("STREAM_REFRESH_S", "0")
    assert stream.Settings.from_env().stream_refresh_s == 0


def test_invalid_settings_do_not_break_startup(monkeypatch) -> None:
    monkeypatch.setenv("STREAM_CACHE_TTL_S", "soon")
    assert stream.start_prewarm() is None


def test_prewarm_builds_default_snapshot_on_startup(
    cache, fake_client, monkeypatch
) -> None:
    monkeypatch.setenv("STREAM_REFRESH_S", "3600")
    monkeypatch.setenv("DEFAULT_ROOT_IRI", R)
    monkeypatch.setenv("DEFAULT_MAX_NODES", "1000")
    with TestClient(app) as client:
        deadline = time.monotonic() + 10
        while not files(cache) and time.monotonic() < deadline:
            time.sleep(0.02)
        assert files(cache)
        queries = len(fake_client.queries)
        resp = client.get(url(max_nodes=1000))  # the default view
        events = [json.loads(x) for x in resp.text.splitlines()]
        assert events[0]["cached"] is True and events[-1]["reason"] == "exhausted"
        assert len(fake_client.queries) == queries


def test_prewarm_skips_build_while_snapshot_is_fresh(
    cache, fake_client, monkeypatch
) -> None:
    run(url(max_nodes=1000))
    queries = len(fake_client.queries)
    monkeypatch.setenv("STREAM_REFRESH_S", "3600")
    monkeypatch.setenv("DEFAULT_ROOT_IRI", R)
    monkeypatch.setenv("DEFAULT_MAX_NODES", "1000")
    with TestClient(app):
        time.sleep(0.2)
    assert len(fake_client.queries) == queries


def test_prewarm_failure_never_crashes_the_app(cache, monkeypatch) -> None:
    qlever.set_client(FakeClient(fail_on="CONSTRUCT"))
    monkeypatch.setenv("STREAM_REFRESH_S", "3600")
    monkeypatch.setenv("DEFAULT_ROOT_IRI", R)
    monkeypatch.setattr(stream, "PREWARM_RETRY_S", 0.05)
    try:
        with TestClient(app) as client:
            time.sleep(0.3)  # failed build + at least one retry
            assert client.get("/api/health").status_code == 200
    finally:
        qlever.reset_client()
    assert files(cache) == []


def test_lifespan_shuts_down_executor_and_cancels_builds(cache, monkeypatch) -> None:
    executor = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(bulk, "_executor", executor)
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
        assert bulk._executor is executor  # pylint: disable=protected-access
    assert bulk._executor is None  # pylint: disable=protected-access
    with pytest.raises(RuntimeError):
        executor.submit(lambda: None)  # shut down


def test_shutdown_cancel_ends_subscribers_with_error(cache) -> None:
    async def events() -> AsyncGenerator[dict[str, Any], None]:
        yield {"type": "meta", "root": R, "max_nodes": 1000, "max_hops": 6}
        await asyncio.sleep(30)
        yield {"type": "done", "reason": "exhausted"}  # pragma: no cover

    async def go() -> bytes:
        build = snapshot.start_build(KEY, events, cache, 3600)
        assert build
        sub = asyncio.create_task(
            _drain(
                snapshot.follow(build, deadline=time.monotonic() + 30, heartbeat_s=5)
            )
        )
        await asyncio.sleep(0.05)
        await stream.shutdown()
        return await sub

    async def _drain(gen: AsyncIterator[bytes]) -> bytes:
        return b"".join([c async for c in gen])

    out = asyncio.run(go())
    assert out.endswith(b'{"type":"done","reason":"error"}\n')
    assert files(cache) == []


# -- wire format / bounds ------------------------------------------------------------


def test_gzip_client_gets_stored_bytes_that_decode_to_the_events(
    cache, fake_client
) -> None:
    run(url())  # build
    (path,) = files(cache)
    with TestClient(app) as client:
        with client.stream("GET", url(), headers={"Accept-Encoding": "gzip"}) as resp:
            raw = b"".join(resp.iter_raw())
        assert resp.headers["content-encoding"] == "gzip"
        assert resp.headers["content-length"] == str(len(raw))
        assert resp.headers["vary"] == "Accept-Encoding"
        assert resp.headers["cache-control"] == "no-store"
        assert raw == path.read_bytes()  # the file as is
        plain = client.get(url(), headers={"Accept-Encoding": "identity"})
        assert "content-encoding" not in plain.headers
    events = [json.loads(x) for x in gzip.decompress(raw).splitlines()]
    assert events == [json.loads(x) for x in plain.text.splitlines()]
    assert events[0]["cached"] is True and "built_at" in events[0]
    assert len(fake_client.queries) > 0 and events[-1]["reason"] == "exhausted"


def test_total_bytes_cap_evicts_oldest(cache) -> None:
    for i, hops in enumerate((1, 2, 3)):
        snapshot.write(cache, (R, 5, hops, 200), lines("exhausted"), 3600, 10**9)
        past = time.time() - 100 + i  # distinct, ascending mtimes
        os.utime(snapshot.path_for(cache, (R, 5, hops, 200)), (past, past))
    size = snapshot.path_for(cache, (R, 5, 3, 200)).stat().st_size
    snapshot.write(cache, (R, 5, 4, 200), lines("exhausted"), 3600, size * 2)
    assert {f.name for f in files(cache)} == {
        snapshot.path_for(cache, (R, 5, h, 200)).name for h in (3, 4)
    }


def test_non_default_root_is_cached_from_second_request(
    cache, fake_client, monkeypatch
) -> None:
    monkeypatch.setenv("DEFAULT_ROOT_IRI", "https://x.org/other")
    first, _ = run(url())
    assert files(cache) == [] and first[-1]["reason"] == "exhausted"  # live only
    second, _ = run(url())
    assert len(files(cache)) == 1 and "cached" not in second[0]  # built + stored
    third, _ = run(url())
    assert third[0]["cached"] is True


def test_prewarm_backs_off_when_the_write_fails(
    cache, fake_client, monkeypatch
) -> None:
    def boom(*_a: Any) -> None:
        raise OSError("disk full")

    started: list[int] = []
    real = snapshot.start_build

    def counting(*a: Any, **k: Any):
        started.append(1)
        return real(*a, **k)

    monkeypatch.setattr(snapshot, "write", boom)
    monkeypatch.setattr(snapshot, "start_build", counting)
    monkeypatch.setenv("STREAM_REFRESH_S", "3600")
    monkeypatch.setattr(stream, "PREWARM_RETRY_S", 30)
    with TestClient(app):
        time.sleep(0.4)
    assert len(started) == 1  # no hot rebuild loop
    assert files(cache) == []
