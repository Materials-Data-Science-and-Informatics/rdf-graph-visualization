"""Generate the 5k / 25k benchmark fixtures from the HKG QLever dev endpoint.

Card D5. The benchmark harness (``frontend/scripts/bench-fps.{ts,mjs}``) loads
these committed fixtures, so the measured fps numbers are reproducible
without re-querying the endpoint.

Endpoint etiquette (shared dev endpoint, 429 penalty ladder 60s..3600s — see
``backend/app/qlever.py``):

- a small, bounded number of top-k SELECTs;
- every response is cached to ``--cache-dir``; re-running with the same cache
  NEVER re-queries the endpoint;
- on a 429 the script prints ``Retry-After`` and exits 3 (no retry — the
  wait belongs to the caller); on a 5xx it exits 4.

Extraction (deterministic — the same query answers always select the same
entities):

1. entity counts per data-model class (sizes the per-class LIMITs);
2. per class, the first ``N_t`` entities in IRI order with one label each
   (lexicographically smallest of ``prefName``/``name``/``identifier``);
3. the classes are interleaved round-robin in contract order
   (DataCatalog, Dataset, Document, Event, Institution, Instrument, Software,
   Person), so the fixture is a prefix-stable mix of every class the dataset
   actually contains;
4. edges: directed pairs ``(src, dst)`` over the app's 16 relation
   properties with both endpoints typed, restricted to the node set via a
   VALUES list, ordered, ``LIMIT --edge-limit`` (one scoped scan; the in-edge
   direction over the same pool yields the same in-set triples, and the app
   only ever renders intra-slice edges anyway).

The 5k fixture is a strict prefix subset of the 25k (no extra traffic).

Usage (from the repo root, with the backend venv so ``httpx`` is available):

    backend/.venv/bin/python scripts/generate-qllever-fixtures.py

Outputs:
    frontend/scripts/fixtures/qllever-dev-25k.json
    frontend/scripts/fixtures/qllever-dev-5k.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import httpx

# The app's exact IRI lists — build_config() against the pinned hkg_data_model
# (backend/app/presets.py). Keep in lockstep with the data-model pin.
TYPES = [
    "https://schema.org/DataCatalog",
    "https://schema.org/Dataset",
    "https://schema.org/Document",
    "https://schema.org/Event",
    "https://schema.org/Institution",
    "https://schema.org/Instrument",
    "https://schema.org/Software",
    "https://schema.org/Person",
]
RELATIONS = [
    "https://schema.org/affiliation",
    "https://schema.org/author",
    "https://schema.org/citation",
    "https://schema.org/codeRepository",
    "https://schema.org/contributor",
    "https://schema.org/creator",
    "https://schema.org/includedInDataCatalog",
    "https://schema.org/isPartOf",
    "https://schema.org/license",
    "https://schema.org/maintainer",
    "https://schema.org/organizer",
    "https://schema.org/parentOrganization",
    "https://schema.org/performer",
    "https://schema.org/provider",
    "https://schema.org/publisher",
    "https://schema.org/subOrganization",
]
LABELS = [
    "https://schema.org/prefName",
    "https://schema.org/name",
    "https://schema.org/identifier",
]
GROUP_OF = {t: t.rsplit("/", 1)[-1] for t in TYPES}

DEFAULT_ENDPOINT = "https://sparql.unhide.helmholtz-metadaten.de/sparql"
EDGE_LIMIT_FALLBACK = 200000


class QueryRejected(Exception):
    """4xx from the endpoint — retrying the identical query cannot help."""


def post(endpoint: str, query: str, cache_dir: Path, cache_key: str) -> dict:
    cache_file = cache_dir / f"{cache_key}.json"
    if cache_file.exists():
        print(f"  cache hit: {cache_key}")
        return json.loads(cache_file.read_text())
    t0 = time.monotonic()
    resp = httpx.post(
        endpoint,
        data={"query": query},
        headers={"Accept": "application/sparql-results+json"},
        timeout=120.0,
    )
    dt = time.monotonic() - t0
    if resp.status_code == 429:
        wait = resp.headers.get("retry-after")
        print(f"RATE LIMITED (429) on {cache_key}; Retry-After: {wait}")
        print("Honour the wait and re-run with the same --cache-dir (no retry here).")
        sys.exit(3)
    if 400 <= resp.status_code < 500:
        raise QueryRejected(f"HTTP {resp.status_code}: {resp.text[:300]}")
    if resp.status_code != 200:
        print(
            f"SERVER ERROR (HTTP {resp.status_code}) on {cache_key}: {resp.text[:300]}"
        )
        sys.exit(4)
    payload = resp.json()
    cache_file.write_text(json.dumps(payload))
    rows = (payload.get("results") or {}).get("bindings") or []
    meta = payload.get("meta", {}).get("query-time-ms")
    print(f"  {cache_key}: {len(rows)} rows in {dt:.1f}s (query {meta}ms)")
    return payload


def rows_of(payload: dict) -> list[dict]:
    return (payload.get("results") or {}).get("bindings") or []


def lit(row: dict, var: str) -> str | None:
    cell = row.get(var)
    if not cell:
        return None
    return str(cell.get("value", ""))


def iri(row: dict, var: str) -> str | None:
    cell = row.get(var)
    if not cell or cell.get("type") != "uri":
        return None
    return str(cell.get("value", ""))


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(
        description="Generate the 5k/25k benchmark fixtures from the HKG QLever dev endpoint."
    )
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument(
        "--cache-dir",
        default=str(repo_root / ".cache" / "qllever-fixtures"),
        help="response cache; keep it so re-runs never re-query the endpoint",
    )
    parser.add_argument(
        "--out-dir",
        default=str(repo_root / "frontend" / "scripts" / "fixtures"),
    )
    parser.add_argument("--total-25k", type=int, default=25000)
    parser.add_argument("--total-5k", type=int, default=5000)
    parser.add_argument("--edge-limit", type=int, default=60000)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    endpoint = args.endpoint.rstrip("/")
    cache_dir = Path(args.cache_dir)
    out_dir = Path(args.out_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    total_big = args.total_25k
    total_small = args.total_5k

    # 1) per-type counts -> exact per-type LIMITs that sum to total_big.
    count_q = """SELECT ?t (COUNT(?s) AS ?c) WHERE { ?s a ?t . } GROUP BY ?t ORDER BY DESC(?c)"""
    counts: dict[str, int] = {}
    for r in rows_of(post(endpoint, count_q, cache_dir, "counts")):
        t, c = iri(r, "t"), lit(r, "c")
        if t in GROUP_OF and c:
            counts[t] = int(c)
    print(
        "per-type counts:", {GROUP_OF[t]: c for t, c in counts.items() if t in GROUP_OF}
    )

    available = {t: min(counts.get(t, 0), total_big) for t in TYPES}
    per_type = {t: min(total_big // len(TYPES), available[t]) for t in TYPES}
    # Distribute any shortfall (a class with fewer entities) to classes with
    # headroom, round-robin in contract order (deterministic).
    deficit = total_big - sum(per_type.values())
    i = 0
    while deficit > 0 and i < 1_000_000:
        t = TYPES[i % len(TYPES)]
        if per_type[t] < available[t]:
            per_type[t] += 1
            deficit -= 1
        i += 1
    if deficit > 0:
        print(
            f"NOTE: dataset has fewer than {total_big} entities; total = {sum(per_type.values())}"
        )
    print("per-type node limits:", {GROUP_OF[t]: n for t, n in per_type.items()})

    # 2) per-type node lists.
    types_list = " ".join(f"<{t}>" for t in TYPES)
    preds_list = " ".join(f"<{p}>" for p in RELATIONS)
    labels_list = " ".join(f"<{l}>" for l in LABELS)
    nodes_by_type: dict[str, list[dict]] = {}
    for t in TYPES:
        n = per_type[t]
        if n == 0:
            nodes_by_type[t] = []
            print(f"  {GROUP_OF[t]}: 0 entities (skipped)")
            continue
        q = f"""SELECT ?node (MIN(?lblval) AS ?label) WHERE {{
  ?node a <{t}> .
  OPTIONAL {{ ?node ?lbl ?lblval . VALUES ?lbl {{ {labels_list} }} }}
}}
GROUP BY ?node
ORDER BY ?node
LIMIT {n}"""
        out = []
        for r in rows_of(post(endpoint, q, cache_dir, f"nodes-{GROUP_OF[t]}")):
            node = iri(r, "node")
            if node:
                out.append({"id": node, "label": lit(r, "label") or ""})
        nodes_by_type[t] = out
        print(f"  {GROUP_OF[t]}: fetched {len(out)}/{n}")

    # 3) round-robin interleave (contract type order) — prefix-stable.
    interleaved: list[dict] = []
    idx = {t: 0 for t in TYPES}
    while len(interleaved) < sum(per_type.values()):
        progressed = False
        for t in TYPES:
            if idx[t] < len(nodes_by_type[t]):
                node = dict(nodes_by_type[t][idx[t]])
                node["group"] = GROUP_OF[t]
                interleaved.append(node)
                idx[t] += 1
                progressed = True
        if not progressed:
            break
    nodes_big = interleaved[:total_big]
    nodes_small = interleaved[:total_small]
    print(f"interleaved: {len(nodes_big)} nodes (small subset: {len(nodes_small)})")

    # 4) edges over the app's 16 relations, both endpoints typed, scoped to
    #    the node set with a VALUES list.
    all_ids = [n["id"] for n in nodes_big]
    values_src = "\n".join(f"<{s}>" for s in all_ids)
    edge_q = f"""SELECT DISTINCT ?src ?dst ?p WHERE {{
  VALUES ?src {{
{values_src}
  }}
  VALUES ?t {{ {types_list} }}
  VALUES ?p {{ {preds_list} }}
  ?src a ?t .
  ?src ?p ?dst .
  ?dst a ?t .
}}
ORDER BY ?src ?dst ?p
LIMIT {args.edge_limit}"""
    try:
        edge_rows = rows_of(post(endpoint, edge_q, cache_dir, "edges-values"))
    except QueryRejected as exc:
        print(f"VALUES list rejected ({exc}); falling back to an unscoped scan")
        edge_q = f"""SELECT DISTINCT ?src ?dst ?p WHERE {{
  VALUES ?t {{ {types_list} }}
  VALUES ?p {{ {preds_list} }}
  ?src a ?t .
  ?src ?p ?dst .
  ?dst a ?t .
}}
ORDER BY ?src ?dst ?p
LIMIT {EDGE_LIMIT_FALLBACK}"""
        edge_rows = rows_of(post(endpoint, edge_q, cache_dir, "edges-fallback"))

    idset_big = set(all_ids)
    idset_small = {n["id"] for n in nodes_small}
    seen: set[tuple[str, str]] = set()
    links_big: list[dict] = []
    links_small: list[dict] = []
    for r in edge_rows:
        s, d, p = iri(r, "src"), iri(r, "dst"), iri(r, "p")
        if not (s and d and p):
            continue
        if (s, d) in seen:
            continue
        seen.add((s, d))
        if s in idset_big and d in idset_big:
            label = p.rsplit("/", 1)[-1]
            links_big.append({"source": s, "target": d, "label": label})
            if s in idset_small and d in idset_small:
                links_small.append({"source": s, "target": d, "label": label})
    print(f"edges in-set: big -> {len(links_big)}, small -> {len(links_small)}")

    # 5) write the fixtures.
    def write(name: str, nodes: list[dict], links: list[dict]) -> None:
        doc = {
            "meta": {
                "name": name,
                "provenance": "HKG QLever dev endpoint (card D5); regenerate with "
                "scripts/generate-qllever-fixtures.py (responses cached, no re-query)",
                "endpoint": endpoint,
                "retrieved_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "node_count": len(nodes),
                "link_count": len(links),
                "notes": "Deterministic extraction: first N_t entities per data-model "
                "class (ORDER BY ?node), round-robin interleave in contract class "
                "order; one label per node (lexicographically smallest of "
                "prefName/name/identifier); directed edges over the app's 16 "
                "relation properties, de-duplicated per (source, target) pair, "
                "edge query LIMIT 60000. Document/Institution/Instrument do not "
                "occur in the dev dataset (2026-11-03), so only present classes "
                "appear; the small fixture is a strict prefix subset of the large.",
            },
            "nodes": nodes,
            "links": links,
        }
        path = out_dir / name
        path.write_text(json.dumps(doc, separators=(",", ":")))
        print(f"wrote {path} ({path.stat().st_size / 1e6:.2f} MB)")

    write("qllever-dev-25k.json", nodes_big, links_big)
    write("qllever-dev-5k.json", nodes_small, links_small)
    print("DONE")


if __name__ == "__main__":
    main()
