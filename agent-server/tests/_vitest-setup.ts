// vitest per-test-file isolation guard — the vitest analogue of _test-home.ts.
//
// Runs as a vitest `setupFile`, i.e. before the test file's own imports, so it
// rebinds CORTEX_HOME to a per-file temp dir BEFORE paths.ts resolves DATA_DIR
// at import time. With `pool: 'forks'` + `isolate: true`, each test file gets a
// fresh module registry and its own process, so each file lands on its own home.
//
// When CORTEX_HOME is already set (run-tests seeds one shared home), we CLONE it
// so this file keeps the seeded config; otherwise we build a minimal skeleton.

import { mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const shared = process.env.CORTEX_HOME;
const home = mkdtempSync(path.join(os.tmpdir(), 'cortex-test-home-'));

if (shared) {
  try { cpSync(shared, home, { recursive: true }); } catch { /* best-effort */ }
}

for (const d of ['data', 'config', 'context', path.join('context', 'projects'), 'tmp', path.join('tmp', 'threads')]) {
  try { mkdirSync(path.join(home, d), { recursive: true }); } catch { /* best-effort */ }
}

process.env.CORTEX_HOME = home;
// atomicWrite tripwire keys off NODE_TEST_CONTEXT; node:test set it implicitly,
// vitest does not — set it so the production-write guard stays armed.
process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT ?? '1';

process.on('exit', () => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});
