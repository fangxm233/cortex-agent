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
# Pinned, and overriding whatever the ambient environment carries: this is what makes the wheel a
# function of the source alone. tests/package/test_build_wheel.py is what proves it, by building
# twice under conflicting ambient epochs and comparing the bytes -- so this script builds once.
SOURCE_DATE_EPOCH="315532800"
BUILD_ROOT="$(mktemp -d)"

cleanup() {
  rm -r "$BUILD_ROOT"
}
trap cleanup EXIT

cd "$HARNESS_DIR"
"$UV_BIN" sync --frozen --group dev

SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
  "$UV_BIN" build --wheel --out-dir "$BUILD_ROOT"
test -f "$BUILD_ROOT/$WHEEL_NAME"
mkdir -p dist
install -m 0644 "$BUILD_ROOT/$WHEEL_NAME" "dist/$WHEEL_NAME"
printf 'wheel=%s\n' "$WHEEL_NAME"
printf 'sha256=%s\n' "$(sha256sum "dist/$WHEEL_NAME" | cut -d' ' -f1)"
