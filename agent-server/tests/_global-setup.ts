// input:  none (runs before any worker fork is spawned)
// output: CORTEX_TEST_HOME_ROOT env var; sweeps stale homes; removes this run's homes on teardown
// pos:    vitest globalSetup — the only cleanup hook that is guaranteed to run
// >>> If I am updated, update my header comment <<<
//
// globalSetup executes in vitest's MAIN process, and the teardown it returns runs after every
// worker has finished. That main process exits normally, so unlike the workers (killed with
// SIGTERM/SIGKILL by tinypool) its cleanup is reliable. Each run gets its own subdir so that
// concurrent scoped runs (`npm run test:file …`) never delete each other's homes.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { TEST_HOMES_ROOT, sweepStale } from './_test-home-root.js';

export async function setup(): Promise<() => void> {
  mkdirSync(TEST_HOMES_ROOT, { recursive: true });

  // Collect anything an earlier killed run (Ctrl-C, SIGKILL, reboot) left behind.
  const swept = sweepStale();
  if (swept > 0) console.log(`[test-home] swept ${swept} stale test home(s)`);

  const runRoot = mkdtempSync(path.join(TEST_HOMES_ROOT, 'run-'));
  process.env.CORTEX_TEST_HOME_ROOT = runRoot;

  return () => {
    try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  };
}
