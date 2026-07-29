// input:  Node child processes, core paths and logging
// output: HookProcessOptions, HookProcessResult, runHookProcess
// pos:    shared subprocess runner for hook commands
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { spawn } from 'node:child_process';
import { createLogger } from './log.js';
import { DATA_DIR } from './paths.js';

const log = createLogger('hook-exec');
const STDERR_LIMIT = 2_000;

export interface HookProcessOptions {
  command: string;
  args?: string[];
  timeoutMs: number;
  stdinPayload: string;
  env?: NodeJS.ProcessEnv;
  label: string;
}

export interface HookProcessResult {
  stdout: string;
  stderr: string;
  error?: string;
}

interface HookProcessState {
  stdout: string;
  stderr: string;
  settled: boolean;
  resolve: (result: HookProcessResult) => void;
}

function finish(state: HookProcessState, result: HookProcessResult): void {
  if (state.settled) return;
  state.settled = true;
  state.resolve(result);
}

function fail(state: HookProcessState, error: string, message: string): void {
  if (state.settled) return;
  log.error(message);
  finish(state, { stdout: '', stderr: state.stderr.slice(-STDERR_LIMIT), error });
}

function handleClose(
  state: HookProcessState,
  opts: HookProcessOptions,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (signal === 'SIGTERM' || signal === 'SIGKILL') {
    const error = `timed out after ${opts.timeoutMs}ms`;
    fail(state, error, `${error} (${opts.label})`);
    return;
  }
  if (code !== 0) {
    const error = `exited with code ${code}`;
    const detail = state.stderr ? `: ${state.stderr.trim()}` : '';
    fail(state, error, `${error} (${opts.label})${detail}`);
    return;
  }
  finish(state, {
    stdout: state.stdout.trim(),
    stderr: state.stderr.slice(-STDERR_LIMIT),
  });
}

function writeStdin(
  stdin: NodeJS.WritableStream,
  opts: HookProcessOptions,
): void {
  stdin.on('error', (error: Error) => {
    log.warn(`stdin write failed (${opts.label}): ${error.message}`);
  });
  try {
    stdin.write(opts.stdinPayload);
  } catch (error) {
    log.warn(`stdin write failed (${opts.label}): ${String(error)}`);
  }
  try {
    stdin.end();
  } catch (error) {
    log.warn(`stdin end failed (${opts.label}): ${String(error)}`);
  }
}

function spawnHook(opts: HookProcessOptions) {
  return spawn('sh', ['-c', `${opts.command} "$@"`, 'hook', ...(opts.args ?? [])], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: DATA_DIR,
    timeout: opts.timeoutMs,
    ...(opts.env ? { env: opts.env } : {}),
  });
}

function startProcess(opts: HookProcessOptions, state: HookProcessState): void {
  try {
    const proc = spawnHook(opts);
    proc.stdout.on('data', (chunk: Buffer) => { state.stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { state.stderr += chunk.toString(); });
    proc.on('error', (error) => {
      fail(state, error.message, `spawn error (${opts.label}): ${error.message}`);
    });
    proc.on('close', (code, signal) => handleClose(state, opts, code, signal));
    writeStdin(proc.stdin, opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(state, message, `spawn error (${opts.label}): ${message}`);
  }
}

export function runHookProcess(opts: HookProcessOptions): Promise<HookProcessResult> {
  return new Promise((resolve) => {
    startProcess(opts, { stdout: '', stderr: '', settled: false, resolve });
  });
}
