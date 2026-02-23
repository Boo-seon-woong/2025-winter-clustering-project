#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_BIN="$SCRIPT_DIR/bin/ldb"
mkdir -p "$SCRIPT_DIR/bin"

copy_from() {
  local src="$1"
  cp "$src" "$OUT_BIN"
  chmod +x "$OUT_BIN"
  echo "[build_ldb] installed: $OUT_BIN"
  "$OUT_BIN" --help >/dev/null 2>&1 || true
}

# 1) Explicit source tree (recommended)
if [[ -n "${ROCKSDB_SRC:-}" && -f "$ROCKSDB_SRC/Makefile" ]]; then
  echo "[build_ldb] building from ROCKSDB_SRC=$ROCKSDB_SRC"
  make -C "$ROCKSDB_SRC" ldb -j"$(nproc)"
  if [[ -x "$ROCKSDB_SRC/ldb" ]]; then
    copy_from "$ROCKSDB_SRC/ldb"
    exit 0
  fi
  if [[ -x "$ROCKSDB_SRC/tools/ldb" ]]; then
    copy_from "$ROCKSDB_SRC/tools/ldb"
    exit 0
  fi
fi

# 2) Existing tool in this workspace
if [[ -x "$ROOT_DIR/rocksdb/tools/ldb" ]]; then
  echo "[build_ldb] using workspace tool: $ROOT_DIR/rocksdb/tools/ldb"
  copy_from "$ROOT_DIR/rocksdb/tools/ldb"
  exit 0
fi

# 3) System ldb
if command -v ldb >/dev/null 2>&1; then
  echo "[build_ldb] using system ldb: $(command -v ldb)"
  copy_from "$(command -v ldb)"
  exit 0
fi

echo "[build_ldb] failed: no ldb found"
echo "- set ROCKSDB_SRC=<rocksdb-source-dir> and rerun"
echo "- or install system ldb"
exit 1
