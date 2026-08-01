// vitest per-test-file isolation guard — the vitest analogue of _test-home.ts.
//
// Runs as a vitest `setupFile`, i.e. before the test file's own imports, so it
// rebinds CORTEX_HOME to a per-file temp dir BEFORE paths.ts resolves DATA_DIR
// at import time. With `pool: 'forks'` + `isolate: true`, each test file gets a
// fresh module registry and its own process, so each file lands on its own home.
//
// When CORTEX_HOME is already set (run-tests seeds one shared home), we CLONE it
// so this file keeps the seeded config; otherwise we build a minimal skeleton.
//
// The home itself is allocated by _test-home-root.ts, which parks it under a single
// run-scoped parent and owns the cleanup layers — a `process.on('exit')` handler here
// would never fire, because tinypool kills fork workers with SIGTERM/SIGKILL.

import { mkdirSync, cpSync } from 'node:fs';
import * as path from 'node:path';
import { allocateTestHome, redirectTmpdir } from './_test-home-root.js';

const shared = process.env.CORTEX_HOME;
// Allocated under the run-scoped root and registered for exit/signal cleanup; the authoritative
// removal is _global-setup.ts's teardown, which runs in the main process (see that file).
const home = allocateTestHome();

if (shared) {
  try { cpSync(shared, home, { recursive: true }); } catch { /* best-effort */ }
}

for (const d of ['data', 'config', 'context', path.join('context', 'projects'), 'tmp', path.join('tmp', 'threads')]) {
  try { mkdirSync(path.join(home, d), { recursive: true }); } catch { /* best-effort */ }
}

process.env.CORTEX_HOME = home;
// Keep the temp dirs the test files allocate themselves inside the run-scoped root too.
redirectTmpdir();
// atomicWrite tripwire keys off NODE_TEST_CONTEXT; node:test set it implicitly,
// vitest does not — set it so the production-write guard stays armed.
process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT ?? '1';

// Cleanup discipline for every test file loaded through this setup:
// when the module under test holds a long-lived resource (timer, interval, listener, child
// process — e.g. rate-limit-throttle._resumeTimer, disk-monitor._timer), REGISTER its reset
// (`t.onTestFinished(() => mod._testReset())`, an `afterEach`, or try/finally). Never write the
// reset as the last statement of the test body: a failing assertion skips it, the leaked handle
// keeps Node's event loop alive, and the run hangs after the last test.
// Reference helper: `freshModuleWithCleanup` in tests/rate-limit-throttle.test.ts.
