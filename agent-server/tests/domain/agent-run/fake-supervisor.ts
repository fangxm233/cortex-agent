// input:  supervisor CLI arguments, process signals, control fd
// output: deterministic lifecycle edge cases from a real child
// pos:    Fake supervisor fixture for agent-run client tests
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

interface Invocation {
  controlFd: number;
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

function optionValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) throw new Error(`missing ${name}`);
  return args[index + 1];
}

function parseInvocation(args: string[]): Invocation {
  const separator = args.indexOf('--');
  if (separator < 0 || separator + 1 >= args.length) throw new Error('missing supervised command');
  return {
    controlFd: Number(optionValue(args, '--control-fd')),
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

function exitedRecord(
  code: number | null,
  signal: NodeJS.Signals | null,
): Record<string, unknown> {
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

function installCancellation(child: ChildProcess): () => boolean {
  let cancelled = false;
  const cancel = () => {
    recordSignal();
    if (cancelled) return;
    cancelled = true;
    child.kill('SIGTERM');
  };
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  return () => cancelled;
}

function waitForChild(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
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

async function runFixture(): Promise<void> {
  recordArguments();
  const invocation = parseInvocation(process.argv.slice(2));
  const mode = (process.env.FAKE_SUPERVISOR_MODE ?? 'clean') as FixtureMode;
  if (mode === 'error') return emitError(invocation.controlFd);
  const child = spawn(invocation.command, invocation.commandArgs, {
    detached: mode === 'hang',
    stdio: 'inherit',
  });
  if (child.pid === undefined) throw new Error('child did not start');
  const wasCancelled = installCancellation(child);
  const continueProtocol = emitOpening(invocation.controlFd, child.pid, mode);
  if (!continueProtocol) child.kill('SIGTERM');
  if (mode === 'hang') await hangForever();
  const result = await waitForChild(child);
  if (!continueProtocol) return void (process.exitCode = 125);
  writeControl(invocation.controlFd, exitedRecord(result.code, result.signal));
  if (mode === 'no-quiescent') return void (process.exitCode = result.code ?? 125);
  if (mode === 'hold-quiescent') await waitForRelease();
  writeControl(invocation.controlFd, { v: 1, type: 'quiescent', descendants: 0, ts: timestamp() });
  emitTrailingRecord(invocation.controlFd, mode);
  process.exitCode = wasCancelled() ? 130 : (result.code ?? 125);
}

await runFixture();
