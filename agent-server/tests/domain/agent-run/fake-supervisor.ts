// input:  supervisor arguments, deadline, signals, control fd
// output: lifecycle edge cases and fixture process ownership
// pos:    Fake supervisor fixture for agent-run client tests
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

interface Invocation {
  controlFd: number;
  deadlineMs: number | null;
  command: string;
  commandArgs: string[];
}

type FixtureMode =
  | 'clean'
  | 'control-close'
  | 'duplicate-started'
  | 'error'
  | 'hang'
  | 'hold-quiescent'
  | 'malformed'
  | 'no-quiescent'
  | 'out-of-order'
  | 'trailing-duplicate'
  | 'trailing-error'
  | 'trailing-malformed';

interface CancellationState {
  cancelled(): boolean;
  deadline(): boolean;
  triggerDeadline(): void;
  stop(): void;
}

function optionValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) throw new Error(`missing ${name}`);
  return args[index + 1];
}

function optionalNumber(args: string[], name: string): number | null {
  const index = args.indexOf(name);
  return index < 0 ? null : Number(optionValue(args, name));
}

function parseInvocation(args: string[]): Invocation {
  const separator = args.indexOf('--');
  if (separator < 0 || separator + 1 >= args.length) throw new Error('missing supervised command');
  return {
    controlFd: Number(optionValue(args, '--control-fd')),
    deadlineMs: optionalNumber(args, '--deadline-ms'),
    command: args[separator + 1],
    commandArgs: args.slice(separator + 2),
  };
}

function writeControl(fd: number, value: Record<string, unknown>): void {
  fs.writeSync(fd, `${JSON.stringify(value)}\n`);
}

function timestamp(): string {
  return new Date().toISOString();
}

function recordArguments(): void {
  const file = process.env.FAKE_SUPERVISOR_ARGV_FILE;
  if (file) fs.writeFileSync(file, JSON.stringify(process.argv.slice(2)));
}

function recordProcess(): void {
  const file = process.env.FAKE_SUPERVISOR_PID_FILE;
  if (file) fs.writeFileSync(file, JSON.stringify({ pid: process.pid }));
}

function recordSignal(): void {
  const file = process.env.FAKE_SUPERVISOR_SIGNAL_FILE;
  if (file) fs.appendFileSync(file, 'SIGTERM\n');
}

async function waitForRelease(): Promise<void> {
  const file = process.env.FAKE_SUPERVISOR_RELEASE_FILE;
  if (!file) throw new Error('missing release file');
  while (!fs.existsSync(file)) await delay(5);
}

function errorReason(): 'unsupported_platform' | 'containment_failed' {
  return process.env.FAKE_SUPERVISOR_ERROR_REASON === 'unsupported_platform'
    ? 'unsupported_platform'
    : 'containment_failed';
}

function emitError(controlFd: number): void {
  writeControl(controlFd, { v: 1, type: 'error', reason: errorReason(), ts: timestamp() });
  process.exitCode = 125;
}

function startedRecord(pid: number): Record<string, unknown> {
  return { v: 1, type: 'started', pid, pgid: pid, ts: timestamp() };
}

function exitedRecord(code: number | null, signal: NodeJS.Signals | null): Record<string, unknown> {
  return { v: 1, type: 'exited', code, signal, ts: timestamp() };
}

function emitTrailingRecord(controlFd: number, mode: FixtureMode): void {
  if (mode === 'trailing-malformed') fs.writeSync(controlFd, '{trailing-malformed\n');
  if (mode === 'trailing-duplicate') {
    writeControl(controlFd, { v: 1, type: 'quiescent', descendants: 0, ts: timestamp() });
  }
  if (mode === 'trailing-error') {
    writeControl(controlFd, { v: 1, type: 'error', reason: 'containment_failed', ts: timestamp() });
  }
}

function signalGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function installCancellation(child: ChildProcess, deadlineMs: number | null): CancellationState {
  let cancelled = false;
  let deadline = false;
  const cancel = (timedOut: boolean) => {
    recordSignal();
    if (cancelled) return;
    cancelled = true;
    deadline = timedOut;
    signalGroup(child);
  };
  process.on('SIGTERM', () => cancel(false));
  process.on('SIGINT', () => cancel(false));
  const timer = deadlineMs === null ? null : setTimeout(() => cancel(true), deadlineMs);
  return {
    cancelled: () => cancelled,
    deadline: () => deadline,
    triggerDeadline: () => cancel(true),
    stop: () => { if (timer) clearTimeout(timer); },
  };
}

function waitForChild(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function emitOpening(controlFd: number, pid: number, mode: FixtureMode): boolean {
  if (mode === 'out-of-order') {
    writeControl(controlFd, exitedRecord(0, null));
    return false;
  }
  const started = startedRecord(pid);
  writeControl(controlFd, started);
  if (mode === 'duplicate-started') writeControl(controlFd, started);
  if (mode === 'control-close') fs.closeSync(controlFd);
  if (mode === 'malformed') fs.writeSync(controlFd, '{malformed-json\n');
  return !['control-close', 'duplicate-started', 'malformed'].includes(mode);
}

async function hangForever(): Promise<never> {
  process.once('SIGTERM', () => process.exit(130));
  while (true) await delay(1000);
}

function terminalExitCode(
  cancellation: CancellationState,
  result: { code: number | null; signal: NodeJS.Signals | null },
): number {
  if (cancellation.deadline()) return 124;
  if (cancellation.cancelled()) return 130;
  return result.code ?? 1;
}

async function runFixture(): Promise<void> {
  recordArguments();
  recordProcess();
  const invocation = parseInvocation(process.argv.slice(2));
  const mode = (process.env.FAKE_SUPERVISOR_MODE ?? 'clean') as FixtureMode;
  if (mode === 'error') return emitError(invocation.controlFd);
  const child = spawn(invocation.command, invocation.commandArgs, { detached: true, stdio: 'inherit' });
  if (child.pid === undefined) throw new Error('child did not start');
  const cancellation = installCancellation(child, invocation.deadlineMs);
  const continueProtocol = emitOpening(invocation.controlFd, child.pid, mode);
  if (!continueProtocol) signalGroup(child);
  if (process.env.FAKE_SUPERVISOR_TRIGGER_DEADLINE === '1') cancellation.triggerDeadline();
  if (mode === 'hang') await hangForever();
  const result = await waitForChild(child);
  cancellation.stop();
  if (!continueProtocol) return void (process.exitCode = 125);
  writeControl(invocation.controlFd, exitedRecord(result.code, result.signal));
  if (mode === 'no-quiescent') return void (process.exitCode = result.code ?? 125);
  if (mode === 'hold-quiescent') await waitForRelease();
  writeControl(invocation.controlFd, { v: 1, type: 'quiescent', descendants: 0, ts: timestamp() });
  emitTrailingRecord(invocation.controlFd, mode);
  process.exitCode = terminalExitCode(cancellation, result);
}

try {
  await runFixture();
} catch (error) {
  const file = process.env.FAKE_SUPERVISOR_FAILURE_FILE;
  if (file) fs.writeFileSync(file, (error as Error).stack ?? String(error));
  throw error;
}
