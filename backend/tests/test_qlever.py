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

import base64
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


TYPES = [
    "https://schema.org/Person",
    "https://schema.org/Organization",
]
RELATIONS = [
    "https://schema.org/author",
    "https://schema.org/affiliation",
]
LABELS = [
    "https://schema.org/name",
    "https://schema.org/prefName",
]


def test_subgraph_template_has_bounds_order_and_types():
    q = templates.subgraph_query(
        type_iris=TYPES, relation_iris=RELATIONS, label_iris=LABELS, limit=500, offset=0
    )
    assert "<https://schema.org/Person>" in q
    assert "LIMIT 500 OFFSET 0" in q
    assert "ORDER BY ?kind ?node ?other" in q
    assert '"node"' in q and '"edge"' in q


def test_subgraph_limit_is_clamped_to_max():
    q = templates.subgraph_query(
        type_iris=TYPES, relation_iris=RELATIONS, label_iris=LABELS, limit=10**9
    )
    assert "LIMIT 5000 OFFSET 0" in q


def test_expand_template_iri_and_directions():
    q = templates.expand_query(
        iri="https://orcid.org/0000-0001-2345-6789",
        relation_iris=RELATIONS,
        label_iris=LABELS,
        limit=100,
    )
    assert "<https://orcid.org/0000-0001-2345-6789>" in q
    assert '"in"' in q and '"out"' in q
    assert "LIMIT 100" in q


def test_search_escapes_user_text_as_data():
    text = "O'Smith . + Co"
    q = templates.search_query(text=text, label_iris=LABELS, limit=20)
    expected = templates._regex_escape(text.strip())
    assert f'regex(str(?label), "^{expected}", "i")' in q
    assert r"\." in expected  # dot escaped, user text can't act as a pattern
    assert r"\+" in expected
    assert "LIMIT 20" in q


def test_sparql_string_literal_escape():
    assert templates._sparql_string_escape('a"b\\c\nd') == r"a\"b\\c\nd"


def test_search_rejects_empty_text():
    with pytest.raises(ValueError):
        templates.search_query(text="   ", label_iris=LABELS)


def test_aggregate_template_counts_by_type():
    q = templates.aggregate_query()
    assert "COUNT(?s)" in q
    assert "GROUP BY ?type" in q
    assert "LIMIT" not in q


def test_templates_reject_invalid_iris():
    for bad in [
        "",
        "https://schema.org/Person extra",
        "schema.org/Person",
        "https://a b.org/x",
    ]:
        with pytest.raises(ValueError):
            templates.iri_ref(bad)


def test_cursor_round_trip():
    assert templates.decode_cursor(None) == 0
    for offset in (0, 1, 500, 499_999):
        assert templates.decode_cursor(templates.encode_cursor(offset)) == offset


def test_cursor_rejects_garbage():
    for bad in ("!!!not-base64!!!", base64.urlsafe_b64encode(b'{"x":1}').decode()):
        with pytest.raises(ValueError):
            templates.decode_cursor(bad)


def test_clamp_limit_rejects_non_int():
    with pytest.raises(TypeError):
        templates.clamp_limit("500")  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        templates.clamp_limit(True)  # type: ignore[arg-type]
