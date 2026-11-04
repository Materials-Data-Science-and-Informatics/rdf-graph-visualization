# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""Unit tests for app.templates (card B8): opaque cursors and query guards.

The endpoint test files (test_b2, test_subgraph) exercise the happy paths of
these helpers through the API; this file pins the error branches that only
surface from malformed client input (422 at the endpoints) and the limit
type-guard, so a cursor or limit regression fails in unit tests before it
reaches a client.
"""

from __future__ import annotations

import base64
import json

import pytest

from app import templates


def b64(payload: object) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


# -- single-offset cursor (legacy /api shape) ---------------------------------


def test_encode_cursor_roundtrip() -> None:
    for offset in (0, 1, 499, 5000):
        assert templates.decode_cursor(templates.encode_cursor(offset)) == offset


def test_decode_cursor_none_starts_at_zero() -> None:
    assert templates.decode_cursor(None) == 0


def test_encode_cursor_rejects_negative_offset() -> None:
    with pytest.raises(ValueError, match=">= 0"):
        templates.encode_cursor(-1)


@pytest.mark.parametrize(
    "cursor",
    [
        "!!!not-base64!!!",
        b64({"offset": "3"}),  # offset must be an int
        b64({"offset": True}),  # bool is not an offset
        b64({"offset": -2}),
        b64({"nope": 1}),  # missing key
    ],
    ids=["bad-b64", "str-offset", "bool-offset", "neg-offset", "missing"],
)
def test_decode_cursor_rejects_malformed(cursor: str) -> None:
    with pytest.raises(ValueError, match="invalid cursor"):
        templates.decode_cursor(cursor)


# -- per-stream subgraph cursor -------------------------------------------------


def test_encode_subgraph_cursor_roundtrip() -> None:
    for n, e in ((0, 0), (3, 7), (500, 12)):
        assert templates.decode_subgraph_cursor(
            templates.encode_subgraph_cursor(n, e)
        ) == (
            n,
            e,
        )


def test_decode_subgraph_cursor_none_starts_at_zero() -> None:
    assert templates.decode_subgraph_cursor(None) == (0, 0)


@pytest.mark.parametrize("n,e", [(-1, 0), (0, -1)])
def test_encode_subgraph_cursor_rejects_negative(n: int, e: int) -> None:
    with pytest.raises(ValueError, match=">= 0"):
        templates.encode_subgraph_cursor(n, e)


def test_decode_subgraph_cursor_rejects_empty_string() -> None:
    with pytest.raises(ValueError, match="non-empty string"):
        templates.decode_subgraph_cursor("")


@pytest.mark.parametrize(
    "cursor",
    [
        "!!!not-base64!!!",
        b64([1, 2]),  # payload must be an object
        b64({"n": 3}),  # missing "e"
        b64({"n": -1, "e": 0}),
        b64({"n": 0, "e": -1}),
    ],
    ids=["bad-b64", "non-object", "missing-key", "neg-node", "neg-edge"],
)
def test_decode_subgraph_cursor_rejects_malformed(cursor: str) -> None:
    with pytest.raises(ValueError):
        templates.decode_subgraph_cursor(cursor)


# -- limit guards ----------------------------------------------------------------


@pytest.mark.parametrize("limit", [True, False, "10", None, 10.0])
def test_expand_query_rejects_non_int_limit(limit: object) -> None:
    with pytest.raises(TypeError, match="limit must be an int"):
        templates.expand_query(
            iri="https://x/y",
            relation_iris=[],
            label_iris=[],
            limit=limit,  # type: ignore[arg-type]
        )


def test_expand_query_floors_limit_at_one() -> None:
    query = templates.expand_query(
        iri="https://x/y", relation_iris=[], label_iris=[], limit=0
    )
    assert "LIMIT 1" in query
