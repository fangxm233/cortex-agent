#!/usr/bin/env bash
# input:  locked harness source and uv executable
# output: byte-reproducible cortex-bench-harness wheel
# pos:    Deterministic wheel build entry point
# >>> If I am updated, update my header and folder CORTEX.md <<<

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="$(dirname "$SCRIPT_DIR")"
UV_BIN="${UV_BIN:-uv}"
WHEEL_NAME="cortex_bench_harness-0.1.0-py3-none-any.whl"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-315532800}"
BUILD_ROOT="$(mktemp -d)"

cleanup() {
  rm -r "$BUILD_ROOT"
}
trap cleanup EXIT

cd "$HARNESS_DIR"
"$UV_BIN" sync --frozen --group dev

build_once() {
  local output_dir="$1"
  mkdir -p "$output_dir"
  SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
    "$UV_BIN" build --wheel --out-dir "$output_dir"
  test -f "$output_dir/$WHEEL_NAME"
}

build_once "$BUILD_ROOT/first"
build_once "$BUILD_ROOT/second"
cmp "$BUILD_ROOT/first/$WHEEL_NAME" "$BUILD_ROOT/second/$WHEEL_NAME"
mkdir -p dist
install -m 0644 "$BUILD_ROOT/first/$WHEEL_NAME" "dist/$WHEEL_NAME"
printf 'wheel=%s\n' "$WHEEL_NAME"
printf 'sha256=%s\n' "$(sha256sum "dist/$WHEEL_NAME" | cut -d' ' -f1)"
