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

# ── Sweep temp homes orphaned by earlier runs ────────────────────
#
# vitest's globalSetup (tests/_global-setup.ts) owns cleanup for a normal run, but a run that
# dies before vitest starts — or a reboot — leaves homes nobody will collect. Age-gated at 2h so
# a suite running concurrently in another worktree is never touched. The second pattern drains
# leftovers from the pre-fix layout, which wrote homes to the top level of /tmp.

find "${TMPDIR:-/tmp}/cortex-test-homes" -mindepth 1 -maxdepth 1 -mmin +120 \
  -exec rm -rf {} + 2>/dev/null || true
find "${TMPDIR:-/tmp}" -mindepth 1 -maxdepth 1 -name 'cortex-test-home-*' -mmin +120 \
  -exec rm -rf {} + 2>/dev/null || true

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

# ── Machine-wide full-suite lock ─────────────────────────────────
#
# Concurrent full-suite runs (multiple worktree threads each spawning 16 forks)
# thrash the box and cause load-induced flake cascades. Serialize them: one
# full suite at a time, machine-wide. The wait happens BEFORE vitest starts,
# so per-test timeouts are unaffected; only the caller's wall clock grows.
# Bounded wait so a wedged holder cannot block forever.

LOCK_FILE="${CORTEX_TEST_LOCK:-/tmp/cortex-full-suite.lock}"
LOCK_WAIT_SECS=1200
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[run-tests] another full suite is running — waiting for lock (max ${LOCK_WAIT_SECS}s): $LOCK_FILE"
  if ! flock -w "$LOCK_WAIT_SECS" 9; then
    echo "[run-tests] ERROR: could not acquire test lock within ${LOCK_WAIT_SECS}s; retry later" >&2
    exit 1
  fi
fi

# ── Run tests (vitest) ───────────────────────────────────────────
#
# The suite runs under vitest: a single Vite server transpiles each module once
# and caches it; the fork pool executes test files in parallel workers. Cap the
# worker count via CORTEX_TEST_CONCURRENCY (read by vitest.config.ts). Isolation,
# the `.js`→`.ts` resolver, per-file CORTEX_HOME setup, include/exclude globs and
# timeouts all live in the config files.
#
# nice -n 10 keeps training jobs and interactive agents responsive while the
# fork pool is hot; niceness is inherited by the worker forks.

echo "[run-tests] running unit suite, isolated shard (vitest, concurrency=${CORTEX_TEST_CONCURRENCY:-16})"
CORTEX_TEST_SHARD=isolated nice -n 10 pnpm exec vitest run

# Vetted pure-logic files run with isolate:false so each worker fork executes
# the import graph once for many files (see tests/_shared-pool-manifest.ts).
echo "[run-tests] running unit suite, shared shard (vitest, isolate=false, concurrency=${CORTEX_TEST_SHARED_CONCURRENCY:-4})"
CORTEX_TEST_SHARD=shared nice -n 10 pnpm exec vitest run --passWithNoTests

# ── Integration tests (forked servers; longer timeout, run last) ─────
echo "[run-tests] running integration tests (vitest, serial)"
nice -n 10 pnpm exec vitest run --config vitest.integration.config.ts
