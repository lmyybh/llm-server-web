#!/usr/bin/env bash
set -euo pipefail

# Importing server.app constructs the default app. Keep that import away from
# the database used by a running benchmark, including during test collection.
test_db_dir="$(mktemp -d)"
trap 'rm -rf "$test_db_dir"' EXIT
export LLMBENCH_DB="$test_db_dir/llmbench.db"

"${LLMBENCH_TEST_PYTHON:-python3}" -m pytest "$@"
