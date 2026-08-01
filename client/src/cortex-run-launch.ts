// input:  node fs/path/child_process, client paths and logger
// output: durable run launch, cancel, orphan, and callback handlers
// pos:    Supervises cortex-run metadata and callback delivery
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// DR-0011 §4.5 + §4.7: Provides:
//   (a) handleCortexRunLaunch — create ~/.cortex/tmp/cortex-run/<name>/, write meta.json,
//       spawn detached watcher, write pid, return {pid, callbackId, resultDir}
//   (b) flushPendingCallbacks — glob callback.pending, read meta+result+logTail, send WS task-callback
//   (c) orphan detection — state.json=running but pid dead -> synthesize result.json + touch callback.pending
//   (d) task-callback-ack — ok -> unlink callback.pending
//   (e) handleCortexRunCancel — send SIGTERM to watcher process group
//
// Zero agent-server imports — only node:* builtins + ./paths.js + ./log.js.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './paths.js';
import { createLogger } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger('cortex-run');

// --- Constants ---

/** Top-level directory for all cortex-run data (~/.cortex/tmp/cortex-run/). */
export const CORTEX_RUN_DIR = path.join(DATA_DIR, 'tmp', 'cortex-run');

// --- Types ---

export interface CortexRunLaunchParams {
  name: string;
  command: string[];
  stall?: string;
  gpu?: string;
  force?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  taskProject?: string | null;
  taskId?: string | null;
  dispatchGeneration?: string | null;
  logTailBytes?: number;
}

export interface CortexRunCancelParams {
  name: string;
  signal?: string;
}

export interface LaunchResult {
  pid: number;
  callbackId: string;
  resultDir: string;
}

export interface CancelResult {
  killed: boolean;
  pid: number | null;
}

// --- Utility: PID liveness ---

/** Returns true if the given PID is alive (exists as a process). */
export function isPidAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

// --- Utility: Safe JSON read ---

/** Reads and parses a JSON file. Returns null on any failure (missing, bad JSON, etc.). */
export function readJsonSafe(filePath: string): Record<string, any> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// --- Utility: Tail file (last N bytes) ---

/** Returns the last maxBytes bytes of a file. Returns '' on any failure. */
export function tailFile(filePath: string, maxBytes: number): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return '';
    const readSize = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

// --- Utility: Find run dir by callback ID ---

/** Scans CORTEX_RUN_DIR directories for a meta.json with matching callbackId. */
export function findRunDirByCallbackId(callbackId: string): string | null {
  try {
    if (!fs.existsSync(CORTEX_RUN_DIR)) return null;
    const entries = fs.readdirSync(CORTEX_RUN_DIR);
    for (const name of entries) {
      const dir = path.join(CORTEX_RUN_DIR, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const metaPath = path.join(dir, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.callbackId === callbackId) return dir;
      } catch { /* skip unreadable meta */ }
    }
  } catch { /* best-effort */ }
  return null;
}

// --- Utility: Safe unlink ---

/** Removes a file if it exists, silently ignoring errors. */
export function tryUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* best-effort */ }
}

// --- Orphan synthesis ---

/**
 * Synthesizes a result.json with termination=orphaned and touches callback.pending.
 *
 * Called when flushPendingCallbacks finds state.json status=running but the PID is dead
 * (watcher was killed without cleaning up).
 */
export function synthesizeOrphanResult(runDir: string, state: Record<string, any>): void {
  const resultPath = path.join(runDir, 'result.json');
  const logPath = path.join(runDir, 'output.log');
  const logTail = tailFile(logPath, 4096);
  const now = new Date().toISOString();

  const lastLine = logTail.split('\n').filter(Boolean).slice(-1)[0] || '';

  const result: Record<string, any> = {
    name: path.basename(runDir),
    termination: 'orphaned',
    exit_code: -1,
    started_at: state.started_at ?? null,
    ended_at: now,
    last_output_line: lastLine,
    gpu: state.gpu ?? null,
  };

  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));

  // Touch callback.pending so next flush cycle sends the callback
  fs.writeFileSync(path.join(runDir, 'callback.pending'), '');

  // Update state.json to reflect termination
  const updatedState: Record<string, any> = {
    ...state,
    status: 'failed',
    ended_at: now,
    exit_code: -1,
    termination: 'orphaned',
  };
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(updatedState, null, 2));
}

// --- Launch handler (DR-0011 §4.5) ---

/**
 * Creates the cortex-run directory, writes meta.json, spawns the watcher detached,
 * writes the PID file, and returns launch info.
 */
export async function handleCortexRunLaunch(
  params: CortexRunLaunchParams,
  deviceName: string,
  _spawn = spawn,
): Promise<LaunchResult> {
  const dir = path.join(CORTEX_RUN_DIR, params.name);

  // §8 decision #1: reject if exists without force, overwrite with force
  if (fs.existsSync(dir)) {
    if (!params.force) {
      throw new Error(
        `run '${params.name}' already exists at ${dir}; pass force:true to overwrite`,
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  fs.mkdirSync(dir, { recursive: true });

  const callbackId = `${deviceName}:${params.name}:${params.taskId ?? 'none'}`;

  // Write meta.json (DR-0011 §4.2 schema)
  const meta: Record<string, any> = {
    ...params,
    callbackId,
    device: deviceName,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  // §8 decision #1: validate cwd exists
  const cwd = params.cwd ?? process.cwd();
  if (!fs.existsSync(cwd)) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }

  // Spawn watcher detached (DR-0011 §4.5)
  const watcherEntry = path.join(__dirname, 'cortex-run-watcher.js');
  const watcher = _spawn(
    'node',
    [
      watcherEntry,
      '--name',
      params.name,
      '--stall',
      params.stall ?? '10m',
      '--gpu',
      params.gpu ?? 'auto',
      '--state-dir',
      dir,
      '--',
      ...params.command,
    ],
    {
      detached: true,
      stdio: 'ignore',
      cwd,
      env: { ...process.env, ...(params.env ?? {}) },
    },
  );
  watcher.unref();

  // Write PID file
  fs.writeFileSync(path.join(dir, 'pid'), String(watcher.pid));

  return { pid: watcher.pid!, callbackId, resultDir: dir };
}

// --- Cancel handler (DR-0011 §4.9) ---

/**
 * Sends a signal to the watcher (process group on POSIX, taskkill /T on Windows).
 * Does NOT directly modify TASKS.yaml — the standard callback path handles it.
 */
export async function handleCortexRunCancel(
  params: CortexRunCancelParams,
): Promise<CancelResult> {
  const dir = path.join(CORTEX_RUN_DIR, params.name);
  if (!fs.existsSync(dir)) {
    throw new Error(`run '${params.name}' not found`);
  }

  const pidFile = path.join(dir, 'pid');
  if (!fs.existsSync(pidFile)) {
    throw new Error(`run '${params.name}' has no live pid (already finished?)`);
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  if (!isPidAlive(pid)) {
    return { killed: false, pid };
  }

  try {
    // Windows: no process groups — use taskkill /T to kill the process tree
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' });
    } else {
      process.kill(-pid, params.signal ?? 'SIGTERM');
    }
    return { killed: true, pid };
  } catch (e: any) {
    throw new Error(`kill failed: ${e.message}`);
  }
}

// --- Flush pending callbacks (DR-0011 §4.7) ---

/**
 * Scans all cortex-run directories for callback.pending markers and sends
 * task-callback WS messages. Also detects orphaned runs (state.json=running
 * but PID dead) and synthesizes orphan results.
 *
 * Called: on client startup, on WS reconnect, and every 60s.
 */
export async function flushPendingCallbacks(
  ws: { send: (data: string) => void; readyState: number } | null,
  deviceName: string,
): Promise<void> {
  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;

  try {
    if (!fs.existsSync(CORTEX_RUN_DIR)) return;

    const entries = fs.readdirSync(CORTEX_RUN_DIR);
    for (const name of entries) {
      const runDir = path.join(CORTEX_RUN_DIR, name);
      if (!fs.statSync(runDir).isDirectory()) continue;

      const pendingPath = path.join(runDir, 'callback.pending');

      if (!fs.existsSync(pendingPath)) {
        // Check orphan: state.json=running but pid is dead
        const state = readJsonSafe(path.join(runDir, 'state.json'));
        if (state?.status === 'running' && state.pid > 0 && !isPidAlive(state.pid)) {
          log.warn(`Orphan detected: ${name} (pid ${state.pid}), synthesizing result`);
          synthesizeOrphanResult(runDir, state);
          // Now callback.pending exists; fall through to flush below
        } else {
          continue;
        }
      }

      // Guard: if synthesized, pending now exists; if not, skip
      if (!fs.existsSync(pendingPath)) continue;

      const meta = readJsonSafe(path.join(runDir, 'meta.json'));
      const result = readJsonSafe(path.join(runDir, 'result.json'));
      if (!meta || !result) {
        log.warn(`Skipping ${name}: missing meta.json or result.json`);
        continue;
      }

      const logTail = tailFile(path.join(runDir, 'output.log'), meta.logTailBytes ?? 4096);

      const callbackMsg: Record<string, any> = {
        type: 'task-callback',
        device: deviceName,
        callbackId: meta.callbackId,
        name: meta.name,
        taskProject: meta.taskProject ?? null,
        taskId: meta.taskId ?? null,
        dispatchGeneration: meta.dispatchGeneration ?? null,
        termination: result.termination,
        exitCode: result.exit_code,
        durationSeconds: result.duration_seconds ?? null,
        durationHuman: result.duration_human ?? null,
        startedAt: result.started_at ?? null,
        endedAt: result.ended_at ?? null,
        lastOutputLine: result.last_output_line ?? null,
        remoteResultPath: path.join(runDir, 'result.json'),
        remoteLogPath: path.join(runDir, 'output.log'),
        logTail,
        gpu: result.gpu ?? null,
      };

      ws.send(JSON.stringify(callbackMsg));
      // Don't delete marker — wait for server ack (DR-0011 §4.7)
    }
  } catch (err) {
    log.error(`flushPendingCallbacks error: ${(err as Error).message}`);
  }
}
