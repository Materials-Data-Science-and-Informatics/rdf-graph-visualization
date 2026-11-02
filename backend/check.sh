# SPDX-License-Identifier: MIT
# Backend check script (ruff check/format @88, mypy, pylint, pytest).
set -euo pipefail
cd "$(dirname "$0")"

PY=.venv/bin

"$PY/python" -m pip --version >/dev/null 2>&1 || true
"$PY/ruff" format --check .
"$PY/ruff" check .
"$PY/mypy" .
"$PY/pylint" app
"$PY/python" -m pytest -q

echo "Backend check green."
