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


def is_valid_iri(iri: str) -> bool:
    """Boolean form of :func:`assert_valid_iri`."""
    try:
        assert_valid_iri(iri)
    except ValueError:
        return False
    return True


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
    offset: int = 0,
) -> str:
    """One entity plus its in/out 1-hop neighbours — one call (B2).

    Center row first (``?dir = ""``), then ``in``/``out`` neighbour rows.
    Each branch aggregates (``GROUP BY``) so an entity with several types/labels
    yields exactly one row: ``?nodeType`` is a space-separated
    ``GROUP_CONCAT`` of all types (the endpoint picks the contract group), and
    ``?label`` is ``COALESCE(MIN(?l0), MIN(?l1), …)`` over one OPTIONAL per
    label predicate (priority order), and ``ORDER BY ?dir ?node ?pred``
    keeps the row stream deterministic under ``LIMIT`` (truncation is stable).
    Edge rows carry ``?pred`` so the endpoint can build contract Edges; the
    center row carries ``?pred = ""``.

    ``offset`` pages past the deterministic stream (``LIMIT … OFFSET …``):
    the total ORDER BY makes OFFSET pages stable, which is what the
    "load more around this center" flow uses (expand has no cursor; the
    client counts rows). At ``offset > 0`` the center row is outside the
    window — callers already hold the center from the first page.

    QLever parser constraints (verified live against the dev endpoint):
    - ``FILTER(?pred IN ?p)`` with a *variable* list is rejected — the
      relation set is a ``VALUES ?pred`` inside each branch's WHERE instead.
    - an AS projection may not shadow a body variable — aggregations use
      fresh ``?nt``/``?l<i>`` variables.

    The caller owns the limit policy: it clamps the page size to the
    configured max and passes ``page_size + 1`` so the endpoint can detect
    truncation (``Page.truncated``). The template only guards the floor/type,
    it does not re-clamp — re-clamping here would clip the ``+1`` probe at the
    hard max and make truncation undetectable.
    """
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise TypeError(f"limit must be an int, got {limit!r}")
    if not isinstance(offset, int) or isinstance(offset, bool):
        raise TypeError(f"offset must be an int, got {offset!r}")
    limit = max(1, limit)
    offset = max(0, offset)
    center = iri_ref(iri)
    relations = iri_list(relation_iris)
    # One OPTIONAL per label predicate (priority order) + COALESCE of the MINs.
    # An outer ``VALUES ?lbl`` + ``?node ?lbl ?v`` returns unbound labels and
    # is slow on QLever (verified live); per-predicate OPTIONALs are fast.
    label_vars = [f"?l{i}" for i in range(len(label_iris))]
    label_opts = "\n".join(
        f"      OPTIONAL {{ ?node {iri_ref(iri)} {var} }}"
        for iri, var in zip(label_iris, label_vars)
    )
    label_agg = (
        f"COALESCE({', '.join(f'MIN({v})' for v in label_vars)})"
        if label_vars
        else '""'
    )
    return f"""SELECT ?kind ?dir ?node ?nodeType ?label ?pred WHERE {{
  {{
    SELECT ?node (STR("node") AS ?kind) (STR("") AS ?dir)
           (GROUP_CONCAT(DISTINCT STR(?nt); separator=" ") AS ?nodeType)
           ({label_agg} AS ?label) (STR("") AS ?pred)
    WHERE {{
      VALUES ?node {{ {center} }}
      OPTIONAL {{ ?node a ?nt }}
{label_opts}
    }}
    GROUP BY ?node
  }}
  UNION {{
    SELECT ?node (STR("out") AS ?dir) (STR("edge") AS ?kind)
           (GROUP_CONCAT(DISTINCT STR(?nt); separator=" ") AS ?nodeType)
           ({label_agg} AS ?label) ?pred
    WHERE {{
      {center} ?pred ?node .
      VALUES ?pred {{ {relations} }}
      OPTIONAL {{ ?node a ?nt }}
{label_opts}
    }}
    GROUP BY ?node ?pred
  }}
  UNION {{
    SELECT ?node (STR("in") AS ?dir) (STR("edge") AS ?kind)
           (GROUP_CONCAT(DISTINCT STR(?nt); separator=" ") AS ?nodeType)
           ({label_agg} AS ?label) ?pred
    WHERE {{
      ?node ?pred {center} .
      VALUES ?pred {{ {relations} }}
      OPTIONAL {{ ?node a ?nt }}
{label_opts}
    }}
    GROUP BY ?node ?pred
  }}
}}
ORDER BY ?dir ?node ?pred
LIMIT {limit} OFFSET {offset}"""


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
    """Total entity counts per ``rdf:type`` — the B4 aggregate source.

    No LIMIT: this is the one unbounded query (counts, not rows). ``?type``
    is every type IRI in the dataset, not just the pinned data-model
    classes; the endpoint folds the rest into the ``Unknown`` bucket.
    ``?type`` is the secondary sort key so equal counts order
    deterministically.
    """
    return """SELECT ?type (COUNT(?s) AS ?count) WHERE {
  ?s a ?type .
}
GROUP BY ?type
ORDER BY DESC(?count) ?type"""


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


# -- bulk BFS building blocks (flat queries over VALUES chunks) ----------------
#
# The bulk fetcher (``app.bulk``) never asks for edges and node attributes in
# one joined query: an OPTIONAL join multiplies rows and times out on the
# shared endpoint (measured live). Instead it runs three flat queries per
# chunk of ~2k IRIs. QLever quirk (verified live): ``OPTIONAL { ?n ?p ?v }``
# with ``?p`` bound by an outer VALUES misbehaves, so labels use a plain join
# (``VALUES ?n`` + ``VALUES ?p`` + ``?n ?p ?l``) and the fold-by-priority
# happens in Python.


def _limit_clause(limit: int | None) -> str:
    if limit is None:
        return ""
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
        raise ValueError(f"limit must be an int >= 1, got {limit!r}")
    return f"\nLIMIT {limit}"


def _nonempty(name: str, iris: Sequence[str]) -> None:
    if not iris:
        raise ValueError(f"{name} must not be empty")


def edges_construct_query(
    *, frontier: Sequence[str], relation: str, limit: int | None = None
) -> str:
    """Edges of ONE relation touching a frontier chunk, both directions.

    ``CONSTRUCT { ?s <relation> ?o }`` — N-Triples is the fastest result
    format for edge sets (measured live: 2-hop/10k edges ~16s vs ~25s for
    SELECT). Both directions run as one ``UNION`` query: the frontier
    ``VALUES`` block is the bulk of the query text and is parsed/planned
    once instead of twice, and the request count (a shared, rate-limited
    endpoint) halves. Each branch binds both ``?s`` and ``?o`` (the
    frontier node sits in ``?s`` for ``out``, in ``?o`` for ``in``) and
    requires the *other* end to be an IRI (no literals / blank nodes).
    An edge between two frontier nodes matches both branches; CONSTRUCT
    output is not guaranteed duplicate-free, callers de-duplicate.

    One relation per query keeps the predicate a constant (no ``?p``
    variable bound by VALUES, see the quirk note above) and bounds each
    request's cost.
    """
    _nonempty("frontier", frontier)
    nodes = iri_list(frontier)
    rel = iri_ref(relation)
    return f"""CONSTRUCT {{ ?s {rel} ?o }} WHERE {{
  {{
    VALUES ?s {{ {nodes} }}
    ?s {rel} ?o .
    FILTER(isIRI(?o))
  }}
  UNION {{
    VALUES ?o {{ {nodes} }}
    ?s {rel} ?o .
    FILTER(isIRI(?s))
  }}
}}{_limit_clause(limit)}"""


def edges_multi_construct_query(
    *,
    frontier: Sequence[str],
    relations: Sequence[str],
    limit: int | None = None,
) -> str:
    """Edges over ALL *relations* touching a frontier chunk — one query.

    Same shape as :func:`edges_construct_query` but with ``VALUES ?p`` as a
    plain join inside each branch and ``CONSTRUCT { ?s ?p ?o }``. (The
    VALUES-bound ``?p`` quirk above only bites inside ``OPTIONAL``.) Most
    configured relations are literal-valued and match nothing here, so one
    request replaces one per relation. *limit* caps the result rows (hub
    protection).
    """
    _nonempty("frontier", frontier)
    _nonempty("relations", relations)
    nodes = iri_list(frontier)
    preds = iri_list(relations)
    return f"""CONSTRUCT {{ ?s ?p ?o }} WHERE {{
  {{
    VALUES ?s {{ {nodes} }}
    VALUES ?p {{ {preds} }}
    ?s ?p ?o .
    FILTER(isIRI(?o))
  }}
  UNION {{
    VALUES ?o {{ {nodes} }}
    VALUES ?p {{ {preds} }}
    ?s ?p ?o .
    FILTER(isIRI(?s))
  }}
}}{_limit_clause(limit)}"""


def types_query(*, nodes: Sequence[str], type_iris: Sequence[str] = ()) -> str:
    """Flat ``?n ?t`` rdf:type rows for a chunk of nodes.

    ``type_iris`` (optional) restricts ``?t`` through a plain ``VALUES``
    join, which cuts the row count for nodes with many irrelevant types.
    """
    _nonempty("nodes", nodes)
    restrict = f"\n  VALUES ?t {{ {iri_list(type_iris)} }}" if type_iris else ""
    return f"""SELECT ?n ?t WHERE {{
  VALUES ?n {{ {iri_list(nodes)} }}{restrict}
  ?n a ?t .
}}"""


def labels_query(*, nodes: Sequence[str], label_iris: Sequence[str]) -> str:
    """Flat ``?n ?p ?l`` label rows for a chunk (no OPTIONAL, see above).

    ``?p`` is projected so the caller can fold by label-property priority.
    """
    _nonempty("nodes", nodes)
    _nonempty("label_iris", label_iris)
    return f"""SELECT ?n ?p ?l WHERE {{
  VALUES ?n {{ {iri_list(nodes)} }}
  VALUES ?p {{ {iri_list(label_iris)} }}
  ?n ?p ?l .
}}"""


def node_relations_query(*, iri: str, relation_iris: Sequence[str]) -> str:
    """Per-relation, per-direction IRI-edge counts of one node (info panel).

    One aggregate SELECT with plain joins (``VALUES ?s``/``?o`` + ``VALUES
    ?p``, no OPTIONAL), IRI-only other end, ``GROUP BY ?p ?dir``. Rows: ``?p
    ?dir ?n`` with ``?dir`` ``out`` | ``in``. Counts are edges (triples), not
    distinct neighbours; a self-loop counts in both directions. Uncapped: measured live, a hub
    with 53k in-links counts in ~0.2s.
    """
    _nonempty("relation_iris", relation_iris)
    node, preds = iri_ref(iri), iri_list(relation_iris)

    def side(direction: str, bound: str, other: str) -> str:
        return f"""{{ SELECT ?p ("{direction}" AS ?dir) WHERE {{
      VALUES ?{bound} {{ {node} }}
      VALUES ?p {{ {preds} }}
      ?s ?p ?o .
      FILTER(isIRI(?{other}))
    }} }}"""

    return f"""SELECT ?p ?dir (COUNT(*) AS ?n) WHERE {{
  {side("out", "s", "o")}
  UNION
  {side("in", "o", "s")}
}}
GROUP BY ?p ?dir"""
