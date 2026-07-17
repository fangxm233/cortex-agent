#!/usr/bin/env bash
# Run Cortex test suite against an isolated, seeded CORTEX_HOME.
#
# Creates a temp directory, runs `cortex init` non-interactively, seeds
# test-compatible configs, then runs the full test suite. Cleans up on exit.
#
# Usage:
#   bash scripts/run-tests.sh              # full suite
#   bash scripts/run-tests.sh --quick      # skip depcruise (faster iteration)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$AGENT_DIR"

QUICK=false
if [[ "${1:-}" == "--quick" ]]; then
  QUICK=true
fi

# ── Create isolated CORTEX_HOME ──────────────────────────────────

CORTEX_HOME=$(mktemp -d)
cleanup() { rm -rf "$CORTEX_HOME"; }
trap cleanup EXIT

export CORTEX_HOME

# ── Init ─────────────────────────────────────────────────────────

echo "[run-tests] cortex init → $CORTEX_HOME"

printf 'claude\nnone\nn\n\n\n\nn\n\n\n' | node --import tsx src/entry/cli.ts init \
  --home "$CORTEX_HOME" \
  --gateway-config-dir "$CORTEX_HOME/gateway" \
  2>/dev/null

# ── Seed test configs ────────────────────────────────────────────

bash "$SCRIPT_DIR/seed-test-config.sh" "$CORTEX_HOME"

# ── Dependency check (skip in --quick mode) ─────────────────────

if ! $QUICK; then
  echo "[run-tests] dependency-cruise"
  npx depcruise src --validate
fi

# ── Slack emoji shortcode lint ──────────────────────────────────

echo "[run-tests] lint: no Slack emoji shortcodes"
node --import tsx scripts/lint-no-slack-shortcodes.ts

# ── Run tests (vitest) ───────────────────────────────────────────
#
# The suite runs under vitest: a single Vite server transpiles each module ONCE
# and caches it, versus node --test which spawned a fresh `node --import tsx`
# process per file (299×) and re-transpiled the whole import graph each time —
# the dominant cost that saturated the box and timed the suite out. vitest's
# fork pool executes test files in parallel workers without re-paying transpile;
# cap the worker count via CORTEX_TEST_CONCURRENCY (read by vitest.config.ts).
#
# Isolation, the `.js`→`.ts` resolver, per-file CORTEX_HOME setup, include/exclude
# globs (debug/shim + integration filtering) and timeouts all live in the config
# files, so this wrapper only handles env seeding + the two passes.

echo "[run-tests] running unit suite (vitest, concurrency=${CORTEX_TEST_CONCURRENCY:-16})"
pnpm exec vitest run

# ── Integration tests (forked servers; longer timeout, run last) ─────
echo "[run-tests] running integration tests (vitest, serial)"
pnpm exec vitest run --config vitest.integration.config.ts
