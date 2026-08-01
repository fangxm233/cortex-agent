// input:  os.tmpdir(), CORTEX_TEST_HOME_ROOT
// output: per-process test-home directories, plus a sweeper for stale ones
// pos:    shared temp-home allocator for _test-home.ts (node:test) and _vitest-setup.ts (vitest)
// >>> If I am updated, update my header comment <<<
//
// Why this exists: both isolation guards used to call mkdtempSync(os.tmpdir(), 'cortex-test-home-')
// and free the directory from a `process.on('exit')` handler. That handler never runs under vitest:
// tinypool tears fork workers down with `this.process.kill()` (SIGTERM, escalating to SIGKILL after
// a timeout), and Node's default SIGTERM disposition terminates the process WITHOUT emitting 'exit'.
// Every test file therefore leaked a ~1.2 MB seeded home straight into the top level of /tmp.
//
// The fix has three layers, because no in-process handler can survive SIGKILL:
//   1. All homes live under ONE parent (TEST_HOMES_ROOT), so cleanup is a single rm -rf and /tmp's
//      top level stays small — 200k sibling entries are what made `du`/`ls` on /tmp crawl.
//   2. vitest's globalSetup (_global-setup.ts) allocates a per-run subdir, exports it here via
//      CORTEX_TEST_HOME_ROOT, and removes it from the MAIN process after all workers finish.
//   3. sweepStale() runs at the start of every run and collects whatever earlier crashes left.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// redirectTmpdir() rewrites TMPDIR, which is what os.tmpdir() reads on POSIX. Pin the real
// system temp dir the first time this module loads and pass it down via the environment: with
// isolate:true the module registry is rebuilt per test file, so a plain module-level capture
// would read the ALREADY-redirected value from the second file onwards.
const PRISTINE_TMPDIR = process.env.CORTEX_TEST_OS_TMPDIR ?? os.tmpdir();
process.env.CORTEX_TEST_OS_TMPDIR = PRISTINE_TMPDIR;

/** Single parent for every test home this repo creates. */
export const TEST_HOMES_ROOT = path.join(PRISTINE_TMPDIR, 'cortex-test-homes');

/** Homes older than this are assumed orphaned by a killed run and are swept. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Directory new homes are created in: the per-run subdir when globalSetup allocated one,
 * otherwise the shared root (direct `tsx --test` runs have no globalSetup).
 */
export function testHomeParent(): string {
  const perRun = process.env.CORTEX_TEST_HOME_ROOT;
  const dir = perRun && perRun.length > 0 ? perRun : TEST_HOMES_ROOT;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Allocate a fresh home and register process-wide cleanup for it (once per process). */
export function allocateTestHome(): string {
  const home = mkdtempSync(path.join(testHomeParent(), 'h-'));
  trackForCleanup(home);
  return home;
}

/**
 * Point TMPDIR at a scratch dir inside the run-scoped root, so the ~40 test files that call
 * `mkdtempSync(path.join(os.tmpdir(), '…'))` themselves (cortex-prefs-, cortex-pi-models-,
 * thr-wait-, feishu-*, …) land there too and are collected by the same teardown — instead of
 * each one leaking its own directory into the top level of /tmp.
 *
 * Kept as a sibling of the home rather than a child so the home stays a faithful CORTEX_HOME,
 * and deliberately short: unix socket paths are capped at ~108 bytes and some tests bind
 * sockets under os.tmpdir().
 */
export function redirectTmpdir(): string {
  const scratch = mkdtempSync(path.join(testHomeParent(), 't-'));
  trackForCleanup(scratch);
  process.env.TMPDIR = scratch;
  return scratch;
}

// With isolate:true each test file gets a fresh module registry inside a REUSED fork, so
// module-level state resets per file while the process persists. Park the registry and the
// signal handlers on globalThis so one process registers them once and tracks every home.
const REGISTRY_KEY = '__cortexTestHomeRegistry__';

function trackForCleanup(home: string): void {
  const g = globalThis as Record<string, unknown>;
  let reg = g[REGISTRY_KEY] as { homes: string[] } | undefined;

  if (!reg) {
    reg = { homes: [] };
    g[REGISTRY_KEY] = reg;
    const registry = reg;

    const cleanup = () => {
      for (const dir of registry.homes.splice(0)) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    };

    // Natural exit (direct `tsx --test` runs land here).
    process.on('exit', cleanup);

    // tinypool sends SIGTERM first and only escalates to SIGKILL after a timeout, so handling
    // the signal recovers the common vitest path. Re-exit with the conventional 128+signo status
    // to keep the worker's exit code meaningful to the pool.
    const signals: Array<[NodeJS.Signals, number]> = [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]];
    for (const [sig, code] of signals) {
      process.once(sig, () => { cleanup(); process.exit(code); });
    }
  }

  reg.homes.push(home);
}

/**
 * Remove test homes left behind by runs that died before cleaning up.
 * Covers the current layout (children of TEST_HOMES_ROOT) and the legacy one
 * (`cortex-test-home-*` directly in os.tmpdir()), so old leftovers drain on their own.
 * Returns the number of directories removed.
 */
export function sweepStale(maxAgeMs: number = STALE_AFTER_MS, now: number = Date.now()): number {
  let removed = 0;

  const olderThanCutoff = (target: string): boolean => {
    try { return now - statSync(target).mtimeMs > maxAgeMs; } catch { return false; }
  };

  const drop = (target: string): void => {
    try { rmSync(target, { recursive: true, force: true }); removed++; } catch { /* best-effort */ }
  };

  // Current layout: per-run subdirs and stray homes under the shared root.
  try {
    for (const entry of readdirSync(TEST_HOMES_ROOT)) {
      const target = path.join(TEST_HOMES_ROOT, entry);
      if (olderThanCutoff(target)) drop(target);
    }
  } catch { /* root not created yet */ }

  // Legacy layout: homes written straight into the system temp dir.
  try {
    for (const entry of readdirSync(PRISTINE_TMPDIR)) {
      if (!entry.startsWith('cortex-test-home-')) continue;
      const target = path.join(PRISTINE_TMPDIR, entry);
      if (olderThanCutoff(target)) drop(target);
    }
  } catch { /* best-effort */ }

  return removed;
}
