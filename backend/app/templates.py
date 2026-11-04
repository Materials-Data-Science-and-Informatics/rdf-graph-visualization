"""SPARQL template builders for the endpoint cards (B2-B5).

Vocabulary-agnostic: callers pass IRI lists (data-model classes, relation /
label properties) and the builders emit SPARQL text ready for
``QleverClient.select``. The only free-form input any template accepts is
the search text in :func:`search_query`, which is regex-escaped — IRIs are
validated, never concatenated raw.

Row shapes (consumed by the endpoint cards, which fold them into the frozen
contract models from ``app.contract``):

- subgraph / expand rows carry a ``?kind`` discriminator (``node`` / ``edge``)
  so one query returns both sets in a single endpoint call.
- expand rows carry a ``?dir`` flag (``in`` / ``out``) for edge direction.

Deterministic paging: subgraph rows are ORDER BY ``?kind, ?node, ?other`` so
``LIMIT`` + :func:`encode_cursor`/ :func:`decode_cursor` (offset cursors)
round-trip stably. Cards pass ``limit + 1`` and drop the extra row to set
``Page.truncated``.
"""

from __future__ import annotations

import base64
import json
import re

#: IRI must carry a scheme and may not contain SPARQL delimiters/whitespace.
_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]*:")
_BAD_IRI_CHARS = set("<>\"'` \t\r\n")

DEFAULT_SEARCH_LIMIT = 20


def assert_valid_iri(iri: str) -> str:
    """Raise ``ValueError`` unless *iri* looks like a valid IRI; return it."""
    if not iri or any(c in _BAD_IRI_CHARS for c in iri):
        raise ValueError(f"not a valid IRI: {iri!r}")
    if not _SCHEME_RE.match(iri):
        raise ValueError(f"IRI missing scheme: {iri!r}")
    return iri


def iri_ref(iri: str) -> str:
    """``https://x`` -> ``<https://x>`` (validated)."""
    return f"<{assert_valid_iri(iri)}>"


def iri_list(iris: list[str] | tuple[str, ...]) -> str:
    """IRIs for a VALUES / IN list.

    Whitespace-separated on purpose: the QLever parser (unlike the SPARQL
    1.1 grammar) rejects comma separators inside VALUES blocks.
    """
    return " ".join(iri_ref(i) for i in iris)


def clamp_limit(limit: int | None, default: int = 500, max_: int = 5000) -> int:
    """Clamp a requested page size into ``[1, max_]`` (None -> default)."""
    if limit is None:
        return default
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise TypeError(f"limit must be an int, got {limit!r}")
    return min(max(limit, 1), max_)


# -- cursors (offset-based, opaque to clients) ------------------------------


def encode_cursor(offset: int) -> str:
    """Opaque cursor for the next page starting at *offset* rows."""
    if offset < 0:
        raise ValueError(f"cursor offset must be >= 0, got {offset}")
    payload = json.dumps({"offset": offset}).encode()
    return base64.urlsafe_b64encode(payload).decode()


def decode_cursor(cursor: str | None) -> int:
    """Offset encoded by :func:`encode_cursor`; ``None`` -> 0."""
    if cursor is None:
        return 0
    try:
        payload = base64.urlsafe_b64decode(cursor.encode()).decode()
        data = json.loads(payload)
        offset = data["offset"]
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise ValueError
        return offset
    except (ValueError, KeyError, UnicodeDecodeError) as exc:
        raise ValueError(f"invalid cursor: {cursor!r}") from exc


# -- escaping ----------------------------------------------------------------


def _sparql_string_escape(text: str) -> str:
    """Escape text for a double-quoted SPARQL string literal."""
    return (
        text.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )


def _regex_escape(text: str) -> str:
    """Escape for use inside a SPARQL ``regex()`` pattern (XSD regex)."""
    # re.escape over-escapes, which is harmless in XSD regex; it guarantees
    # user text can never act as a pattern.
    return re.escape(_sparql_string_escape(text))


# -- templates ----------------------------------------------------------------


def subgraph_query(
    *,
    type_iris: list[str],
    relation_iris: list[str],
    label_iris: list[str],
    limit: int,
    offset: int = 0,
) -> str:
    """Seeds of the given classes plus the edges between them — one call (B3).

    ``LIMIT`` is server-side; pass ``limit + 1`` from the endpoint to detect
    truncation. ``offset`` comes from :func:`decode_cursor`.
    """
    limit = clamp_limit(limit)
    return f"""PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?kind ?node ?other ?nodeType ?label ?pred WHERE {{
  VALUES ?t {{ {iri_list(type_iris)} }}
  VALUES ?p {{ {iri_list(relation_iris)} }}
  VALUES ?lbl {{ {iri_list(label_iris)} }}
  {{
    SELECT ?node (STR("node") AS ?kind) (STR("") AS ?other) ?nodeType ?label
    WHERE {{
      ?node a ?t .
      OPTIONAL {{ ?node ?lbl ?label }}
    }}
  }}
  UNION {{
    SELECT ?node ?other (STR("edge") AS ?kind) ?nodeType ?label ?pred WHERE {{
      ?node a ?t .
      ?other a ?t .
      ?node ?pred ?other .
      FILTER(?pred IN ?p)
      OPTIONAL {{ ?node ?lbl ?label }}
    }}
  }}
  UNION {{
    SELECT ?node ?other (STR("edge") AS ?kind) ?nodeType ?label ?pred WHERE {{
      ?node a ?t .
      ?other a ?t .
      ?other ?pred ?node .
      FILTER(?pred IN ?p)
      OPTIONAL {{ ?node ?lbl ?label }}
    }}
  }}
}}
ORDER BY ?kind ?node ?other
LIMIT {limit} OFFSET {offset}"""


def expand_query(
    *,
    iri: str,
    relation_iris: list[str],
    label_iris: list[str],
    limit: int,
) -> str:
    """One entity plus its in/out 1-hop neighbours — one call (B2).

    Center row first (``?dir = ""``), then ``in``/``out`` neighbour rows.
    """
    limit = clamp_limit(limit)
    return f"""SELECT ?kind ?dir ?node ?nodeType ?label WHERE {{
  VALUES ?p {{ {iri_list(relation_iris)} }}
  VALUES ?lbl {{ {iri_list(label_iris)} }}
  {{
    SELECT {iri_ref(iri)} AS ?node (STR("node") AS ?kind) (STR("") AS ?dir)
           ?nodeType ?label
    WHERE {{
      {iri_ref(iri)} a ?nodeType .
      OPTIONAL {{ {iri_ref(iri)} ?lbl ?label }}
    }}
  }}
  UNION {{
    SELECT ?node (STR("out") AS ?dir) (STR("edge") AS ?kind) ?nodeType ?label
    WHERE {{
      {iri_ref(iri)} ?pred ?node .
      FILTER(?pred IN ?p)
      OPTIONAL {{ ?node a ?nodeType }}
      OPTIONAL {{ ?node ?lbl ?label }}
    }}
  }}
  UNION {{
    SELECT ?node (STR("in") AS ?dir) (STR("edge") AS ?kind) ?nodeType ?label
    WHERE {{
      ?node ?pred {iri_ref(iri)} .
      FILTER(?pred IN ?p)
      OPTIONAL {{ ?node a ?nodeType }}
      OPTIONAL {{ ?node ?lbl ?label }}
    }}
  }}
}}
LIMIT {limit}"""


def search_query(
    *,
    text: str,
    label_iris: list[str],
    limit: int = DEFAULT_SEARCH_LIMIT,
) -> str:
    """Prefix search over label properties — the B5 autocomplete source.

    ``text`` is matched case-insensitively as a *prefix* of the label
    (``regex(label, "^" + text, "i")``); all pattern metacharacters in the
    user text are escaped, so it is treated as data, not a pattern.
    ``?lbl`` is projected so the endpoint can fold a node's several matched
    rows (multiple label properties / values / rdf:types) deterministically
    (label-property priority, B2's primary-type rule).

    QLever dialect note (verified live against the dev endpoint): the
    VALUES block is whitespace-separated (see :func:`iri_list`).
    """
    limit = clamp_limit(limit)
    if not text.strip():
        raise ValueError("search text must be non-empty")
    pattern = _regex_escape(text.strip())
    return f"""SELECT ?node ?nodeType ?label ?lbl WHERE {{
  VALUES ?lbl {{ {iri_list(label_iris)} }}
  ?node a ?nodeType .
  ?node ?lbl ?label .
  FILTER(regex(str(?label), "^{pattern}", "i"))
}}
ORDER BY ?label
LIMIT {limit}"""


def aggregate_query() -> str:
    """Total entity counts per declared type — the B4 aggregate source.

    No LIMIT: this is the one unbounded query (counts, not rows).
    """
    return """SELECT ?type (COUNT(?s) AS ?count) WHERE {
  ?s a ?type .
}
GROUP BY ?type
ORDER BY DESC(?count)"""


def entity_properties_query(*, iri: str, limit: int = 200) -> str:
    """All (predicate, object) pairs of one entity — B2 /api/entity.

    ``limit`` bounds the property list; the endpoint sets
    ``truncated`` when the row count hits it.
    """
    limit = clamp_limit(limit, default=200)
    return f"""SELECT ?pred ?obj ?objType WHERE {{
  {iri_ref(iri)} ?pred ?obj .
  OPTIONAL {{ ?obj a ?objType }}
}}
ORDER BY ?pred ?obj
LIMIT {limit}"""
