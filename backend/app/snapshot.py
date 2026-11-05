# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Snapshot cache + single-flight builds behind ``/api/stream``.

Key = ``(root, effective max_nodes, effective max_hops, effective max_fanout)``. A run that ends
with a ``done`` reason in ``CACHEABLE`` is stored as gzip NDJSON (the recorded
events, ``ping`` excluded) in ``STREAM_CACHE_DIR``; ``error``/``time_budget``
runs are never stored. Files are written to a temp name and renamed
(``os.replace``), so a reader sees the old or the new snapshot, never a
partial one; a refresh therefore swaps atomically while readers keep getting
the old file. A snapshot older than the TTL is a miss.

Single-flight: one ``Build`` per key records its encoded lines in memory;
every request for a key that is being built attaches to it (replays the
recorded lines, then tails new ones until ``done``), so there is never a
second BFS. Disconnect policy: a build is shared state and keeps running to
completion even when all subscribers leave (bounded by its time budget and
``MAX_BUILDS``), so the snapshot still gets written; only app shutdown cancels
builds. The recorded lines of a build are held in memory until it ends
(roughly the size of the response; bounded by ``max_nodes``); at most
``MAX_BUILDS`` run at once (further requests stream uncached).
"""

from __future__ import annotations

import asyncio
import contextlib
import gzip
import hashlib
import json
import logging
import os
import time
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

log = logging.getLogger("uvicorn.error")  # same handlers as the server log

Event = dict[str, Any]
Key = tuple[str, int, int, int]

CACHEABLE = frozenset({"exhausted", "max_nodes", "max_hops", "truncated"})
#: Concurrent builds (distinct keys) per process.
MAX_BUILDS = 4
#: Snapshot files kept on disk (oldest evicted on write).
MAX_FILES = 200
#: Default cap on the total size of the snapshot files (``write``'s *max_bytes*).
MAX_BYTES = 1 << 30
#: Distinct non-default keys remembered for the "second request" rule.
MAX_SEEN = 10_000
#: A written/replayed chunk is flushed at this size or line count.
FLUSH_BYTES = 256 * 1024
FLUSH_LINES = 512
SUFFIX = ".ndjson.gz"


def encode(event: Event) -> bytes:
    """One NDJSON line."""
    return json.dumps(event, separators=(",", ":")).encode() + b"\n"


def path_for(cache_dir: str | Path, key: Key) -> Path:
    """Snapshot file of *key* (hash of the key, never the raw IRI)."""
    digest = hashlib.sha256(json.dumps(key).encode()).hexdigest()[:40]
    return Path(cache_dir) / f"{digest}{SUFFIX}"


def age_s(cache_dir: str | Path, key: Key) -> float | None:
    """Seconds since the snapshot of *key* was written, ``None`` if absent."""
    try:
        return max(0.0, time.time() - path_for(cache_dir, key).stat().st_mtime)
    except OSError:
        return None


# -- storage -----------------------------------------------------------------------


def write(
    cache_dir: str | Path,
    key: Key,
    lines: list[bytes],
    ttl_s: float,
    max_bytes: int = MAX_BYTES,
) -> None:
    """Atomically store *lines* (first line = meta, gets ``cached``/``built_at``).

    The stored meta already carries ``cached: true``, so the gzip file can be
    sent to a client as is (see ``stream``).
    """
    path = path_for(cache_dir, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    meta = json.loads(lines[0])
    meta["cached"] = True
    meta["built_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with gzip.open(tmp, "wb", compresslevel=5) as out:
            out.write(encode(meta))
            for line in lines[1:]:
                out.write(line)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    try:
        _sweep(path.parent, ttl_s, max_bytes)
    except Exception:  # pylint: disable=broad-exception-caught
        log.warning("stream snapshot sweep failed", exc_info=True)


def _sweep(directory: Path, ttl_s: float, max_bytes: int) -> None:
    """Drop expired snapshots and stale temp files; then the oldest beyond
    ``MAX_FILES`` files or *max_bytes* in total."""
    now = time.time()
    files: list[tuple[float, int, Path]] = []
    for entry in directory.iterdir():
        try:
            info = entry.stat()
            if entry.name.endswith(".tmp"):
                if now - info.st_mtime > 3600:
                    entry.unlink()
            elif entry.name.endswith(SUFFIX):
                if now - info.st_mtime > ttl_s:
                    entry.unlink()
                else:
                    files.append((info.st_mtime, info.st_size, entry))
        except OSError:
            continue
    files.sort()
    total = sum(size for _, size, _ in files)
    while files and (len(files) > MAX_FILES or total > max_bytes):
        _, size, entry = files.pop(0)  # oldest first (the new file is the newest)
        entry.unlink(missing_ok=True)
        total -= size


def _read_batch(handle: Any) -> bytes:
    out: list[bytes] = []
    size = 0
    for line in handle:
        out.append(line)
        size += len(line)
        if size >= FLUSH_BYTES:
            break
    return b"".join(out)


def fresh_path(cache_dir: str | Path, key: Key, ttl_s: float) -> Path | None:
    """Path of the snapshot of *key* if it exists and is within the TTL."""
    age = age_s(cache_dir, key)
    return path_for(cache_dir, key) if age is not None and age <= ttl_s else None


def has_gzip_magic(path: Path) -> bool:
    """Cheap sanity check before a snapshot is sent as raw gzip bytes."""
    try:
        with path.open("rb") as handle:
            return handle.read(2) == b"\x1f\x8b"
    except OSError:
        return False


def _open(path: Path) -> tuple[Any, bytes]:
    handle = gzip.open(path, "rb")  # noqa: SIM115  (closed by the caller)
    try:
        first = _read_batch(handle)
        json.loads(first.partition(b"\n")[0])  # the meta line must parse
    except BaseException:
        handle.close()
        raise
    return handle, first


async def open_fresh(
    cache_dir: str | Path, key: Key, ttl_s: float
) -> AsyncIterator[bytes] | None:
    """Decompressed replay of a fresh snapshot (batched chunks), else ``None``.

    The first chunk is read eagerly: a corrupt file counts as a miss and is
    removed (unless it was replaced meanwhile).
    """
    path = fresh_path(cache_dir, key, ttl_s)
    if path is None:
        return None
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return None
    try:
        handle, first = await asyncio.to_thread(_open, path)
    except (EOFError, ValueError, gzip.BadGzipFile):
        log.warning("corrupt stream snapshot %s removed", path.name)
        with contextlib.suppress(OSError):
            if path.stat().st_mtime_ns == mtime:
                path.unlink()
        return None
    except OSError:  # vanished or unreadable: a miss, leave the file alone
        return None

    async def replay() -> AsyncIterator[bytes]:
        try:
            chunk = first
            while chunk:
                yield chunk
                chunk = await asyncio.to_thread(_read_batch, handle)
        finally:
            handle.close()

    return replay()


# -- single-flight builds ------------------------------------------------------------


class Build:
    """One in-flight BFS: recorded lines + wake-up for tailing subscribers."""

    def __init__(self) -> None:
        self.lines: list[bytes] = []
        self.finished = False
        self.reason: str | None = None
        self.stored = False  # snapshot written
        self.task: asyncio.Task[None] | None = None
        self._changed = asyncio.Event()

    def push(self, line: bytes) -> None:
        """Record a line and wake the subscribers."""
        self.lines.append(line)
        self.wake()

    def wake(self) -> None:
        """Wake all subscribers (one-shot event, replaced for the next wait)."""
        changed, self._changed = self._changed, asyncio.Event()
        changed.set()


_builds: dict[Key, Build] = {}
_seen: dict[Key, float] = {}


def reset_state() -> None:
    """Forget in-flight builds and seen keys (tests)."""
    _builds.clear()
    _seen.clear()


def seen_before(key: Key, ttl_s: float) -> bool:
    """True if *key* was requested within the TTL; registers it otherwise.

    Lets a one-off request of an arbitrary root stream live without leaving a
    snapshot behind; only a repeated request is worth caching.
    """
    now = time.monotonic()
    first = _seen.get(key)
    if first is not None and now - first <= ttl_s:
        return True
    _seen.pop(key, None)
    _seen[key] = now
    while len(_seen) > MAX_SEEN:
        del _seen[next(iter(_seen))]
    return False


def get_build(key: Key) -> Build | None:
    """The live build of *key* in this event loop, if any."""
    build = _builds.get(key)
    if build and build.task and build.task.get_loop() is asyncio.get_running_loop():
        return build
    return None


def start_build(
    key: Key,
    events: Callable[[], AsyncGenerator[Event, None]],
    cache_dir: str | Path,
    ttl_s: float,
    max_bytes: int = MAX_BYTES,
) -> Build | None:
    """Start the build of *key*; ``None`` when ``MAX_BUILDS`` are running."""
    if len(_builds) >= MAX_BUILDS and key not in _builds:
        return None
    build = Build()
    _builds[key] = build
    build.task = asyncio.create_task(
        _run(key, build, events, cache_dir, ttl_s, max_bytes)
    )
    return build


async def _run(
    key: Key,
    build: Build,
    events: Callable[[], AsyncGenerator[Event, None]],
    cache_dir: str | Path,
    ttl_s: float,
    max_bytes: int,
) -> None:
    try:
        try:
            async with contextlib.aclosing(events()) as source:
                async for event in source:
                    if event["type"] == "ping":  # subscribers have their own
                        continue
                    build.push(encode(event))
                    if event["type"] == "done":
                        build.reason = event["reason"]
        except Exception:  # pylint: disable=broad-exception-caught
            log.warning("stream build failed", exc_info=True)
        finally:  # also on cancellation: subscribers must always see an end
            if build.reason is None:
                build.reason = "error"
                build.push(encode({"type": "error", "message": "build aborted"}))
                build.push(encode({"type": "done", "reason": "error"}))
            build.finished = True
            build.wake()
        if build.reason in CACHEABLE:
            try:
                await asyncio.to_thread(
                    write, cache_dir, key, build.lines, ttl_s, max_bytes
                )
                build.stored = True
            except Exception:  # pylint: disable=broad-exception-caught
                log.warning("could not write stream snapshot", exc_info=True)
    finally:
        if _builds.get(key) is build:
            del _builds[key]


async def cancel_builds() -> None:
    """Cancel all builds and wait for them (app shutdown)."""
    tasks = [b.task for b in _builds.values() if b.task]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _builds.clear()


async def follow(
    build: Build, *, deadline: float, heartbeat_s: float
) -> AsyncIterator[bytes]:
    """Replay the lines recorded so far, then tail until ``done``.

    *deadline* (``time.monotonic``) is this subscriber's own budget: it ends
    with ``done(time_budget)`` without touching the shared build.
    """
    idx = 0
    while True:
        changed = build._changed  # pylint: disable=protected-access
        if idx < len(build.lines):
            chunk = build.lines[idx : idx + FLUSH_LINES]
            idx += len(chunk)
            yield b"".join(chunk)
            continue
        if build.finished:
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            yield encode({"type": "done", "reason": "time_budget"})
            return
        try:
            await asyncio.wait_for(changed.wait(), min(remaining, heartbeat_s))
        except TimeoutError:
            if deadline - time.monotonic() > 0:
                yield encode({"type": "ping"})
