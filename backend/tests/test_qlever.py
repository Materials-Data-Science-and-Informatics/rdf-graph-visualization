# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Unit tests for the QLever client (card B1).

All endpoint behaviour is replayed from recorded responses in
``fixtures/qlever/`` via ``httpx.MockTransport`` — no network. Error paths
(400, 429 with/without Retry-After, 500, non-JSON 200, timeout) are included
per the card DoD. The 429 policy is asserted explicitly: the client sends
exactly ONE request and surfaces the server-declared wait — it never
blind-retries (shared-token penalty ladder).
"""

from __future__ import annotations

import socketserver
import threading
import time
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import httpx
import pytest

from app import qlever, templates
from app.qlever import (
    QleverClient,
    QleverQueryError,
    QleverRateLimited,
    QleverServerError,
    QleverUnavailable,
)

DEV_URL = "https://sparql.unhide.helmholtz-metadaten.de/sparql"
FIXTURES = Path(__file__).parent / "fixtures" / "qlever"


# -- fixture replay -----------------------------------------------------------


def recorded(name: str) -> httpx.Response:
    """Load a recorded (headers, body) pair into an httpx.Response."""
    status_line = ""
    headers: dict[str, str] = {}
    with (FIXTURES / f"{name}.headers").open(encoding="latin-1") as fh:
        for line in fh:
            line = line.strip()
            if line.startswith("HTTP/"):
                status_line = line
            elif ":" in line:
                key, _, val = line.partition(":")
                headers[key.strip().lower()] = val.strip()
    status = int(status_line.split()[1]) if status_line else 200
    body = (FIXTURES / f"{name}.body").read_bytes()
    return httpx.Response(status, headers=headers, content=body)


def mock_client(*responses: httpx.Response) -> tuple[QleverClient, list[httpx.Request]]:
    """A QleverClient whose transport replays *responses* in order."""
    calls: list[httpx.Request] = []
    iterator = iter(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return next(iterator)

    client = QleverClient(DEV_URL, transport=httpx.MockTransport(handler))
    return client, calls


# -- select: recorded happy paths ---------------------------------------------


def test_select_ok_parses_rows_meta_and_bindings():
    client, calls = mock_client(recorded("select_ok"))
    result = client.select("SELECT ?s ?p ?o WHERE { ?s a ?t . ?s ?p ?o } LIMIT 2")

    assert result.vars == ["s", "p", "o"]
    assert len(result.rows) == 2
    row0 = result.rows[0]
    # exact values of the recorded fixture (endpoint rows are unordered)
    assert row0["s"].type == "uri"
    assert row0["s"].value == (
        "http://193.206.192.231/carta_geologica_italia/note_illustrative/49.pdf"
    )
    assert row0["p"].value == "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
    assert row0["o"].value == "https://schema.org/CreativeWork"
    # QLever meta block (latency info used by the B5 DoD)
    assert isinstance(result.meta.get("query-time-ms"), int)
    assert result.meta.get("result-size-total") == 2
    # exactly one POST, correct shape
    assert len(calls) == 1
    assert calls[0].method == "POST"
    assert calls[0].url == httpx.URL(DEV_URL)
    assert calls[0].headers["accept"] == "application/sparql-results+json"
    assert b"query=" in calls[0].content


def test_select_empty_returns_no_rows():
    client, _ = mock_client(recorded("select_empty"))
    result = client.select("SELECT ?s WHERE { ?s a <nope> } LIMIT 10")
    assert result.rows == []
    assert result.meta.get("result-size-total") == 0


def test_ask_returns_boolean():
    client, _ = mock_client(recorded("ask_ok"))
    assert client.ask("ASK { ?s ?p ?o }") is True


# -- error paths ----------------------------------------------------------------


def test_sparql_parse_error_raises_query_error_with_parser_message():
    client, calls = mock_client(recorded("select_parse_error_400"))
    with pytest.raises(QleverQueryError) as excinfo:
        client.select("SELEC WHERE { }")
    assert excinfo.value.status == 400
    assert "Invalid SPARQL query" in str(excinfo.value)
    # no blind retry: the rejected query is sent exactly once
    assert len(calls) == 1


def test_429_surfaces_server_wait_and_never_retries():
    client, calls = mock_client(recorded("rate_limited_429"))
    with pytest.raises(QleverRateLimited) as excinfo:
        client.select("SELECT * WHERE { ?s ?p ?o }")
    assert excinfo.value.status == 429
    assert excinfo.value.wait_s == 120.0  # the Retry-After the server declared
    assert len(calls) == 1  # never blind-retries a 429


def test_429_without_retry_after_uses_ladder_floor():
    client, _ = mock_client(recorded("rate_limited_429_nohdr"))
    with pytest.raises(QleverRateLimited) as excinfo:
        client.select("SELECT * WHERE { ?s ?p ?o }")
    assert excinfo.value.wait_s == qlever.RATE_LIMIT_WAIT_FLOOR_S  # 60s


def test_429_retry_after_http_date_is_parsed():
    future = formatdate(time.time() + 90, usegmt=True)
    resp = httpx.Response(429, headers={"retry-after": future})
    client, _ = mock_client(resp)
    with pytest.raises(QleverRateLimited) as excinfo:
        client.ask("ASK { ?s ?p ?o }")
    assert 80.0 <= excinfo.value.wait_s <= 90.0  # clamped, ~90s


def test_429_retry_after_naive_http_date_assumed_utc():
    """An HTTP-date without a zone is treated as UTC (not local time)."""
    from datetime import UTC, datetime, timedelta

    naive_future = (datetime.now(UTC) + timedelta(seconds=90)).strftime(
        "%a, %d %b %Y %H:%M:%S"
    )
    resp = httpx.Response(429, headers={"retry-after": naive_future})
    client, _ = mock_client(resp)
    with pytest.raises(QleverRateLimited) as excinfo:
        client.ask("ASK { ?s ?p ?o }")
    assert 70.0 <= excinfo.value.wait_s <= 90.0


def test_429_retry_after_garbage_uses_ladder_floor():
    resp = httpx.Response(429, headers={"retry-after": "not-a-date-or-number"})
    client, _ = mock_client(resp)
    with pytest.raises(QleverRateLimited) as excinfo:
        client.ask("ASK { ?s ?p ?o }")
    assert excinfo.value.wait_s == qlever.RATE_LIMIT_WAIT_FLOOR_S  # 60s


def test_429_wait_clamped_to_ladder_ceiling():
    resp = httpx.Response(429, headers={"retry-after": "999999"})
    client, _ = mock_client(resp)
    with pytest.raises(QleverRateLimited) as excinfo:
        client.ask("ASK { ?s ?p ?o }")
    assert excinfo.value.wait_s == qlever.RATE_LIMIT_WAIT_CEILING_S  # 3600s


def test_5xx_raises_server_error():
    client, _ = mock_client(recorded("server_error_500"))
    with pytest.raises(QleverServerError) as excinfo:
        client.select("SELECT * WHERE { ?s ?p ?o }")
    assert excinfo.value.status == 500


def test_200_non_json_raises_server_error():
    client, _ = mock_client(recorded("non_json_200"))
    with pytest.raises(QleverServerError) as excinfo:
        client.select("SELECT * WHERE { ?s ?p ?o }")
    assert excinfo.value.status == 200


def test_200_json_array_raises_unexpected_shape():
    """A 200 with a JSON body that is not an object (e.g. a bare list)."""
    resp = httpx.Response(200, json=["not", "an", "object"])
    client, _ = mock_client(resp)
    with pytest.raises(QleverServerError) as excinfo:
        client.select("SELECT * WHERE { ?s ?p ?o }")
    assert "unexpected JSON shape" in str(excinfo.value)
    assert excinfo.value.status == 200


def test_4xx_error_text_falls_back_to_body_when_not_json():
    resp = httpx.Response(400, text="parser boom (no JSON here)")
    client, _ = mock_client(resp)
    with pytest.raises(QleverQueryError) as excinfo:
        client.select("SELEC WHERE { }")
    assert "parser boom" in str(excinfo.value)


def test_4xx_error_text_falls_back_to_body_without_exception_field():
    """JSON error bodies without a string ``exception`` field surface raw."""
    resp = httpx.Response(400, json={"error": "bad query", "code": 13})
    client, _ = mock_client(resp)
    with pytest.raises(QleverQueryError) as excinfo:
        client.select("SELEC WHERE { }")
    assert "bad query" in str(excinfo.value)


def test_client_is_a_context_manager_that_closes():
    client, _ = mock_client(httpx.Response(200, json={"head": {}, "results": {}}))
    with client as opened:
        assert opened is client
    # __exit__ closed the underlying httpx client (send-after-close raises)
    with pytest.raises(RuntimeError, match="closed"):
        client._client.post(client.url)  # pylint: disable=protected-access


def test_connection_error_raises_unavailable():
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    client = QleverClient(DEV_URL, transport=httpx.MockTransport(handler))
    with pytest.raises(QleverUnavailable):
        client.select("SELECT * WHERE { ?s ?p ?o }")


def test_timeout_raises_unavailable():
    """Real (tiny) local server that sleeps past the client timeout."""

    class Slow(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            time.sleep(0.3)
            self.send_response(500)
            self.end_headers()

        def log_message(self, *args: object) -> None:  # silence
            pass

    with socketserver.ThreadingTCPServer(("127.0.0.1", 0), Slow) as httpd:
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            client = QleverClient(f"http://127.0.0.1:{port}/sparql", timeout_s=0.05)
            with pytest.raises(QleverUnavailable) as excinfo:
                client.select("SELECT * WHERE { ?s ?p ?o }")
            assert "timed out" in str(excinfo.value)
        finally:
            httpd.shutdown()


# -- settings / QLEVER_URL wiring ----------------------------------------------


def test_get_client_reads_qlever_url_from_env(monkeypatch):
    monkeypatch.setenv("QLEVER_URL", "https://dev.qlever.example/sparql/")
    monkeypatch.setenv("QLEVER_TIMEOUT_S", "7.5")
    qlever.reset_client()
    try:
        client = qlever.get_client()
        assert client.url == "https://dev.qlever.example/sparql"  # trailing / stripped
        assert client.timeout_s == 7.5
        # cached: same object, env change has no effect until reset
        monkeypatch.setenv("QLEVER_URL", "https://other.example/sparql")
        assert qlever.get_client() is client
    finally:
        qlever.reset_client()


def test_set_client_replaces_and_closes():
    outer, _ = mock_client(recorded("select_ok"))
    inner, _ = mock_client(recorded("select_ok"))
    qlever.set_client(outer)
    try:
        qlever.set_client(inner)
        assert qlever.get_client() is inner
        assert outer._client.is_closed
    finally:
        qlever.reset_client()


# -- templates -------------------------------------------------------------------


LABELS = [
    "https://schema.org/name",
    "https://schema.org/prefName",
]


def test_search_escapes_user_text_as_data():
    q = templates.search_query(text='O"Sm\\ith', label_iris=LABELS, limit=20)
    assert 'STRSTARTS(?label, "O\\"Sm\\\\ith")' in q
    assert 'O"Sm' not in q
    assert "regex" not in q
    assert "LIMIT 60" in q


def test_search_case_variants_deduped():
    q = templates.search_query(text="abc", label_iris=LABELS)
    assert q.count("STRSTARTS") == 2  # abc, Abc
    assert q.count("UNION") == 1
    q = templates.search_query(text="Abc", label_iris=LABELS)
    assert q.count("STRSTARTS") == 2  # Abc, abc
    q = templates.search_query(text="ABC", label_iris=LABELS)
    assert q.count("STRSTARTS") == 2  # ABC, abc


def test_search_type_join_outside_subselect():
    q = templates.search_query(text="x", label_iris=LABELS)
    assert q.index("LIMIT 60") < q.index("?node a ?nodeType")
    assert "ORDER BY ?label" in q


def test_sparql_string_literal_escape():
    assert templates._sparql_string_escape('a"b\\c\nd') == r"a\"b\\c\nd"


def test_search_rejects_empty_text():
    with pytest.raises(ValueError):
        templates.search_query(text="   ", label_iris=LABELS)


def test_templates_reject_invalid_iris():
    for bad in [
        "",
        "https://schema.org/Person extra",
        "schema.org/Person",
        "https://a b.org/x",
    ]:
        with pytest.raises(ValueError):
            templates.iri_ref(bad)


def test_clamp_limit_rejects_non_int():
    with pytest.raises(TypeError):
        templates.clamp_limit("500")  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        templates.clamp_limit(True)  # type: ignore[arg-type]
