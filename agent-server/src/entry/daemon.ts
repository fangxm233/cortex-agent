// input:  ${CORTEX_REPO}/src/**/*.ts changes (auto rebuild + install + app.js restart),
//         .restart trigger file (manual restart; in dev mode: rebuild pipeline; in prod: hot-reload app.js),
//         CONFIG_DIR/.env changes
// output: process supervisor — fork(app.js) with hot-restart, crash recovery, graceful shutdown;
//         on src change: spawn npm run build (server+web) → npm pack → npm install -g <tgz> → restart() app.js;
//         on .restart in dev mode (CORTEX_REPO set): same rebuild pipeline
// pos:    system entry point, top-level process in daemon mode (node dist/entry/daemon.js);
//         logs/PID persisted to DATA_DIR
// >>> If I am updated, update my header comment and CORTEX.md <<<

/**
 * Cortex Daemon — Supervisor for app.ts
 *
 * IPC protocol (app.ts → daemon):
 *   { type: 'busy' }  — a request is being processed, defer restart
 *   { type: 'idle' }  — done processing, safe to restart
 *
 * Restart serialization:
 *   Only ONE restart cycle (stop → start) runs at a time. Concurrent requests
 *   are absorbed into `pendingRestart` and consumed after the cycle completes.
 *   The crash-recovery timer is tracked and cancelled on intentional restarts.
 *
 * Source-watch rebuild loop:
 *   When CORTEX_REPO is set and ${CORTEX_REPO}/src exists, daemon watches
 *   src/**\/*.ts and on change runs: npm run build (server+web) → npm pack → npm install -g
 *   → restart() the app.js child from the freshly installed dist. The daemon
 *   process itself does NOT reload — if you edit daemon.ts you must manually
 *   `cortex daemon` restart to pick up the new daemon code.
 *
 *   Build failure → log + skip (no restart). Install failure → same. busy/idle
 *   gating is reused: a rebuild during an in-flight Slack request defers the
 *   final restart() step until the child reports idle.
 *
 * Manual upgrade workflow (still supported):
 *   npm run build && npm pack && npm install -g ./cortex-agent-server-X.Y.Z.tgz   (package: @cortex-agent/server)
 *   The postinstall-restart-trigger.mjs touches .restart, which the .restart
 *   watcher below picks up. In dev mode (CORTEX_REPO set) this triggers the full
 *   rebuild pipeline; in production mode it just respawns app.js.
 */

import * as dotenv from 'dotenv';
import { fork, spawn } from 'child_process';
import { watch, existsSync, unlinkSync, statSync, writeFileSync, readdirSync } from 'fs';
import * as path from 'path';
import { createLogger } from '@core/log.js';
import { isMainModule, moduleDir, DATA_DIR, CONFIG_DIR, STORE_DIR } from '@core/utils.js';
import { tryAcquireSingletonLock, releaseSingletonLock as releaseLock } from '@core/singleton-lock.js';

// Load .env BEFORE reading any CORTEX_* env vars below. Mirrors app.ts §61 — the
// daemon needs CORTEX_REPO (and potentially other vars) from .env, not just from
// the OS shell env. Must be sync and before the `CORTEX_REPO` constant below.
dotenv.config({ path: path.join(CONFIG_DIR, '.env') });

// --- Logger ---
const log = createLogger('daemon');

// --- Paths ---
const MODULE_DIR = moduleDir(import.meta.url);
const PID_FILE = path.join(STORE_DIR, 'daemon.pid');
const CHILD_PID_FILE = path.join(STORE_DIR, 'daemon-child.pid');

// --- Config ---
const APP_ENTRY = path.join(MODULE_DIR, 'app.js');
const RESTART_TRIGGER = path.join(STORE_DIR, '.restart');
const ENV_FILE = path.join(CONFIG_DIR, '.env');
const CORTEX_REPO = process.env.CORTEX_REPO ?? '';
const SRC_WATCH_PATH = CORTEX_REPO ? path.join(CORTEX_REPO, 'src') : '';
// Monorepo root is the parent of the agent-server repo (e.g. /home/fangxin/Cortex).
// Web SPA lives under MONOREPO_ROOT/web/ and must be built before packing.
const MONOREPO_ROOT = CORTEX_REPO ? path.dirname(CORTEX_REPO) : '';
const WEB_DIR = MONOREPO_ROOT ? path.join(MONOREPO_ROOT, 'web') : '';
const DEBOUNCE_MS = 800;          // .restart / .env — fast
const BUILD_DEBOUNCE_MS = 2500;   // src/*.ts — slower, build takes seconds anyway
const BACKOFF_INITIAL = 1000;
const BACKOFF_MAX = 30_000;
const HEALTHY_THRESHOLD = 10_000; // if alive > 10s, reset backoff

// Src-watch filter: paths under SRC_WATCH_PATH that should NOT trigger a rebuild.
const SRC_IGNORE_PREFIXES = ['tests/', 'tmp/', 'node_modules/', 'dist/', 'vendor/'];
const SRC_IGNORE_SUFFIXES = ['.d.ts', '.test.ts', '.spec.ts'];

// --- State ---
let child = null;
let childStartedAt = 0;
let backoff = BACKOFF_INITIAL;
let restartTimer = null;        // debounce timer for .restart / .env
let rebuildTimer = null;        // debounce timer for src/*.ts
let crashRecoveryTimer = null;  // timer from crash handler's auto-restart
let shuttingDown = false;
let childBusy = false;          // true when app.ts is processing a request
let pendingRestart = null;      // reason string if restart is deferred
let pendingRebuild: string | null = null; // reason string if rebuild is deferred (busy or in-flight)
let restarting = false;         // true while restart() stop→start cycle is in progress
let rebuilding = false;         // true while runRebuildPipeline() is running
let nextRestartReason: string | null = null; // forwarded to next child via CORTEX_RESTART_REASON

// Daemon logs are written by the centralized logger (src/core/log.ts)
// — console + daily-rotating file output in DATA_DIR/logs/.

// --- Cancel all pending restart timers ---
function cancelPendingTimers() {
  if (crashRecoveryTimer) { clearTimeout(crashRecoveryTimer); crashRecoveryTimer = null; }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
}

function buildChildProcessConfig(restartReason: string | null = null) {
  const stdio: ('pipe' | 'ignore' | 'ipc')[] = ['pipe', 'ignore', 'ignore', 'ipc'];
  const env = { ...process.env };
  if (restartReason) {
    env.CORTEX_RESTART_REASON = restartReason;
  } else {
    delete env.CORTEX_RESTART_REASON;
  }
  return {
    cwd: DATA_DIR,
    stdio,
    execArgv: [],
    env,
  };
}

// --- Child Process Management ---
function startChild() {
  if (shuttingDown) return;
  if (child) {
    log.info('startChild called but child already running — skipping.');
    return;
  }

  const reasonForChild = nextRestartReason;
  nextRestartReason = null;
  log.info(reasonForChild ? `Starting app.ts (reason: ${reasonForChild})...` : 'Starting app.ts...');
  childStartedAt = Date.now();
  childBusy = false;
  pendingRestart = null;

  child = fork(APP_ENTRY, [], buildChildProcessConfig(reasonForChild));

  // Daemon only logs its own messages; app.ts handles its own output independently.

  log.info(`app.ts started — PID ${child.pid}`);

  // Persist child PID so CLI (daemon status / daemon restart --hard) can find it
  try { writeFileSync(CHILD_PID_FILE, String(child.pid), 'utf8'); } catch {}

  // IPC: app.ts tells us when it's busy/idle
  child.on('message', (msg) => {
    if (msg?.type === 'busy') {
      log.info(`IPC ← app.ts: busy`);
      childBusy = true;
    } else if (msg?.type === 'idle') {
      childBusy = false;
      const note = pendingRestart
        ? ` (pending restart: ${pendingRestart})`
        : pendingRebuild
          ? ` (pending rebuild: ${pendingRebuild})`
          : '';
      log.info(`IPC ← app.ts: idle${note}`);
      if (pendingRestart) {
        const reason = pendingRestart;
        pendingRestart = null;
        restart(reason);
      } else if (pendingRebuild) {
        const reason = pendingRebuild;
        pendingRebuild = null;
        runRebuildPipeline(reason);
      }
    }
  });

  child.on('exit', (code, signal) => {
    child = null;
    childBusy = false;

    // Clean up child PID file
    try { if (existsSync(CHILD_PID_FILE)) unlinkSync(CHILD_PID_FILE); } catch {}

    if (shuttingDown) {
      log.info('app.ts exited (shutdown).');
      return;
    }

    // If restart() is driving the stop→start cycle, let it handle startChild()
    if (restarting) {
      if (signal) log.info(`app.ts stopped (signal ${signal}).`);
      return;
    }

    // Unexpected crash — schedule recovery with backoff
    const alive = Date.now() - childStartedAt;
    if (alive > HEALTHY_THRESHOLD) backoff = BACKOFF_INITIAL;

    const crashReason = signal ? `crash (signal ${signal})` : `crash (exit code ${code})`;
    if (signal) {
      log.info(`app.ts killed by signal ${signal}.`);
    } else {
      log.info(`app.ts exited with code ${code}.`);
    }

    log.info(`Restarting in ${backoff}ms...`);
    cancelPendingTimers();
    crashRecoveryTimer = setTimeout(() => {
      crashRecoveryTimer = null;
      nextRestartReason = crashReason;
      startChild();
    }, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  });
}

function stopChild() {
  return new Promise<void>((resolve) => {
    if (!child) return resolve();

    const c = child; // capture local ref — exit handler sets global child=null
    log.info(`Stopping app.ts (PID ${c.pid})...`);

    const forceKillTimer = setTimeout(() => {
      log.info('Force killing app.ts...');
      try { c.kill('SIGKILL'); } catch {}
    }, 5000);

    c.once('exit', () => {
      clearTimeout(forceKillTimer);
      resolve();
    });

    c.kill('SIGTERM');
  });
}

async function restart(reason) {
  // Defer if child is busy processing a request
  if (childBusy) {
    log.info(`Restart deferred (app.ts is busy): ${reason}`);
    pendingRestart = reason;
    return;
  }

  // Serialize: only one stop→start cycle at a time
  if (restarting) {
    log.info(`Restart deferred (already restarting): ${reason}`);
    pendingRestart = reason;
    return;
  }

  cancelPendingTimers();

  log.info(`Restarting: ${reason}`);
  backoff = BACKOFF_INITIAL;
  restarting = true;

  await stopChild();
  restarting = false;

  // Absorb any restarts requested during the stop phase —
  // the new child loads the latest code from disk regardless
  if (pendingRestart) {
    log.info(`Absorbed deferred restart: ${pendingRestart}`);
    pendingRestart = null;
  }

  nextRestartReason = reason;
  startChild();
}

// --- File Watching ---

/** Recursively walk a directory tree and return an fs.FSWatcher for each subdirectory.
 *  Used on Windows where fs.watch({recursive:true}) throws EPERM. */
function watchTree(root: string, callback: (eventType: string, filename: string | null) => void): ReturnType<typeof watch>[] {
  const watchers: ReturnType<typeof watch>[] = [];
  const walk = (dir: string) => {
    watchers.push(watch(dir, (et, fn) => callback(et, fn)));
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      walk(path.join(dir, entry.name));
    }
  };
  walk(root);
  return watchers;
}

function setupWatchers() {
  const watchers = [];

  // Watch ${CORTEX_REPO}/src/**/*.ts — when source files change, rebuild the package,
  // npm install -g the fresh tgz, then restart() the app.js child from the new dist.
  // The daemon process itself does NOT reload; edits to daemon.ts require manual restart.
  // If CORTEX_REPO is unset or src/ is missing, this watcher is skipped — the daemon then
  // relies purely on the .restart trigger below (manual upgrade flow).
  if (SRC_WATCH_PATH && existsSync(SRC_WATCH_PATH) && statSync(SRC_WATCH_PATH).isDirectory()) {
    const onChange = (_eventType: string, filename: string | null) => {
      if (!filename) return;
      const changedName = String(filename).replace(/\\/g, '/');
      if (!changedName.endsWith('.ts')) return;
      if (SRC_IGNORE_SUFFIXES.some(s => changedName.endsWith(s))) return;
      if (SRC_IGNORE_PREFIXES.some(p => changedName.startsWith(p) || changedName.includes(`/${p}`))) return;
      debouncedRebuild(`src change: ${changedName}`);
    };
    // Windows: recursive watch throws EPERM — watch each directory individually
    if (process.platform === 'win32') {
      const srcWatchers = watchTree(SRC_WATCH_PATH, onChange);
      watchers.push(...srcWatchers);
      log.info(`Watching src: ${SRC_WATCH_PATH} (per-directory, *.ts, ${srcWatchers.length} dirs)`);
    } else {
      const watcher = watch(SRC_WATCH_PATH, { recursive: true }, onChange);
      watchers.push(watcher);
      log.info(`Watching src: ${SRC_WATCH_PATH} (recursive, *.ts)`);
    }
  } else if (CORTEX_REPO) {
    log.warn(`CORTEX_REPO=${CORTEX_REPO} set but ${SRC_WATCH_PATH} not a directory — src watcher disabled`);
  } else {
    log.warn('CORTEX_REPO unset — src watcher disabled, only .restart trigger available');
  }

  // Watch for .restart trigger file
  const triggerDir = path.dirname(RESTART_TRIGGER);
  const triggerName = path.basename(RESTART_TRIGGER);
  const triggerWatcher = watch(triggerDir, (eventType, filename) => {
    if (filename === triggerName && existsSync(RESTART_TRIGGER)) {
      try { unlinkSync(RESTART_TRIGGER); } catch {}
      if (CORTEX_REPO) {
        debouncedRebuild('manual trigger (.restart file)');
      } else {
        debouncedRestart('manual trigger (.restart file)');
      }
    }
  });
  watchers.push(triggerWatcher);
  log.info(`Watching for restart trigger: ${RESTART_TRIGGER}`);

  // Watch .env (parent dir, since editors often replace the file atomically)
  const envDir = path.dirname(ENV_FILE);
  const envName = path.basename(ENV_FILE);
  if (existsSync(envDir)) {
    const envWatcher = watch(envDir, (eventType, filename) => {
      if (filename && String(filename) === envName) {
        debouncedRestart('env change (.env)');
      }
    });
    watchers.push(envWatcher);
    log.info(`Watching env file: ${ENV_FILE}`);
  }

  return watchers;
}

function debouncedRestart(reason) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    restart(reason);
  }, DEBOUNCE_MS);
}

function debouncedRebuild(reason: string) {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    runRebuildPipeline(reason);
  }, BUILD_DEBOUNCE_MS);
}

// --- Rebuild Pipeline ---
// spawn helper: stream stdout/stderr through daemon logger, resolve with exit code
function spawnAsync(cmd: string, args: string[], opts: { cwd: string }): Promise<number> {
  return new Promise((resolve) => {
    const tag = `[${cmd} ${args.join(' ')}]`;
    log.info(`${tag} cwd=${opts.cwd}`);
    const proc = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const onLine = (label: string) => (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) log.info(`${tag} ${label}: ${line}`);
      }
    };
    proc.stdout?.on('data', onLine('out'));
    proc.stderr?.on('data', onLine('err'));
    proc.on('exit', (code) => {
      log.info(`${tag} exit=${code}`);
      resolve(code ?? 1);
    });
    proc.on('error', (err) => {
      log.error(`${tag} spawn error: ${err.message}`);
      resolve(1);
    });
  });
}

async function runRebuildPipeline(reason: string) {
  // Defer if app.ts is mid-request: install -g + restart() would interrupt it.
  // The build/pack/install commands themselves don't touch the running child, but the
  // final restart() does — to keep the gate simple we defer the whole pipeline.
  if (childBusy) {
    log.info(`Rebuild deferred (app.ts busy): ${reason}`);
    pendingRebuild = reason;
    return;
  }

  // Serialize: only one rebuild pipeline at a time. Overlapping triggers collapse into pendingRebuild.
  if (rebuilding) {
    log.info(`Rebuild deferred (already rebuilding): ${reason}`);
    pendingRebuild = reason;
    return;
  }

  if (!CORTEX_REPO) {
    log.error(`Rebuild requested but CORTEX_REPO unset — ignoring: ${reason}`);
    return;
  }

  rebuilding = true;
  try {
    log.info(`Rebuild pipeline starting: ${reason}`);

    // Step 1: build agent-server (tsc)
    const buildCode = await spawnAsync('npm', ['run', 'build'], { cwd: CORTEX_REPO });
    if (buildCode !== 0) {
      log.error(`Rebuild aborted: npm run build (server) exited ${buildCode}`);
      return;
    }

    // Step 2: build web SPA (vite) — needed by npm pack's prepack copy-web-dist step
    if (WEB_DIR && existsSync(WEB_DIR)) {
      const webBuildCode = await spawnAsync('npm', ['run', 'build'], { cwd: WEB_DIR });
      if (webBuildCode !== 0) {
        log.error(`Rebuild aborted: npm run build (web) exited ${webBuildCode}`);
        return;
      }
    } else {
      log.warn('WEB_DIR not found — skipping web build, pack will use stale web/dist if present');
    }

    // Step 3: pack (clean old tgz first, otherwise readdir picks up a stale one)
    const cleanCode = await spawnAsync('bash', ['-c', 'rm -f cortex-agent-server-*.tgz'], { cwd: CORTEX_REPO });
    if (cleanCode !== 0) {
      log.error(`Rebuild aborted: tgz cleanup exited ${cleanCode}`);
      return;
    }
    const packCode = await spawnAsync('npm', ['pack'], { cwd: CORTEX_REPO });
    if (packCode !== 0) {
      log.error(`Rebuild aborted: npm pack exited ${packCode}`);
      return;
    }

    // Find the newest tgz produced
    let tgzPath = '';
    try {
      const candidates = readdirSync(CORTEX_REPO)
        .filter(f => f.startsWith('cortex-agent-server-') && f.endsWith('.tgz'))
        .map(f => ({ f, mtime: statSync(path.join(CORTEX_REPO, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (candidates.length > 0) tgzPath = path.join(CORTEX_REPO, candidates[0].f);
    } catch (err: any) {
      log.error(`Rebuild aborted: failed to enumerate tgz in ${CORTEX_REPO}: ${err?.message ?? err}`);
      return;
    }
    if (!tgzPath) {
      log.error(`Rebuild aborted: npm pack succeeded but no cortex-agent-server-*.tgz found`);
      return;
    }
    log.info(`Packed tarball: ${tgzPath}`);

    // Step 4: install -g. Run from /tmp so npm doesn't choke if its CWD lives inside the package
    // currently being unlinked.
    const installCode = await spawnAsync('npm', ['install', '-g', tgzPath], { cwd: '/tmp' });
    if (installCode !== 0) {
      log.error(`Rebuild aborted: npm install -g exited ${installCode}`);
      return;
    }

    // Step 5: restart app.ts. This reuses the busy/idle gate inside restart() —
    // if a request snuck in between the busy-check above and now, restart() will
    // re-defer to pendingRestart. Either way, the new app.js boots from the freshly
    // installed dist/.
    log.info(`Rebuild succeeded — restarting app.ts`);
    restart(`src rebuild: ${reason}`);
  } finally {
    rebuilding = false;
    // If src changed again while we were rebuilding, pick that up now.
    if (pendingRebuild) {
      const next = pendingRebuild;
      pendingRebuild = null;
      log.info(`Consuming queued rebuild: ${next}`);
      // Schedule via debounce so further rapid edits still coalesce.
      debouncedRebuild(next);
    }
  }
}

// --- Graceful Shutdown ---
function setupShutdown() {
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);
    cancelPendingTimers();
    await stopChild();
    log.info('Daemon stopped.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function acquireSingletonLock() {
  const result = tryAcquireSingletonLock(PID_FILE);
  if (result.acquired) {
    // Stale lock — previous daemon died without cleanup
    if (result.stale) log.info(`Removed stale PID file and reclaimed lock for PID ${process.pid}`);
    return;
  }
  log.error(
    `Another Cortex daemon is already running (PID ${result.holderPid}, lockfile ${PID_FILE}).\n` +
    `         Refusing to start a second instance — its app.ts already holds ports 3001/3002 and your child would crash-loop on EADDRINUSE.\n` +
    `         To restart the running daemon: \`touch agent-server/.restart\` (hot reload), or send SIGTERM to PID ${result.holderPid} and rerun.`
  );
  process.exit(1);
}

function releaseSingletonLock() {
  releaseLock(PID_FILE);
  try {
    if (existsSync(CHILD_PID_FILE)) unlinkSync(CHILD_PID_FILE);
  } catch {}
}

function main() {
  // Recursion guard: if log.error() itself throws (e.g. EPIPE on a broken stderr),
  // the uncaughtException handler would be re-entered, causing an infinite loop that
  // fills the log file and the disk. This flag breaks that cycle.
  let inExceptionHandler = false;

  process.on('uncaughtException', (err) => {
    if (inExceptionHandler) return; // already handling an exception — avoid re-entrant loop
    inExceptionHandler = true;
    try {
      log.error(`uncaughtException: ${err?.stack ?? err}`);
    } catch {
      // log.error() itself threw (shouldn't happen after log.ts EPIPE fix, but guard anyway)
    } finally {
      inExceptionHandler = false;
    }
  });
  process.on('unhandledRejection', (reason) => {
    if (inExceptionHandler) return;
    inExceptionHandler = true;
    try {
      log.error(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
    } catch {
      // log.error() itself threw
    } finally {
      inExceptionHandler = false;
    }
  });
  acquireSingletonLock();
  process.on('exit', releaseSingletonLock);
  log.info('Cortex Daemon starting...');
  setupShutdown();
  setupWatchers();
  startChild();
}

if (isMainModule(import.meta.url)) {
  main();
}

export { main, buildChildProcessConfig };
