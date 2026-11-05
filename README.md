# HKG Graph Explorer

> [!WARNING]
> In development (version 1.0.0.dev0). The explorer is adapted to the Helmholtz Knowledge Graph (HKG) data model, which limits its flexibility for other data.

## Description

HKG Graph Explorer is a service of [unhide](https://unhide.helmholtz-metadaten.de/) that shows the neighbourhood of an entity of the Helmholtz Knowledge Graph as an interactive graph. The default starting point is the Helmholtz Association (`https://ror.org/0281dp749`).

The backend queries the HKG SPARQL endpoint (QLever), walks the graph breadth-first from the starting node and streams nodes and edges as NDJSON (`/api/stream`). The frontend is a typed client that lays the graph out and renders it.

## Features

- 3D view: force layout computed on the GPU with three.js WebGPU. 2D view: cosmos.gl with communities (Louvain), hub labels and leaf nodes arranged around their hub.
- Left click on a node: details card. Right click: make the node the starting point.
- Search with autocomplete; choosing a result makes it the starting point.
- Starting point: free IRI input or a dropdown of the Helmholtz centres.
- Parameters: number of nodes, depth, connections per node (fan-out cap), 2D/3D. Settings are remembered in the browser (localStorage).
- Structurally equivalent nodes are bundled into one node; the bundle card lists its members.
- Share button copies a link to the current view ([URL parameters](#url-parameters)).

## Browser support

The 3D view needs WebGPU (current Chrome, Edge, Safari 26, Firefox 141+ on supported hardware). Without WebGPU the app opens in the 2D view.

## Local development

Requirements: [uv](https://docs.astral.sh/uv/), Node 24, pnpm 12.16.1 (`corepack enable`).

```bash
# backend (http://127.0.0.1:8000)
cd backend && uv sync --extra dev
uv run uvicorn app.main:app --port 8000

# frontend (http://localhost:5173, Vite proxies /api to 127.0.0.1:8000;
# override with API_PROXY_TARGET)
cd frontend && pnpm install && pnpm dev
```

Checks:

```bash
bash scripts/check.sh                  # backend (ruff, mypy, pylint, pytest) + frontend (tsc, eslint, prettier)
cd frontend && pnpm test               # frontend unit tests (vitest)
uvx pre-commit install                 # git hooks (also run on pre-push: tests)
uvx pre-commit run --all-files
```

## Configuration

Backend (environment variables, defaults in `backend/app/settings.py`):

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `QLEVER_URL` | HKG QLever dev endpoint | SPARQL endpoint |
| `QLEVER_TIMEOUT_S` | `30` | Per-request timeout |
| `QLEVER_CONCURRENCY` | `4` | Parallel SPARQL requests |
| `QLEVER_DEFAULT_LIMIT` / `QLEVER_MAX_LIMIT` | `500` / `5000` | Default and maximum result limit |
| `STREAM_MAX_NODES` | `100000` | Upper bound for the `nodes` request parameter |
| `STREAM_MAX_HOPS` | `8` | Upper bound for the depth |
| `STREAM_MAX_TIME_BUDGET_S` | `300` | Upper bound for the time budget of one stream |
| `STREAM_MULTI_RELATION` | `1` | One edge query per relation instead of one per chunk |
| `STREAM_FANOUT` | `200` | Default cap of new neighbours per node and hop (0 = no cap) |
| `DEFAULT_ROOT_IRI` | `https://ror.org/0281dp749` | Default starting point |
| `DEFAULT_MAX_NODES` | `5000` | Node count of the prewarmed snapshots |
| `PREWARM_ROOTS` | the 18 Helmholtz centres | Comma-separated extra roots to prewarm |
| `STREAM_CACHE_DIR` | `backend/.cache/stream` (`/var/cache/hkg-stream` in the image) | Snapshot cache directory |
| `STREAM_CACHE_TTL_S` | `21600` | Snapshot lifetime; `<= 0` disables cache and prewarm |
| `STREAM_REFRESH_S` | `0.8 * TTL` | Prewarm rebuild interval (0 disables) |
| `STREAM_CACHE_MAX_BYTES` | `1073741824` | Cache size limit |

Frontend: `VITE_ROOT_IRI` (build time) overrides the default starting point.

## Container

One image serves the frontend (nginx, port 80) and the API (uvicorn, proxied under `/api`), run by supervisord. Mount a volume at `/var/cache/hkg-stream` to keep the snapshot cache across restarts.

```bash
docker build -t hkg-graph-explorer .
docker run -p 8080:80 hkg-graph-explorer
```

GitHub Actions (`.github/workflows/`) run checks and build the image.

## Project layout

- `backend/app/`: FastAPI app (`main.py`, `stream.py` BFS streaming, `snapshot.py` cache, `search.py`, `node.py`, `settings.py`), tests in `backend/tests/`.
- `frontend/src/`: `engine/` (WebGPU 3D), `engine2d/` (cosmos.gl 2D, communities), `components/`, `lib/` (API client, stores, URL parameters).
- `docker/`: nginx and supervisord configuration. `scripts/check.sh`: aggregate check.
- `.somesy.toml` (with `backend/` and `frontend/` variants): single source of project metadata, synced into `CITATION.cff`, `codemeta.json`, `pyproject.toml` and `package.json` (`uvx --from somesy==0.9.0 somesy sync`).

## URL parameters

The explorer can be opened with its settings in the query string. URL values apply to that visit only (they are not saved) and override saved settings; invalid values are ignored or clamped.

| Parameter | Meaning |
| --------- | ------- |
| `root`    | IRI (http/https) of the starting node |
| `nodes`   | Number of nodes shown (50 to 100000) |
| `depth`   | Maximum hops from the root (1 to 8) |
| `fanout`  | Connections per node (0 = no cap, up to 100000) |
| `dim`     | `2` or `3` |
| `select`  | IRI of a node whose details card opens once it is in the shown window |

Example: `/?root=https%3A%2F%2Fexample.org%2Fa&depth=3&dim=2&select=https%3A%2F%2Fexample.org%2Fb`

## How to Cite

If you want to cite this project in your scientific work,
please use the [citation file](https://citation-file-format.github.io/)
in the [repository](https://github.com/Materials-Data-Science-and-Informatics/rdf-graph-visualization/blob/main/CITATION.cff).

## Acknowledgements

We kindly thank all authors and contributors.

### Third-party Libraries

Main open-source libraries (see `frontend/package.json` and `backend/pyproject.toml` for the full list):

- [three.js](https://threejs.org/) (WebGPU renderer and compute) - MIT License
- [cosmos.gl](https://github.com/cosmosgl/graph) (2D view) - MIT License
- [graphology](https://graphology.github.io/) with Louvain community detection - MIT License
- [React](https://react.dev/), [Tailwind CSS](https://tailwindcss.com/), [shadcn/ui](https://ui.shadcn.com/) - MIT License
- [FastAPI](https://fastapi.tiangolo.com/) and [hkg-data-model](https://codebase.helmholtz.cloud/hmc/helmholtz-kg/) (backend)

### Funding

This project was developed at the Institute for Materials Data Science and Informatics
(IAS-9) of the Jülich Research Center and funded by the Helmholtz Metadata Collaboration
(HMC), an incubator-platform of the Helmholtz Association within the framework of the
Information and Data Science strategic initiative.

<div>
<img style="vertical-align: middle;" alt="HMC Logo" src="https://github.com/Materials-Data-Science-and-Informatics/Logos/raw/main/HMC/HMC_Logo_M.png" width=50% height=50% />
&nbsp;&nbsp;
<img style="vertical-align: middle;" alt="FZJ Logo" src="https://github.com/Materials-Data-Science-and-Informatics/Logos/raw/main/FZJ/FZJ.png" width=30% height=30% />
</div>
<br />
