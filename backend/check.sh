# SPDX-License-Identifier: MIT
# Backend check script (ruff check/format @88, mypy, pylint, pytest).
#
# pytest runs under coverage: [tool.coverage.report] fail_under in
# pyproject.toml is the backend coverage gate (card B8) — CI fails if
# backend/app/ drops below it.
set -euo pipefail
cd "$(dirname "$0")"

PY=.venv/bin

"$PY/python" -m pip --version >/dev/null 2>&1 || true
"$PY/ruff" format --check .
"$PY/ruff" check .
"$PY/mypy" .
"$PY/pylint" app
"$PY/python" -m pytest -q --cov --cov-report=term-missing

echo "Backend check green."
