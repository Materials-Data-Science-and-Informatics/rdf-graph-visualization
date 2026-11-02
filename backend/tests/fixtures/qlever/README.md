# Recorded QLever responses (fixture replay for tests)

Each fixture is `<name>.headers` (first status line + header lines) and
`<name>.body` (raw response body), replayed by `tests/test_qlever.py` via
`httpx.MockTransport` — no network in tests.

## Recorded live from the dev endpoint
(`https://sparql.unhide.helmholtz-metadaten.de/sparql`, 2026-11-02, POST,
Accept: application/sparql-results+json)

| fixture | request | why |
|---|---|---|
| `select_ok` | `SELECT ?s ?p ?o WHERE { ?s a ?t . ?s ?p ?o } LIMIT 2` | happy path: uri + literal bindings, QLever `meta` block |
| `select_empty` | `SELECT ?s WHERE { ?s a <...NoSuchType_ZZZ_999> } LIMIT 10` | empty result set |
| `ask_ok` | `ASK { ?s ?p ?o }` | boolean answer |
| `select_parse_error_400` | `SELEC WHERE { }` | error path: QLever parser error JSON (`exception` field) |

## Synthetic (endpoint state we must not provoke on a shared token)

| fixture | why |
|---|---|
| `rate_limited_429` | 429 with `Retry-After: 120` (delta-seconds; shared-token penalty ladder 60s..3600s) |
| `rate_limited_429_nohdr` | 429 without `Retry-After` (client must fall back to the 60s ladder floor) |
| `server_error_500` | 5xx pass-through |
| `non_json_200` | 200 with a non-JSON body (defensive path) |

Re-record live fixtures with:
`curl -sS -X POST "$QLEVER_URL" -H 'Accept: application/sparql-results+json' \
  --data-urlencode 'query=...' -D <name>.headers -o <name>.body`
