# KANBAN

Status as of 2026-11-05, branch `feat/gpu-explorer` (version 1.0.0.dev0). The earlier
Hermes board (cards F1-E6) is obsolete: the frontend was restarted and the backend
reduced to `/api/{health,config,search,stream,node}`.

## Done

- Backend: BFS streaming (`/api/stream`), snapshot cache with prewarm of the Helmholtz
  Association and 18 centres, fan-out cap, node info, prefix search, fixed labels/class mapping.
- Frontend: WebGPU 3D engine (three.js), cosmos.gl 2D view with communities, hub labels and
  leaf discs, bundles of equivalent nodes, URL parameters, share link, centre dropdown,
  sidebar Starting point/Parameters, localStorage settings, node-count fetch buckets.
- Tooling: pnpm 12.16.1, Node 24, Python 3.14, uv lock, one shared pre-commit setup,
  somesy 0.9.0 monorepo metadata, renamed to hkg-graph-explorer.
- Docs: README rewritten, HANDOFF.md removed.

## In progress / open

- 2D fallback when WebGPU is unavailable (browser support section in README).

## Follow-ups

- TypeScript 7 once typescript-eslint supports it (currently TS 6).
- `pydantic<2.14` cap inherited from hkg-data-model: lift when it is relaxed there.
- Starlette TestClient deprecation (httpx2) in backend tests.
- cffconvert pre-commit hook is pinned to a commit (the 2.0.0 tag has no hook file): switch to a tag when released.
- Migrate CI to GitLab (codebase.helmholtz.cloud/hmc/helmholtz-kg/graph-explorer) in a later session; GitHub Actions stay until then.
- Backend `QLEVER_URL` defaults to the QLever dev endpoint: point deployments at prod.
- Browser verification of the 3D engine on more GPUs/browsers; end-to-end smoke test for the current flow.
- Release 1.0.0 (version bump via somesy, tag, image).
