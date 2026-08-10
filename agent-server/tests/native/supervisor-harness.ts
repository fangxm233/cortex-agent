// input:  native build, control transport, /proc and fixtures
// output: supervisor runners, teardown triggers and leak checks
// pos:    Integration harness for the Linux containment supervisor
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex, Readable } from 'node:stream';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(TEST_DIR, '../..');
export const SUPERVISOR_ROOT = path.join(SERVER_ROOT, 'native', 'cortex-supervisor');
export const SUPERVISOR_BIN = path.join(SUPERVISOR_ROOT, 'dist', 'cortex-supervisor');
export const BUILD_MANIFEST = path.join(SUPERVISOR_ROOT, 'dist', 'build-manifest.json');
const FIXTURE_DIR = path.join(TEST_DIR, 'fixtures');
const FIXTURE_SCRIPT = path.join(FIXTURE_DIR, 'fake-agent.sh');
const FIXTURE_SOURCE = path.join(FIXTURE_DIR, 'refork-grandchild.c');
const trackedTokens = new Set<string>();

export interface ProtocolRecord {
  v: number;
  type: 'started' | 'exited' | 'quiescent' | 'error';
  [key: string]: unknown;
}

export interface SupervisorResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  control: ProtocolRecord[];
}

export interface EscapeResult extends SupervisorResult {
  token: string;
  workspace: string;
  mutationAtExit: string;
  mutationAfterExit: string;
}

interface RunningSupervisor {
  child: ChildProcess;
  control: Duplex;
  cancel: Duplex | null;
  result: Promise<SupervisorResult>;
}

function commandFailure(command: string, result: ReturnType<typeof spawnSync>): string {
  return `${command} failed (${result.status})\nstdout: ${String(result.stdout)}\nstderr: ${String(result.stderr)}`;
}

function runChecked(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, commandFailure(`${command} ${args.join(' ')}`, result));
}

export function buildSupervisor(testRoot: string): string {
  runChecked('npm', ['run', 'build:supervisor'], SERVER_ROOT);
  const helper = path.join(testRoot, 'refork-grandchild');
  runChecked('gcc', ['-std=c11', '-D_GNU_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror', FIXTURE_SOURCE, '-o', helper], SERVER_ROOT);
  return helper;
}

function collect(stream: Readable | null): { read: () => string } {
  let output = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => { output += chunk; });
  stream?.on('error', () => { /* peer closure is asserted through process outcome */ });
  return { read: () => output };
}

function parseControl(output: string): ProtocolRecord[] {
  return output.split('\n').filter(Boolean).map((line) => JSON.parse(line) as ProtocolRecord);
}

function waitForChild(child: ChildProcess, timeoutMs = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`supervisor timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

export function startSupervisor(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): RunningSupervisor {
  const hasCancel = args.includes('--cancel-fd');
  const stdio: StdioOptions = hasCancel
    ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']
    : ['pipe', 'pipe', 'pipe', 'pipe'];
  const child = spawn(SUPERVISOR_BIN, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio,
  });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const control = child.stdio[3] as Duplex;
  const cancel = hasCancel ? child.stdio[4] as Duplex : null;
  cancel?.on('error', () => { /* supervisor closes this read end after cancellation */ });
  const controlOutput = collect(control);
  const result = waitForChild(child).then(({ code, signal }) => ({
    exitCode: code,
    signal,
    stdout: stdout.read(),
    stderr: stderr.read(),
    control: parseControl(controlOutput.read()),
  }));
  return { child, control, cancel, result };
}

export async function waitForPath(filePath: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function readMutation(workspace: string): string {
  const filePath = path.join(workspace, 'mutations.log');
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function scenarioArgs(helper: string, token: string, workspace: string, trigger: string): string[] {
  const args = ['--control-fd', '3', '--grace-ms', '120'];
  if (trigger === 'deadline') args.push('--deadline-ms', '500');
  if (trigger.startsWith('cancel-')) args.push('--cancel-fd', '4');
  return [...args, '--', '/bin/sh', FIXTURE_SCRIPT, helper, token, workspace, trigger === 'normal' ? 'normal' : 'stay'];
}

export async function runEscapeScenario(
  testRoot: string,
  helper: string,
  trigger: 'normal' | 'sigterm' | 'deadline' | 'cancel-close' | 'cancel-byte' | 'control-failure',
): Promise<EscapeResult> {
  const token = `cortex-supervisor-${randomUUID()}`;
  trackedTokens.add(token);
  const workspace = path.join(testRoot, token);
  mkdirSync(workspace);
  const args = scenarioArgs(helper, token, workspace, trigger);
  const running = startSupervisor(args, { cwd: workspace });
  await waitForPath(path.join(workspace, 'ready'));
  if (trigger === 'sigterm') running.child.kill('SIGTERM');
  if (trigger === 'cancel-close') running.cancel?.end();
  if (trigger === 'cancel-byte') running.cancel?.write('cancel');
  if (trigger === 'control-failure') running.control.destroy();
  const result = await running.result;
  const mutationAtExit = readMutation(workspace);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const mutationAfterExit = readMutation(workspace);
  return { ...result, token, workspace, mutationAtExit, mutationAfterExit };
}

function numericProcEntries(): string[] {
  return readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
}

export function scanToken(token: string): number[] {
  const matches: number[] = [];
  for (const entry of numericProcEntries()) {
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`).toString('utf8');
      if (cmdline.includes(token)) matches.push(Number(entry));
    } catch { /* process exited during the scan */ }
  }
  return matches;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function cleanupTokenSync(token: string): void {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pids = scanToken(token);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`).toString('utf8');
        if (cmdline.includes(token)) process.kill(pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
    sleepSync(10);
  }
}

export async function assertNoToken(token: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (scanToken(token).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(scanToken(token), [], `surviving processes for token ${token}`);
}

export function releaseToken(token: string): void {
  trackedTokens.delete(token);
}

export function cleanupTrackedTokensSync(): void {
  for (const token of trackedTokens) cleanupTokenSync(token);
  trackedTokens.clear();
}

process.on('exit', cleanupTrackedTokensSync);

export function sourceDigest(files: string[]): string {
  const inventory = files.map((file) => {
    const digest = createHash('sha256').update(readFileSync(path.join(SUPERVISOR_ROOT, file))).digest('hex');
    return `${digest}  ${file}\n`;
  }).join('');
  return createHash('sha256').update(inventory).digest('hex');
}

export function binaryDigest(): string {
  return createHash('sha256').update(readFileSync(SUPERVISOR_BIN)).digest('hex');
}

export function fileSize(filePath: string): number {
  return statSync(filePath).size;
}

export function removeTestRoot(testRoot: string): void {
  rmSync(testRoot, { recursive: true, force: true });
}

export function testRootPrefix(): string {
  return path.join(tmpdir(), 'cortex-supervisor-test-');
}
