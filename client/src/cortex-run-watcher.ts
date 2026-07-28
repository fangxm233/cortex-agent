// cortex-run-watcher — Stripped watchdog for client-resident execution.
//
// DR-0011 §4.6: Stripped from agent-server/src/domain/tasks/system/cortex-run.ts,
// removing agent-server dependencies (pendingTask/completeTask/blockTask, @core/paths),
// retaining stall detection, GPU auto pick, state/output/result file writing, SIGTERM cleanup;
// added callback.pending touch.
//
// Zero agent-server imports — only node:* builtins.
//
// Usage:
//     cortex-run-watcher --name NAME [--stall 10m] [--gpu auto] --state-dir DIR -- COMMAND [ARGS...]

import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// --- Types ---

interface WatcherArgs {
  name: string;
  stall: string;
  stallSeconds: number;
  gpu: string;
  stateDir: string;
  command: string[];
}

interface StateFile {
  status: string;
  pid: number;
  started_at: string;
  ended_at?: string;
  exit_code?: number;
  termination?: string;
  gpu?: GpuInfo | null;
}

/** The GPU actually selected for this execution. `indices` are the CUDA device ordinals
 *  (from `CUDA_VISIBLE_DEVICES`); `memoryMb` is the selected GPU's total memory (auto-pick
 *  only — best-effort, null for explicit `--gpu N`). */
export interface GpuInfo {
  indices: number[];
  memoryMb: number | null;
}

/** Result of an nvidia-smi auto-pick: the chosen device ordinal + its total memory (MiB). */
export interface PickedGpu {
  index: number;
  memoryMb: number | null;
}

const DEFAULT_STALL_SECONDS = 600; // 10 minutes

// --- Duration parsing ---

export function parseDuration(s: string): number {
  s = s.trim().toLowerCase();
  if (s.endsWith('d')) return parseInt(s.slice(0, -1), 10) * 86400;
  if (s.endsWith('h')) return parseInt(s.slice(0, -1), 10) * 3600;
  if (s.endsWith('m')) return parseInt(s.slice(0, -1), 10) * 60;
  if (s.endsWith('s')) return parseInt(s.slice(0, -1), 10);
  return parseInt(s, 10);
}

// --- GPU auto-pick (nvidia-smi) ---

export function pickBestGpu(
  spawnSyncFn: typeof spawnSync = spawnSync,
): PickedGpu | null {
  try {
    const result = spawnSyncFn('nvidia-smi', [
      '--query-gpu=index,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8' as const, timeout: 10_000 });

    if (result.status !== 0) return null;

    const gpus = result.stdout.trim().split('\n')
      .map(line => {
        const parts = line.split(',');
        if (parts.length < 2) return null;
        const index = parseInt(parts[0].trim(), 10);
        const memUsed = parseInt(parts[1].trim(), 10);
        if (Number.isNaN(index) || Number.isNaN(memUsed)) return null;
        const memTotal = parts[2] !== undefined ? parseInt(parts[2].trim(), 10) : NaN;
        return { index, memUsed, memoryMb: Number.isNaN(memTotal) ? null : memTotal };
      })
      .filter((v): v is { index: number; memUsed: number; memoryMb: number | null } => v !== null);

    if (gpus.length === 0) return null;
    const best = gpus.reduce((a, b) => a.memUsed <= b.memUsed ? a : b);
    return { index: best.index, memoryMb: best.memoryMb };
  } catch {
    return null;
  }
}

/**
 * Resolve the `--gpu` argument into the concrete `CUDA_VISIBLE_DEVICES` string to export and the
 * `GpuInfo` to persist for this execution (DR-0018 §6.3 B2-followup — per-execution GPU capture).
 *
 * - `auto`  → nvidia-smi pick (lowest memory.used); its total memory populates `memoryMb`.
 * - `none`  → no CUDA env, gpu null.
 * - `N` / `0,1` → passed through verbatim to `CUDA_VISIBLE_DEVICES`; indices parsed; `memoryMb` null
 *   (we don't shell out to nvidia-smi for an explicit selection).
 * A malformed explicit value keeps the legacy behaviour (set env verbatim) but records no gpu.
 */
export function resolveGpuSelection(
  gpuArg: string,
  pick: typeof pickBestGpu = pickBestGpu,
): { cudaVisibleDevices: string | null; gpu: GpuInfo | null } {
  if (gpuArg === 'none') {
    return { cudaVisibleDevices: null, gpu: null };
  }
  if (gpuArg === 'auto') {
    const picked = pick();
    if (picked === null) return { cudaVisibleDevices: null, gpu: null };
    return {
      cudaVisibleDevices: String(picked.index),
      gpu: { indices: [picked.index], memoryMb: picked.memoryMb },
    };
  }
  const indices = gpuArg.split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !Number.isNaN(n));
  if (indices.length === 0) {
    return { cudaVisibleDevices: gpuArg, gpu: null };
  }
  return { cudaVisibleDevices: gpuArg, gpu: { indices, memoryMb: null } };
}

// --- Stall detection ---

export function checkStallConditions(
  lastOutputTime: number,
  lastProgressTime: number,
  now: number,
  stallMs: number,
  lastLineContent: string,
): 'output_stall' | 'progress_stall' | null {
  // Layer 1: Output stall (no new bytes at all)
  if (now - lastOutputTime > stallMs) {
    return 'output_stall';
  }

  // Layer 2: Progress stall (output flowing but last line unchanged)
  if (lastLineContent && now - lastProgressTime > stallMs) {
    return 'progress_stall';
  }

  return null;
}

// --- State file writing ---

export function writeStateFile(stateDir: string, state: StateFile): void {
  const statePath = join(stateDir, 'state.json');
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
    // best-effort
  }
}

// --- Result computation ---

export function computeResult(
  name: string,
  command: string[],
  startedAt: string,
  endedAt: string,
  exitCode: number,
  termination: string,
  lastLineContent: string,
  logPath: string,
  stallLimit: string,
  gpu: GpuInfo | null,
): Record<string, any> {
  const duration = (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000;
  const durationHuman = duration > 3600
    ? `${(duration / 3600).toFixed(1)}h`
    : `${Math.round(duration / 60)}m`;

  return {
    name,
    command,
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: Math.round(duration * 10) / 10,
    duration_human: durationHuman,
    exit_code: exitCode,
    termination,
    last_output_line: lastLineContent.slice(0, 500),
    log_file: logPath,
    stall_limit: stallLimit,
    gpu,
  };
}

// --- Process group kill ---

export function killProcessGroup(pid: number): void {
  // Windows: no process groups — use taskkill /T to kill the process tree
  if (process.platform === 'win32') {
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' }); } catch { /* already gone */ }
    return;
  }
  // POSIX: negative PID sends signal to entire process group
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 12_000);
}

// --- CLI parsing ---

export function parseCliArgs(): WatcherArgs {
  const rawArgs = process.argv.slice(2);
  const sepIdx = rawArgs.indexOf('--');
  if (sepIdx === -1) {
    console.error('Error: No command specified. Use -- to separate watcher args from command.');
    process.exit(2);
  }

  const watcherArgs = rawArgs.slice(0, sepIdx);
  const command = rawArgs.slice(sepIdx + 1);

  if (command.length === 0) {
    console.error('Error: No command specified after --.');
    process.exit(2);
  }

  const { values } = parseArgs({
    args: watcherArgs,
    options: {
      name:       { type: 'string' },
      stall:      { type: 'string', default: '10m' },
      gpu:        { type: 'string', default: 'auto' },
      'state-dir': { type: 'string' },
    },
    strict: true,
  });

  if (!values.name) {
    console.error('Error: --name is required.');
    process.exit(2);
  }

  if (!values['state-dir']) {
    console.error('Error: --state-dir is required.');
    process.exit(2);
  }

  const stallSeconds = parseDuration(values.stall);
  if (isNaN(stallSeconds) || stallSeconds <= 0) {
    console.error(`Error: invalid --stall value '${values.stall}'.`);
    process.exit(2);
  }

  return {
    name: values.name,
    stall: values.stall,
    stallSeconds,
    gpu: values.gpu,
    stateDir: values['state-dir'],
    command,
  };
}

// --- Run loop ---

// State-dir contract with cortex-client (the client only reads these files, never writes them
// except for the orphan path):
//   state.json       — running heartbeat, rewritten every stall tick (5s) and once on exit
//   output.log       — streamed stdout+stderr of the user command
//   result.json      — written once on completion (name, command, timestamps, duration, exit code,
//                      termination, last output line, log path, gpu)
//   callback.pending — empty marker touched LAST; its existence is what makes the client push a
//                      task-callback. The client unlinks it only after the server acks.
// `termination` is one of: completed | output_stall | progress_stall | signal:<NAME> |
// interrupted (watcher got SIGTERM/SIGINT) | orphaned — the last one is never written here, the
// client synthesizes it when state.json says running but the pid is dead.
export function run(args: WatcherArgs): Promise<number> {
  return new Promise((resolvePromise) => {
    const stateDir = args.stateDir;
    const logPath = join(stateDir, 'output.log');
    const resultPath = join(stateDir, 'result.json');

    mkdirSync(stateDir, { recursive: true });

    // Resolve GPU selection (pure) → CUDA env + per-execution GpuInfo to persist (B2-followup)
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    const { cudaVisibleDevices, gpu } = resolveGpuSelection(args.gpu);
    if (args.gpu === 'auto') {
      if (gpu) console.log(`[cortex-run] GPU auto-select: picked GPU ${gpu.indices.join(',')} (lowest memory usage)`);
      else console.log('[cortex-run] GPU auto-select: nvidia-smi unavailable, not setting CUDA_VISIBLE_DEVICES');
    }

    if (cudaVisibleDevices !== null) {
      env.CUDA_VISIBLE_DEVICES = cudaVisibleDevices;
    }

    const startTime = Date.now();
    const startDt = new Date().toISOString();

    console.log(`[cortex-run] Starting: ${args.name}`);
    console.log(`[cortex-run] Command: ${args.command.join(' ')}`);
    console.log(`[cortex-run] Stall timeout: ${args.stall} (${args.stallSeconds}s)`);
    if (cudaVisibleDevices !== null) console.log(`[cortex-run] GPU: CUDA_VISIBLE_DEVICES=${cudaVisibleDevices}`);
    console.log(`[cortex-run] State dir: ${stateDir}`);
    console.log(`[cortex-run] Started at: ${startDt}`);

    const proc = spawn(args.command[0], args.command.slice(1), {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    // Write initial state file
    writeStateFile(stateDir, {
      status: 'running',
      pid: proc.pid!,
      started_at: startDt,
      gpu,
    });

    let termination = 'completed';
    let lastOutputTime = Date.now();
    let lastLineContent = '';
    let lastProgressTime = Date.now();

    const logStream = createWriteStream(logPath);

    let stallTimer: ReturnType<typeof setInterval> | null = null;

    function checkStall() {
      const now = Date.now();
      const stallMs = args.stallSeconds * 1000;

      const result = checkStallConditions(lastOutputTime, lastProgressTime, now, stallMs, lastLineContent);
      if (result === 'output_stall') {
        const silentMin = ((now - lastOutputTime) / 60000).toFixed(0);
        const msg = `[cortex-run] OUTPUT STALL: no output for ${silentMin}m. Killing.`;
        console.error(msg);
        logStream.write(`\n${msg}\n`);
        termination = 'output_stall';
        killProcessGroup(proc.pid!);
      } else if (result === 'progress_stall') {
        const stuckMin = ((now - lastProgressTime) / 60000).toFixed(0);
        const msg = `[cortex-run] PROGRESS STALL: last line unchanged for ${stuckMin}m. Last: ${lastLineContent.slice(0, 120)}. Killing.`;
        console.error(msg);
        logStream.write(`\n${msg}\n`);
        termination = 'progress_stall';
        killProcessGroup(proc.pid!);
      }
    }

    stallTimer = setInterval(checkStall, 5000);

    function onData(data: Buffer) {
      const text = data.toString('utf8');
      logStream.write(text);
      lastOutputTime = Date.now();

      const lines = text.trim().split('\n');
      const newLast = lines[lines.length - 1]?.trim() || '';
      if (newLast && newLast !== lastLineContent) {
        lastLineContent = newLast;
        lastProgressTime = Date.now();
      }
    }

    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);

    function finish(code: number | null, sig: string | null) {
      clearInterval(stallTimer!);
      logStream.end();

      const endTime = Date.now();
      const endDt = new Date().toISOString();
      const duration = (endTime - startTime) / 1000;
      const exitCode = code ?? (sig ? 128 : -1);

      if (sig && termination === 'completed') {
        termination = `signal:${sig}`;
      }

      const result = computeResult(
        args.name, args.command, startDt, endDt,
        exitCode, termination, lastLineContent, logPath, args.stall, gpu,
      );

      writeFileSync(resultPath, JSON.stringify(result, null, 2));

      // Update state file
      const finalStatus = (termination === 'completed' && exitCode === 0) ? 'completed' : 'failed';
      writeStateFile(stateDir, {
        status: finalStatus,
        pid: proc.pid!,
        started_at: startDt,
        ended_at: endDt,
        exit_code: exitCode,
        termination: termination,
        gpu,
      });

      // Touch callback.pending — signals cortex-client that this run needs a callback
      writeFileSync(join(stateDir, 'callback.pending'), '');

      const statusIcon = (termination === 'completed' && exitCode === 0) ? 'OK' : 'FAIL';
      console.log(`\n[cortex-run] ${'='.repeat(50)}`);
      console.log(`[cortex-run] ${statusIcon}: ${args.name}`);
      console.log(`[cortex-run] Termination: ${termination}`);
      console.log(`[cortex-run] Exit code: ${exitCode}`);
      console.log(`[cortex-run] Duration: ${result.duration_human}`);
      console.log(`[cortex-run] Result: ${resultPath}`);
      console.log(`[cortex-run] Log: ${logPath}`);
      console.log(`[cortex-run] ${'='.repeat(50)}`);

      resolvePromise(exitCode ?? 1);
    }

    proc.on('close', finish);

    process.on('SIGINT', () => {
      termination = 'interrupted';
      killProcessGroup(proc.pid!);
    });

    process.on('SIGTERM', () => {
      termination = 'interrupted';
      killProcessGroup(proc.pid!);
    });
  });
}

// --- Main entry ---

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseCliArgs();
  const exitCode = await run(args);
  process.exit(exitCode);
}
