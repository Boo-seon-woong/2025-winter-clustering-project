#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Optional env loading
if [[ -n "${ENV_PATH:-}" && -f "$ENV_PATH" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_PATH"
  set +a
elif [[ -f "$ROOT_DIR/rdb/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/rdb/.env"
  set +a
elif [[ -f "$ROOT_DIR/rdb/kvs/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/rdb/kvs/.env"
  set +a
fi

LDB_BIN="$SCRIPT_DIR/bin/ldb"
if [[ ! -x "$LDB_BIN" ]]; then
  if command -v ldb >/dev/null 2>&1; then
    LDB_BIN="$(command -v ldb)"
  else
    echo "[ldb.sh] ldb not found. run: $SCRIPT_DIR/build_ldb.sh"
    exit 1
  fi
fi

DB_PATH="${DB_PATH:-$ROOT_DIR/rdb/kvs/db}"
exec "$LDB_BIN" --db="$DB_PATH" "$@"
