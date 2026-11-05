# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""QLever SPARQL client — the single gateway from the API to the endpoint.

Card B1. Every SPARQL traffic in this backend goes through :class:`QleverClient`;
endpoint cards (B2-B5) build their queries with ``app.templates`` and execute
them here.

Contract with the shared dev endpoint:
- transport: POST, form field ``query``, Accept ``application/sparql-results+json``.
- endpoint URL comes from ``QLEVER_URL`` (see ``app.settings``); the default is
  the HKG *dev* endpoint — it stays that way until shipping.
- timeouts come from ``QLEVER_TIMEOUT_S``; no other knob is read at request time.

429 policy (shared-token penalty ladder, 60s..3600s):
- the endpoint tells us how long to wait (``Retry-After``). We parse it —
  delta-seconds or HTTP-date — and surface it on :class:`QleverRateLimited.wait_s`.
- the client NEVER retries a 429 (or anything else). Blind retries on a
  shared token extend everyone's penalty; the HTTP layer turns the wait into
  a 429 + ``Retry-After`` for the frontend instead.
- if the header is missing or unparseable we use the ladder floor (60s);
  waits above the ladder ceiling (3600s) are clamped to it.
"""

from __future__ import annotations

import email.utils
import json
import re
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Self

import httpx

from app import templates

DEFAULT_TIMEOUT_S = 30.0
#: Shared-token penalty ladder bounds: floor used when Retry-After is absent,
#: ceiling used to clamp absurd waits so a request never blocks for a day.
RATE_LIMIT_WAIT_FLOOR_S = 60.0
RATE_LIMIT_WAIT_CEILING_S = 3600.0

_ACCEPT = "application/sparql-results+json"
_ACCEPT_NT = "application/n-triples"
_ACCEPT_TSV = "text/tab-separated-values"

# <s> <p> <o> .   (o: IRI, literal or blank node; s may be a blank node)
# QLever emits raw IRIs (no \uXXXX escapes), so ``<[^<>\s]*>`` is the IRI form;
# anything else in object position is a literal/bnode and gets skipped.
_NT_LINE = re.compile(r"^(<[^<>\s]*>|_:\S+)\s+<([^<>\s]*)>\s+(.+?)\s*\.$")
_NT_IRI = re.compile(r"^<[^<>\s]*>$")
_TSV_UNESCAPE = {"t": "\t", "n": "\n", "r": "\r", "\\": "\\", '"': '"'}
_TSV_ESCAPE_RE = re.compile(r"\\(.)")
_TSV_LITERAL = re.compile(r'^"(.*)"(?:@([A-Za-z0-9-]+)|\^\^<(.*)>)?$', re.DOTALL)


class QleverError(Exception):
    """Base for all QLever failures. ``status`` is the HTTP code, if any."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class QleverQueryError(QleverError):
    """The endpoint rejected the query itself (4xx, e.g. SPARQL parse error).

    Retrying the identical query cannot help; the endpoint layer should turn
    this into a 400 with the parser message.
    """


class QleverRateLimited(QleverError):
    """429 from the shared dev endpoint.

    ``wait_s`` is the server-declared penalty wait (ladder 60s..3600s).
    The client never retries — the caller must honour the wait (e.g. answer
    the browser with 429 + ``Retry-After`` and let it retry after the wait).
    """

    def __init__(self, wait_s: float) -> None:
        super().__init__(
            f"QLever rate-limited; wait {wait_s:.0f}s before retrying", status=429
        )
        self.wait_s = float(wait_s)


class QleverServerError(QleverError):
    """5xx, or a 2xx with an unexpected (non-JSON) body."""


class QleverUnavailable(QleverError):
    """Could not reach the endpoint at all: timeout or connection failure."""


@dataclass(frozen=True)
class Binding:
    """One SPARQL result cell. ``type`` is ``uri`` | ``literal`` | ``bnode``."""

    type: str
    value: str
    lang: str | None = None
    datatype: str | None = None


@dataclass(frozen=True)
class SelectResult:
    """Parsed ``SELECT`` answer.

    ``rows`` is positional-safe: each row maps selected variable names to
    :class:`Binding`. ``meta`` carries QLever extras (``query-time-ms``,
    ``result-size-total``) useful for the B5 latency DoD.
    """

    vars: list[str]
    rows: list[dict[str, Binding]]
    meta: dict[str, Any] = field(default_factory=dict)


def _clamp_wait(wait: float) -> float:
    return min(max(wait, RATE_LIMIT_WAIT_FLOOR_S), RATE_LIMIT_WAIT_CEILING_S)


def parse_retry_after(headers: httpx.Headers | dict[str, str]) -> float:
    """Wait in seconds from a 429 response; ladder floor when absent/bad."""
    raw = headers.get("retry-after")
    if raw is None or not raw.strip():
        return RATE_LIMIT_WAIT_FLOOR_S
    raw = raw.strip()
    try:  # delta-seconds
        return _clamp_wait(float(raw))
    except ValueError:
        pass
    try:  # HTTP-date
        dt = email.utils.parsedate_to_datetime(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        wait = (dt - datetime.now(UTC)).total_seconds()
        return _clamp_wait(wait)
    except (TypeError, ValueError, OverflowError):
        return RATE_LIMIT_WAIT_FLOOR_S


def _binding(raw: dict[str, Any]) -> Binding:
    return Binding(
        type=raw.get("type", "literal"),
        value=raw.get("value", ""),
        lang=raw.get("xml:lang"),
        datatype=raw.get("datatype"),
    )


def _tsv_binding(cell: str) -> Binding | None:
    """One TSV cell -> Binding (None when unbound/empty)."""
    if not cell:
        return None
    if cell.startswith("<") and cell.endswith(">"):
        return Binding(type="uri", value=cell[1:-1])
    if cell.startswith("_:"):
        return Binding(type="bnode", value=cell[2:])
    match = _TSV_LITERAL.match(cell)
    if match is None:  # bare value (numbers etc.)
        return Binding(type="literal", value=cell)
    raw, lang, datatype = match.groups()
    value = _TSV_ESCAPE_RE.sub(lambda m: _TSV_UNESCAPE.get(m.group(1), m.group(0)), raw)
    return Binding(type="literal", value=value, lang=lang, datatype=datatype)


def _error_text(resp: httpx.Response) -> str:
    """Human-readable reason: QLever error JSON has an ``exception`` field."""
    try:
        payload = resp.json()
        if isinstance(payload, dict) and isinstance(payload.get("exception"), str):
            return payload["exception"]
    except (ValueError, json.JSONDecodeError):
        pass
    return resp.text[:500] or f"HTTP {resp.status_code}"


class QleverClient:
    """Thin, synchronous httpx wrapper for one QLever endpoint.

    ``transport`` is an httpx transport override (``httpx.MockTransport`` in
    tests). One client is reused process-wide via :func:`get_client`.
    """

    def __init__(
        self,
        url: str,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self.timeout_s = float(timeout_s)
        self._client = httpx.Client(
            timeout=httpx.Timeout(self.timeout_s),
            transport=transport,
            headers={"Accept": _ACCEPT},
        )

    # -- public API ---------------------------------------------------------

    def select(self, query: str) -> SelectResult:
        """Run a SELECT and return parsed rows plus QLever meta."""
        payload = self._post_json(query)
        head = payload.get("head") or {}
        vars_ = list(head.get("vars") or [])
        bindings = (payload.get("results") or {}).get("bindings") or []
        rows = [{var: _binding(cell) for var, cell in row.items()} for row in bindings]
        meta = payload.get("meta") or {}
        return SelectResult(vars=vars_, rows=rows, meta=meta)

    def construct(self, query: str) -> list[tuple[str, str, str]]:
        """Run a CONSTRUCT as N-Triples; return the IRI-only triples.

        Triples with a literal or blank-node subject/object are skipped (the
        graph only has IRI-IRI edges). A truncated body raises
        :class:`QleverServerError`, see :func:`_require_complete`.
        """
        text = self._post_text(query, _ACCEPT_NT)
        triples: list[tuple[str, str, str]] = []
        for line in text.split("\n"):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            match = _NT_LINE.match(line)
            if match is None:
                raise QleverServerError(
                    f"QLever returned bad N-Triples line: {line[:80]!r}"
                )
            subj, pred, obj = match.groups()
            if _NT_IRI.match(subj) and _NT_IRI.match(obj):
                s, o = subj[1:-1], obj[1:-1]
                # drop IRIs we could not safely re-use in a later VALUES block
                if templates.is_valid_iri(s) and templates.is_valid_iri(o):
                    triples.append((s, pred, o))
        return triples

    def select_tsv(self, query: str) -> SelectResult:
        """Run a SELECT as TSV (compact for big flat results) -> parsed rows.

        TSV is parsed (not JSON) because the bulk queries return 10^5+ flat
        rows where JSON is several times larger; the cells are simple enough
        (``<iri>``, ``"lit"@lang``, ``"lit"^^<dt>``, backslash escapes) to map
        onto :class:`Binding`. Unbound cells are omitted from the row dict.
        A body cut exactly on a line boundary cannot be detected.
        """
        text = self._post_text(query, _ACCEPT_TSV)
        lines = [ln.rstrip("\r") for ln in text.split("\n")[:-1]]
        if not lines:
            raise QleverServerError("QLever returned an empty TSV body")
        vars_ = [v.lstrip("?") for v in lines[0].split("\t")]
        rows: list[dict[str, Binding]] = []
        for line in lines[1:]:
            cells = line.split("\t")
            if len(cells) != len(vars_):
                raise QleverServerError(
                    f"QLever returned malformed TSV row: {line[:80]!r}"
                )
            rows.append(
                {
                    v: b
                    for v, c in zip(vars_, cells)
                    if (b := _tsv_binding(c)) is not None
                }
            )
        return SelectResult(vars=vars_, rows=rows)

    def ask(self, query: str) -> bool:
        """Run an ASK and return the boolean answer."""
        payload = self._post_json(query)
        return bool(payload.get("boolean"))

    def close(self) -> None:
        """Close the underlying httpx client (idempotent)."""
        self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- internals ----------------------------------------------------------

    def _post_json(self, query: str) -> dict[str, Any]:
        resp = self._post(query)
        try:
            payload = resp.json()
        except (ValueError, json.JSONDecodeError) as exc:
            raise QleverServerError(
                f"QLever returned non-JSON body (HTTP {resp.status_code})",
                status=resp.status_code,
            ) from exc
        if not isinstance(payload, dict):
            raise QleverServerError(
                f"QLever returned unexpected JSON shape (HTTP {resp.status_code})",
                status=resp.status_code,
            )
        return payload

    def _post_text(self, query: str, accept: str) -> str:
        """POST expecting a line-oriented body; reject truncated answers.

        On a QLever timeout the endpoint can answer HTTP 200 with a body cut
        mid-stream. Both N-Triples and TSV bodies end every line with ``\\n``,
        so a non-empty body without a trailing newline is truncated.
        """
        text = self._post(query, accept).text
        if text and not text.endswith("\n"):
            raise QleverServerError(
                "QLever returned a truncated body (no trailing newline; likely a "
                "server-side timeout)",
                status=200,
            )
        return text

    def _post(self, query: str, accept: str | None = None) -> httpx.Response:
        headers = {"Accept": accept} if accept else None
        try:
            resp = self._client.post(self.url, data={"query": query}, headers=headers)
        except httpx.TimeoutException as exc:
            raise QleverUnavailable(
                f"QLever request timed out after {self.timeout_s:.1f}s"
            ) from exc
        except httpx.HTTPError as exc:
            raise QleverUnavailable(f"QLever request failed: {exc}") from exc
        return self._handle(resp)

    def _handle(self, resp: httpx.Response) -> httpx.Response:
        # No retry of any kind: on 429 the wait is surfaced, not slept out.
        if resp.status_code == 429:
            raise QleverRateLimited(parse_retry_after(resp.headers))
        if resp.status_code >= 500:
            raise QleverServerError(
                f"QLever server error (HTTP {resp.status_code})",
                status=resp.status_code,
            )
        if resp.status_code >= 400:
            raise QleverQueryError(
                f"QLever rejected the query (HTTP {resp.status_code}): {_error_text(resp)}",
                status=resp.status_code,
            )
        return resp


# -- process-wide client (endpoint cards call get_client()) -----------------

_client_lock = threading.Lock()
# Lazily-built shared client; a module global is deliberate — one httpx pool
# per process, overridable in tests via set_client().
_client: QleverClient | None = None  # pylint: disable=invalid-name


def get_client() -> QleverClient:
    """Return the shared client, building it lazily from the environment.

    ``QLEVER_URL`` / ``QLEVER_TIMEOUT_S`` are read at first use, so tests and
    deployments can set env before the first request.
    """
    global _client  # pylint: disable=global-statement
    with _client_lock:
        if _client is None:
            # local import: keep app.settings a leaf so it never cycles back
            from app.settings import (  # pylint: disable=import-outside-toplevel
                Settings,
            )

            s = Settings.from_env()
            _client = QleverClient(s.qlever_url, timeout_s=s.request_timeout_s)
        return _client


def set_client(client: QleverClient | None) -> None:
    """Override (or reset, with ``None``) the shared client — test hook."""
    global _client  # pylint: disable=global-statement
    with _client_lock:
        if _client is not None and client is not _client:
            _client.close()
        _client = client


def reset_client() -> None:
    """Reset the shared client (test hook)."""
    set_client(None)
