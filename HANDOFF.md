# Handoff — HKG Graph Explorer (start here in a new session)

Repo: `Materials-Data-Science-and-Informatics/rdf-graph-visualization` (GitHub).
Branch: `refactor/fullstack-graph-explorer` (this file's commit is the tip;
`git pull` first). Dev machine: a Linux VM with the same branch checked out
at `/home/ubuntu/fzj/wt-d5` (frontend deps installed; backend venv at
`wt-d5/backend/.venv`).

## Goal (product definition, settled)

A graph explorer over REAL Helmholtz Knowledge Graph entity data (SPARQL
endpoint QLever, ~248M triples, `https://sparql.unhide.helmholtz-metadaten.de/sparql`).

- The app must always show real entities — never a category/aggregate screen
  first. No upload features. The only optional input is a root entity id;
  the default root is `https://ror.org/0281dp749` (Helmholtz Association),
  overridable via `VITE_ROOT_IRI` (see `frontend/src/config.ts`,
  `ROOT_ENTITY_IRI`).
- On load: fetch the real subgraph around the root —
  `GET /api/expand/{iri}` with a relation allow-list (`ROOT_RELATION_NAMES`)
  and `limit=150`, and "Load more" continues the same stream with `offset`.
- Two renderers over the same data, switchable in the engine toggle:
  - **cosmos.gl in its native 3D** (live GPU force simulation, gallery-like
    motion, orbit camera) — the DEFAULT engine (`frontend/src/render/cosmos3d.ts`);
  - **sigma 2D** (deterministic force layout, `frontend/src/render/sigma.ts`).
- Clicking a node not yet on screen fetches and merges that node's own
  neighborhood (center + 1 hop). The class-aggregate ring view exists only
  behind the "Show overview" button.

## Already done (do not redo)

- Backend FastAPI in `backend/`: bounded slices, cursor paging, aggregate,
  search, cache/rate-limit middleware, ~209 tests. `/api/expand/{iri}`
  supports `offset` (stable windows — the query has a total ORDER BY) and a
  `relations` allow-list (short names like `affiliation` or full IRIs,
  resolved against the pinned data model; 422 if nothing resolves).
- Frontend React+TS+Vite in `frontend/` (pnpm): Tailwind/shadcn re-skin,
  engine registry with a runtime toggle, sigma 2D + cosmos 2D + cosmos 3D
  adapters, aggregate overview (on-demand), class filter, autocomplete
  search → fly-to, entity detail panel, root landing + offset-paged
  center-expand ("Load more" around a center), 165 headless contract tests.
- Gates green at current tip: backend `check.sh` (209) and frontend
  `pnpm run check` + `pnpm test` (165).

## Open problems (priority order)

1. **Node labels degrade to raw IRIs (backend, high).**
   `backend/app/templates.py::expand_query` aggregates the label as
   `MIN(?lblval)` over `VALUES ?lbl {prefName name identifier}`. QLever
   returns `?label` UNBOUND whenever the matched values mix literals and
   IRIs (e.g. the root has a `schema:name` literal AND `identifier` IRIs),
   so `api_b2.py::_fold_expand_rows` falls back to the raw IRI as label for
   the center AND many neighbors (Person names lost). Already tried live,
   both failed: `IF(cond, val, UNDEF)` — QLever parser rejects `UNDEF`;
   `BIND(IF/CONCAT('rank', STR(?lblval)))` + `SUBSTR(MIN(...), 2)` — still
   unbound. Ideas to verify against live QLever: `GROUP_CONCAT` folded in
   Python, per-label UNION branches with per-branch aggregation, or a small
   separate label query per page in the endpoint.
   Repro: run the endpoint (commands below) and inspect `nodes[0].label` —
   it shows `https://ror.org/0281dp749` instead of "Helmholtz Association of
   German Research Centres" (which `/api/entity/...` DOES return).
2. **Root renders as `Unknown` (gray) — class mapping decision needed.**
   The pinned contract classes are DataCatalog, Dataset, Document, Event,
   Institution, Instrument, Software, Person, Unknown (`backend/app/contract.py`)
   — there is no `Organization`. The root is typed `schema:FundingAgency /
   GovernmentOrganization / Organization` and `MIN(?nt)` picks
   FundingAgency → `Unknown`. Either rank preferred type IRIs inside the
   expand query, or map `schema:Organization → Institution` at the contract
   boundary (ask the owner which they prefer before changing the contract).
3. **First root expand ~23s against live QLever.** The 12-relation list at
   `limit=150` forces QLever to materialize + sort the root's full
   neighborhood (100k+ inbound links). Trim `ROOT_RELATION_NAMES`
   (e.g. drop `publisher`/`author`), lower the limit, add per-branch LIMITs
   in the query, or cache responses.
4. **The 3D renderer has never been seen in a real browser.**
   `cosmos3d.ts` is verified only by headless contract tests. Manually /
   with Playwright validate: WebGL mount, orbit/zoom/drag, click→select,
   simulation behavior when new pages merge mid-flight, and the 3D→2D engine
   switch handoff (`getPositions()` reads the live layout back). NOTE:
   cosmos.gl 3.5.1 renders NO point labels inside the engine (there are no
   label config keys) — the gallery look needs labels; plan a hover tooltip
   + selection panel, or an overlay layer.
5. **Regression checks around the new landing.** Class filter vs center
   paging ("Load more" after filtering — the filter re-queries a typed slice
   and clears the center chain; verify status text + button states); URL
   deep links (`type=`, `cursor=`, `sel=`, `ov=`, `engine=`); "Show overview"
   → "Explore slice" round trip.
6. **End-to-end automation is stale.** Any Playwright/E2E smoke must be
   rewritten for the new flow: landing shows the root subgraph, default
   engine cosmos3d, expand-on-click fetches neighborhoods, Load more uses
   `offset`. Performance budgets also need re-scoping for a live simulation.

## Commands

```bash
# backend (dev)
cd backend && .venv/bin/python -m venv .venv 2>/dev/null; .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m uvicorn app.main:app --port 8000
PATH=$PWD/.venv/bin:$PATH bash check.sh          # full gate

# frontend (dev; Vite proxies /api -> 127.0.0.1:8000)
cd frontend && corepack enable && pnpm install && pnpm dev
pnpm run check && pnpm test                       # full gate

# live data check
curl "http://127.0.0.1:8000/api/expand/https%3A%2F%2Fror.org%2F0281dp749?limit=150&relations=affiliation,creator,member,memberOf,parentOrganization,subOrganization,isPartOf,funding,funder,sponsor"

# full-stack container (nginx SPA + uvicorn, single container)
podman build -t hkg-graph-explorer . && podman run -d -p 8080:80 hkg-graph-explorer
```

Working style: verify every claim against the live QLever endpoint or the
real browser before calling it fixed; the SPARQL dialect has real
restrictions (see comments in `backend/app/templates.py`).
