"""SPARQL template builders (search, bulk BFS, node info) and IRI helpers.

Vocabulary-agnostic: callers pass IRI lists (data-model classes, relation /
label properties) and the builders emit SPARQL text ready for
``QleverClient.select``. The only free-form input any template accepts is
the search text in :func:`search_query`, which is escaped as a string literal — IRIs are
validated, never concatenated raw.
"""

from __future__ import annotations

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


# -- templates ----------------------------------------------------------------


def _case_variants(text: str) -> list[str]:
    """As typed, first-letter-capitalised, all-lowercase (deduplicated)."""
    variants = [text, text[:1].upper() + text[1:], text.lower()]
    return list(dict.fromkeys(variants))


def search_query(
    *,
    text: str,
    label_iris: list[str],
    limit: int = DEFAULT_SEARCH_LIMIT,
) -> str:
    """Prefix search over label properties - the B5 autocomplete source.

    QLever answers ``STRSTARTS`` on the raw literal with a vocabulary range
    scan, but not ``regex(str(?label), ..., "i")`` (15-30 s live). So case
    insensitivity is approximated by a UNION of up to three capitalisations
    of the text (as typed, first letter upper-cased, all lower-case), each a
    ``STRSTARTS`` prefix filter. The type join happens *after* the inner
    ``LIMIT`` (``limit * 3`` rows, to survive per-node duplicates). The user
    text is only ever emitted as an escaped string literal. ``?lbl`` is
    projected so the endpoint can fold a node's several rows (label-property
    priority, primary-type rule).

    QLever dialect note: the VALUES block is whitespace-separated (see
    :func:`iri_list`).
    """
    limit = clamp_limit(limit)
    text = text.strip()
    if not text:
        raise ValueError("search text must be non-empty")
    branches = " UNION ".join(
        f'{{ ?node ?lbl ?label . FILTER(STRSTARTS(?label, "{_sparql_string_escape(v)}")) }}'
        for v in _case_variants(text)
    )
    return f"""SELECT ?node ?nodeType ?label ?lbl WHERE {{
  {{
    SELECT DISTINCT ?node ?label ?lbl WHERE {{
      VALUES ?lbl {{ {iri_list(label_iris)} }}
      {branches}
      FILTER(isLiteral(?label))
    }}
    LIMIT {limit * 3}
  }}
  ?node a ?nodeType .
}}
ORDER BY ?label"""


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
