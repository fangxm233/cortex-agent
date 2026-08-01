// input:  process env (CORTEX_HOME)
// output: side effect — guarantees CORTEX_HOME points at a per-process isolated temp dir
// pos:    test isolation guard — globally --import'd by run-tests.sh (and importable directly),
//         MUST run before paths.ts binds DATA_DIR.
// >>> If I am updated, update my header comment <<<
//
// Why this exists: paths.ts resolves DATA_DIR = $CORTEX_HOME ?? ~/.cortex at IMPORT TIME, and
// node's test runner executes test FILES in parallel processes. Two failure modes:
//
//   1. Run directly (e.g. `npx tsx --test tests/session.test.ts`) with CORTEX_HOME unset →
//      tests would read/write the operator's live ~/.cortex/data, racing the running daemon
//      and leaking fixtures (C-concurrent-*, sid-*, …) into the real sessions.json.
//   2. Run via run-tests.sh, which exports ONE seeded CORTEX_HOME shared by every test-file
//      process → parallel files race on shared on-disk state (TASKS.yaml, thread-templates.json,
//      sessions.json, PROJECTS_DIR scans), causing intermittent, file-order-dependent failures.
//
// Both are fixed the same way: give each test-file process its OWN CORTEX_HOME before paths.ts
// binds. When CORTEX_HOME is already set (case 2) we CLONE it so the per-process home keeps the
// seeded config (profiles.json, machines.json, thread-templates.json, gateway, …); when unset
// (case 1) we create a minimal empty skeleton. ESM evaluates imports in source order, so as long
// as this is the first import (or the first --import) the guarantee holds.
//
// Allocation and cleanup of the temp home live in _test-home-root.ts: homes are parked under a
// single parent so they can be swept as a unit, and cleanup is layered (exit + signal handlers
// here, authoritative removal from vitest's main process, stale sweep on the next run).

import { mkdirSync, cpSync } from 'node:fs';
import * as path from 'node:path';
import { allocateTestHome, redirectTmpdir } from './_test-home-root.js';

const _shared = process.env.CORTEX_HOME;
const _home = allocateTestHome();

if (_shared) {
  // Clone the shared seeded home so this process gets a private, fully-seeded copy.
  // Best-effort: fall back to the empty skeleton below if the clone fails.
  try { cpSync(_shared, _home, { recursive: true }); } catch { /* best-effort */ }
}

// Ensure the standard dir structure exists (covers the unset case and any seeded home missing a
// dir — store/task tests that write via a raw fs.writeFile, no mkdir, rely on these existing).
for (const d of ['data', 'config', 'context', path.join('context', 'projects'), 'tmp', path.join('tmp', 'threads')]) {
  try { mkdirSync(path.join(_home, d), { recursive: true }); } catch { /* best-effort */ }
}

process.env.CORTEX_HOME = _home;
// Keep the temp dirs the test files allocate themselves inside the run-scoped root too.
redirectTmpdir();

// Cleanup (exit + signal handlers, and the stale sweep on the next run) is owned by
// _test-home-root.ts — allocateTestHome() already registered this home.

export {};
