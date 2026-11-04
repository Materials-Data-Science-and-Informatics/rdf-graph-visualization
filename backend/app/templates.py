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

Deterministic paging: subgraph rows are ORDER BY ``?kind ?node ?other ?pred
?nodeType ?otherType`` (a total order — no ties), so ``LIMIT`` +
:func:`encode_cursor`/ :func:`decode_cursor` (offset cursors) round-trip
stably. Each row is unique (node rows grouped per (node, type); edge rows
are one solution per (node, pred, other, types) tuple), and the endpoint
folds them first-in-sort-order (per IRI / per (source, target) pair), so a
cursor can neither skip nor repeat rows. Cards pass ``limit + 1`` and drop
the extra row to set ``Page.truncated``.
"""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Sequence

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


def iri_list(iris: Sequence[str]) -> str:
    """IRIs for a VALUES / IN list.

    Whitespace-separated on purpose: the SPARQL 1.1 grammar defines a data
    block as ``DataItem+`` — *no commas*. Permissive engines (Jena, Virtuoso)
    tolerate commas, but QLever's strict parser rejects them (verified live
    against the dev endpoint: ``VALUES ?x { <a>, <b> }`` → 400 "extraneous
    input ','").
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
    offset_node: int = 0,
    offset_edge: int = 0,
) -> str:
    """Seeds of the given classes plus the edges between them — one call (B3).

    Rows: node rows are one per (node, type, label) combination; edge rows
    one per (source, predicate, target, types) tuple for edges whose BOTH
    endpoints are typed with one of ``type_iris`` (cross-type edges
    included — the two endpoint type variables are independent). No
    aggregation on purpose: a ``GROUP BY`` over all typed nodes forces the
    engine to materialize the full node set before any LIMIT applies (the
    dev endpoint OOMs on it); the endpoint folds node-row multiplicity
    deterministically instead (first row in sort order per IRI, first
    *real* label wins).

    Paging: each branch carries its OWN ``LIMIT``/``OFFSET`` (the node and
    edge streams advance independently) and is pre-ordered in the
    projection of the global order, so every page is a bounded top-k scan
    per branch. The outer ``ORDER BY`` (a total order over the row keys;
    remaining ties are indistinguishable rows) + ``LIMIT`` merges the two
    batches — the endpoint feeds back the per-stream consumed counts as
    the next cursor, which is what makes paging gap-free and repeat-free.
    The endpoint passes ``limit`` (already clamped to settings
    ``max_limit``); branches and outer fetch ``limit + 1`` to detect
    truncation — this builder is the *probe-capable* template, so it must
    not re-clamp the upper bound (a ``max + 1`` probe would be silently
    cut back and truncation at the max page would go undetected).
    ``limit`` must be >= 1 (validated input); offsets come from
    :func:`decode_subgraph_cursor`.

    QLever dialect notes (verified live against the dev endpoint): the
    parser rejects comma separators in VALUES blocks (see :func:`iri_list`),
    rejects ``IN`` with a variable RHS (restrictions are written as
    ``VALUES`` solution filters), and rejects ``MIN(?x) AS ?x`` where ``?x``
    is also bound in the query body.
    """
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
        raise ValueError(f"limit must be an int >= 1, got {limit!r}")
    for name, off in (("offset_node", offset_node), ("offset_edge", offset_edge)):
        if not isinstance(off, int) or isinstance(off, bool) or off < 0:
            raise ValueError(f"{name} must be an int >= 0, got {off!r}")
    types = iri_list(type_iris)
    preds = iri_list(relation_iris)
    labels = iri_list(label_iris)
    probe = limit + 1
    return f"""PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?kind ?node ?other ?nodeType ?otherType ?label ?pred WHERE {{
  {{
    SELECT ?node (STR("node") AS ?kind) (STR("") AS ?other) ?nodeType ?label
    WHERE {{
      VALUES ?nodeType {{ {types} }}
      ?node a ?nodeType .
      OPTIONAL {{ ?node ?lbl ?label . VALUES ?lbl {{ {labels} }} }}
    }}
    ORDER BY ?node ?nodeType ?label
    LIMIT {probe} OFFSET {offset_node}
  }}
  UNION {{
    SELECT ?node ?other (STR("edge") AS ?kind) ?nodeType ?otherType ?pred
    WHERE {{
      VALUES ?nodeType {{ {types} }}
      ?node a ?nodeType .
      VALUES ?pred {{ {preds} }}
      ?node ?pred ?other .
      VALUES ?otherType {{ {types} }}
      ?other a ?otherType .
    }}
    ORDER BY ?node ?pred ?other ?nodeType ?otherType
    LIMIT {probe} OFFSET {offset_edge}
  }}
}}
ORDER BY ?kind ?node ?other ?pred ?nodeType ?otherType ?label
LIMIT {probe} OFFSET 0"""


def encode_subgraph_cursor(offset_node: int, offset_edge: int) -> str:
    """Opaque cursor for ``subgraph_query`` paging: per-stream offsets."""
    if offset_node < 0 or offset_edge < 0:
        raise ValueError("cursor offsets must be >= 0")
    payload = json.dumps({"n": offset_node, "e": offset_edge}).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii")


def decode_subgraph_cursor(cursor: str | None) -> tuple[int, int]:
    """Inverse of :func:`encode_subgraph_cursor`; raises ``ValueError`` on
    malformed cursors (422 at the endpoint). ``None`` (cursor omitted on the
    first page) is the start of the stream: ``(0, 0)``."""
    if cursor is None:
        return 0, 0
    if not isinstance(cursor, str) or not cursor:
        raise ValueError("cursor must be a non-empty string")
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii"))
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"malformed cursor: {exc}") from exc
    try:
        if not isinstance(payload, dict):
            raise TypeError("cursor payload must be an object")
        offset_node, offset_edge = int(payload["n"]), int(payload["e"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"malformed cursor: {exc}") from exc
    if offset_node < 0 or offset_edge < 0:
        raise ValueError("cursor offsets must be >= 0")
    return offset_node, offset_edge


def expand_query(
    *,
    iri: str,
    relation_iris: Sequence[str],
    label_iris: Sequence[str],
    limit: int,
) -> str:
    """One entity plus its in/out 1-hop neighbours — one call (B2).

    Center row first (``?dir = ""``), then ``in``/``out`` neighbour rows.
    Each branch aggregates (``GROUP BY`` + ``MIN``) so an entity with several
    types/labels yields exactly one row, and ``ORDER BY ?dir ?node ?pred``
    keeps the row stream deterministic under ``LIMIT`` (truncation is stable).
    Edge rows carry ``?pred`` so the endpoint can build contract Edges; the
    center row carries ``?pred = ""``.

    QLever parser constraints (verified live against the dev endpoint):
    - ``FILTER(?pred IN ?p)`` with a *variable* list is rejected — the
      relation set is a ``VALUES ?pred`` inside each branch's WHERE instead.
    - an AS projection may not shadow a body variable — aggregations use
      fresh ``?nt``/``?lblval`` variables.

    The caller owns the limit policy: it clamps the page size to the
    configured max and passes ``page_size + 1`` so the endpoint can detect
    truncation (``Page.truncated``). The template only guards the floor/type,
    it does not re-clamp — re-clamping here would clip the ``+1`` probe at the
    hard max and make truncation undetectable.
    """
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise TypeError(f"limit must be an int, got {limit!r}")
    limit = max(1, limit)
    center = iri_ref(iri)
    relations = iri_list(relation_iris)
    labels = iri_list(label_iris)
    return f"""SELECT ?kind ?dir ?node ?nodeType ?label ?pred WHERE {{
  {{
    SELECT ?node (STR("node") AS ?kind) (STR("") AS ?dir)
           (MIN(?nt) AS ?nodeType) (MIN(?lblval) AS ?label) (STR("") AS ?pred)
    WHERE {{
      VALUES ?node {{ {center} }}
      VALUES ?lbl {{ {labels} }}
      OPTIONAL {{ ?node a ?nt }}
      OPTIONAL {{ ?node ?lbl ?lblval }}
    }}
    GROUP BY ?node
  }}
  UNION {{
    SELECT ?node (STR("out") AS ?dir) (STR("edge") AS ?kind)
           (MIN(?nt) AS ?nodeType) (MIN(?lblval) AS ?label) ?pred
    WHERE {{
      {center} ?pred ?node .
      VALUES ?pred {{ {relations} }}
      VALUES ?lbl {{ {labels} }}
      OPTIONAL {{ ?node a ?nt }}
      OPTIONAL {{ ?node ?lbl ?lblval }}
    }}
    GROUP BY ?node ?pred
  }}
  UNION {{
    SELECT ?node (STR("in") AS ?dir) (STR("edge") AS ?kind)
           (MIN(?nt) AS ?nodeType) (MIN(?lblval) AS ?label) ?pred
    WHERE {{
      ?node ?pred {center} .
      VALUES ?pred {{ {relations} }}
      VALUES ?lbl {{ {labels} }}
      OPTIONAL {{ ?node a ?nt }}
      OPTIONAL {{ ?node ?lbl ?lblval }}
    }}
    GROUP BY ?node ?pred
  }}
}}
ORDER BY ?dir ?node ?pred
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
    """
    limit = clamp_limit(limit)
    if not text.strip():
        raise ValueError("search text must be non-empty")
    pattern = _regex_escape(text.strip())
    return f"""SELECT ?node ?nodeType ?label WHERE {{
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

    ``limit`` bounds the property list. The object's type is deliberately NOT
    joined in: an object carrying several ``rdf:type`` values would fan the
    (pred, obj) row out once per type and duplicate every value in the
    response. A triple store already de-duplicates triples, so each distinct
    (pred, obj) pair is returned exactly once.
    """
    limit = clamp_limit(limit, default=200)
    return f"""SELECT ?pred ?obj WHERE {{
  {iri_ref(iri)} ?pred ?obj .
}}
ORDER BY ?pred ?obj
LIMIT {limit}"""
