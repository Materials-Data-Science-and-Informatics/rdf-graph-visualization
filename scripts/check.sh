# SPDX-License-Identifier: MIT
# Aggregate check for both trees (DoD for F7 / HKG convention).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== backend check (ruff/mypy/pylint/pytest) =="
bash backend/check.sh

echo "== frontend check (tsc/eslint/prettier) =="
(cd frontend && pnpm run check)

echo "All checks green."
