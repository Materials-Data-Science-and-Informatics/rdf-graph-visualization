# KANBAN — fullstack graph explorer refactor

Board of record for `refactor/fullstack-graph-explorer`. One row per card; move `Status`
(Backlog → Ready → InProgress → Review → Done). A card is **Ready** exactly when every card
in its `Dep` column is Done. Full DoD text per card: commit history + the plan doc.

**Working agreement**
- One card = one commit/PR referencing the card ID.
- Implementers: whoever picks up the card (main agent or the second kanban agent). Do not
  implement beyond your picked card.
- LLM budget (shared token, limits per https://sdlaml.pages.jsc.fz-juelich.de/ai/guides/blablador_api_access/):
  combined agents stay ≤50 % of internal caps — alias-large ≤15/min, alias-code ≤30/min,
  alias-fast ≤50/min, alias-huge ≤10/min. On 429: honor returned wait, never blind-retry
  (penalty ladder 60 s→3600 s is shared by both agents).
- QLever: cards B* develop against **dev** endpoint only until shipping is planned.
- No push/merge decisions from agents; the owner pushes and merges.

| ID | Card | Milestone | Dep | Wave | Status | Est |
|---|---|---|---|---|---|---|
| F1 | Monorepo restructure (frontend/ tree, Dockerfile paths) | M0 | — | 1 | **Done** (06e4e9f) | 1d |
| F2 | FastAPI skeleton + pytest scaffold (backend/) | M0 | — | 1 | **Done** (this commit) | 0.5d |
| F3 | Freeze API contract (pydantic contract.py ⇄ TS types.ts + drift test) | M0 | — | 1 | **Done** (this commit) | 0.5d |
| F4 | Multi-stage Dockerfile: nginx + uvicorn + supervisord, `/api` proxy | M0 | F1,F2 | 2 | Ready | 1d |
| F6 | `hkg_data_model` pinned integration + validated wrappers | M0 | F2 | 2 | Ready | 1d |
| F7 | HKG conventions: pre-commit, ruff/mypy/pylint, pnpm, eslint flat, husky, REUSE/somesy | M0 | F1,F2 | 2 | Ready | 1d |
| B1 | QLever client (httpx, templates, retries-off-on-429, timeouts, QLEVER_URL) | M1 | F2,F3 | 2 | Ready | 1d |
| F5 | CI: test+lint jobs; `-rc` image on branch tags | M0 | F4 | 3 | Backlog | 0.5d |
| B2 | `/api/expand/{iri}` + `/api/entity/{iri}` | M1 | B1,F6 | 3 | Backlog | 1d |
| B3 | `/api/subgraph?type=&limit=&cursor=` | M1 | B1,F3 | 3 | Backlog | 1.5d |
| B4 | `/api/aggregate` (counts by type) | M1 | B1 | 3 | Backlog | 1d |
| B5 | `/api/search?q=` (autocomplete source) | M1 | B1 | 3 | Backlog | 1d |
| C0 | Tailwind v4 + shadcn/ui foundation; remove Chakra/emotion/framer-motion | M2 | F1,F7 | 3 | Backlog | 1.5d |
| B6 | `/api/config` presets from data-model classes | M1 | B1,F6 | 4 | Backlog | 1d |
| B7 | TTL cache + rate limit middleware | M1 | B2,B3,B4,B5 | 4 | Backlog | 0.5d |
| C1 | Remove rdflib + snapshot path; typed API client | M2 | F1,F3 | 2 | Backlog* | 1d |
| C2 | graphology store (slice merge, aggregates, selection) | M2 | C1 | 4 | Backlog | 1.5d |
| D1 | `GraphRenderer` interface + adapter registry | M3 | C2 | 4 | Backlog | 0.5d |
| B8 | Backend test suite: fixtures + contract | M1 | B7,F6 | 5 | Backlog | 1.5d |
| C3 | URL-synced view state | M2 | C2 | 5 | Backlog | 1d |
| C4 | Replace build-time config with `/api/config` | M2 | C1,B6 | 5 | Backlog | 0.5d |
| D2 | Sigma v3 2D adapter + worker forceatlas2 | M3 | D1 | 5 | Backlog | 2d |
| D3 | cosmos.gl 3D adapter (luma.gl peers pinned) | M3 | D1 | 5 | Backlog | 2d |
| D4 | Renderer toggle (keeps selection/filters/positions) | M3 | D2,D3,C0 | 6 | Backlog | 1d |
| D5 | Benchmark fixture 5k/25k + committed fps numbers | M3 | D2,D3 | 6 | Backlog | 1d |
| E1 | Autocomplete search → fly-to | M4 | C2,B5,C0 | 6 | Backlog | 1d |
| E2 | Entity detail panel + PURL | M4 | C2,B2,C0 | 6 | Backlog | 1.5d |
| E4 | Filter panel + legend from `/api/config` | M4 | C2,C4,C0 | 6 | Backlog | 1d |
| E3 | Aggregate-first landing (typed clusters, expand-on-click) | M4 | D2,B4 | 7 | Backlog | 2d |
| E5 | Performance pass vs budgets (≤1500/expansion, <2 s paint, 50 fps) | M4 | D4,D5,E3 | 7 | Backlog | 1.5d |
| E6 | E2E smoke (Playwright): search→expand→toggle→share | M4 | E1,E2,E4 | 7 | Backlog | 1d |

\* C1's code deps (F1,F3) are Done — it becomes Ready as soon as wave-2 picks are made; it
was kept behind F7 by convention (formatting/lint rules land before new feature code).

**Out of scope (separate plan later):** tagging/ghcr publication, graphviz-deployment changes,
prod rollout/rollback. Board ends at E5+E6 green = benchmarked RC candidate.
