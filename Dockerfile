# syntax=docker/dockerfile:1
#
# Multi-stage build: Vite SPA (nginx) + FastAPI API (uvicorn), run together
# under supervisord. Port 80 serves the frontend; /api/* is proxied to the
# backend on 127.0.0.1:8000.
#
#   docker build -t hkg-graph-explorer .
#   docker run -p 80:80 hkg-graph-explorer

# ---- Stage 1: frontend (Vite SPA) -----------------------------------------
FROM node:20 AS frontend-build
WORKDIR /app
# .dockerignore excludes node_modules/ and dist/.
COPY frontend/ ./
# No .git in the image: HUSKY=0 must be set BEFORE install so husky's
# `prepare` script (present in frontend/package.json) exits 0 instead of
# failing on the missing .git dir.
ENV HUSKY=0
# Frontend package manager is pnpm (the HKG convention); the npm fallback
# covers a regression of the lockfile. If the package manager changes again,
# update this stage.
RUN npm install -g pnpm@12.16.1 --no-audit --no-fund && \
    if [ -f pnpm-lock.yaml ]; then \
        pnpm install --frozen-lockfile; \
    else \
        npm ci; \
    fi
# Renderer config (palette/properties) is fetched at RUNTIME from the API's
# /api/config (card C4) — nothing config-related is baked into the bundle.
RUN npm run build

# ---- Stage 2: backend dependencies (isolated venv) -------------------------
FROM python:3.12-slim AS backend-build
WORKDIR /build
# git is required by pip to fetch the `hkg-data-model` dependency, which is
# pinned to a GitLab TAG via git+https (see backend/pyproject.toml).
# python:3.12-slim ships without git.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
COPY backend/ ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir .

# ---- Stage 3: runtime ------------------------------------------------------
FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx supervisor \
    && rm -rf /var/lib/apt/lists/* \
    && rm /etc/nginx/sites-enabled/default
COPY --from=backend-build /opt/venv /opt/venv
COPY --from=frontend-build /app/dist /usr/share/nginx/html
# Run the checked-out app code (cwd wins over the copy baked into the venv).
COPY backend/app /srv/app/app
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/supervisord.conf /etc/supervisor/supervisord.conf
# /api/stream snapshot cache (mount a volume here to survive restarts).
ENV STREAM_CACHE_DIR=/var/cache/hkg-stream
RUN mkdir -p /var/cache/hkg-stream
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD /opt/venv/bin/python -c "import sys,urllib.request; r=urllib.request.urlopen('http://127.0.0.1/api/health', timeout=3); sys.exit(0 if r.status==200 else 1)"
CMD ["supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
