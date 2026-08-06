// input:  cortex CLI, fake supervisor, temp process fixtures
// output: shared agent-run E2E setup and process cleanup helpers
// pos:    Process fixture support for serial agent-run E2E tests
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

const ENTRY = fileURLToPath(new URL('../../../src/entry/cli.ts', import.meta.url));
const FAKE_SUPERVISOR = fileURLToPath(new URL('./fake-supervisor.ts', import.meta.url));
const WORKER_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
export const SHA256 = /^[a-f0-9]{64}$/;

interface TrackedRun {
  child: ChildProcess;
  fixture: Fixture;
}

interface OwnedRun {
  child: ChildProcess;
  owner: string;
  pids: number[];
  groups: number[];
}

let root = '';
let runs: TrackedRun[] = [];
const signalHandlers = new Map<NodeJS.Signals, () => void>();

beforeAll(installWorkerCleanup);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-e2e-'));
  runs = [];
});

afterEach(async () => {
  await cleanupRuns();
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(removeWorkerCleanup);

const FAKE_CLAUDE_SOURCE = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
appendFileSync(process.env.FAKE_CLAUDE_INVOCATIONS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.includes('--version')) {
  console.log(process.env.FAKE_CLAUDE_VERSION ?? 'fixture-claude 1.0.0');
  process.exit(0);
}
writeFileSync(process.env.FAKE_CLAUDE_MARKER, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
if (process.env.FAKE_CLAUDE_PROBE_SIGNAL === '1') {
  process.on('SIGUSR1', () => {
    console.log(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed', summary: 'probe' }));
    console.log(JSON.stringify({ type: 'assistant', message: { id: 'probe', model: 'claude-reported-fixture', content: [{ type: 'text', text: 'background hold probe' }] } }));
  });
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.once('line', (line) => {
  const request = JSON.parse(line);
  if (process.env.PROMPT_CAPTURE) writeFileSync(process.env.PROMPT_CAPTURE, JSON.stringify(request));
  if (process.env.FAKE_CLAUDE_MODE === 'fail') {
    return void process.exit(Number(process.env.FAKE_CLAUDE_EXIT_CODE ?? 7));
  }
  if (process.env.FAKE_CLAUDE_MODE === 'signal') return void process.kill(process.pid, 'SIGKILL');
  const command = 'pwd > "$BASH_CWD_MARKER"; while [ ! -f "$RELEASE_MARKER" ]; do sleep 0.01; done; echo done > "$BACKGROUND_MARKER"';
  const child = spawn('/bin/bash', ['-c', command], { cwd: process.cwd(), env: process.env });
  appendFileSync(process.env.FAKE_CLAUDE_MARKER, '\\n' + JSON.stringify({ bash_pid: child.pid }));
  console.log(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'bg1', task_type: 'local_bash' }));
  if (process.env.FAKE_CLAUDE_COMPACT === '1') {
    console.log(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 42 } }));
  }
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'a1', model: 'claude-reported-fixture', content: [{ type: 'text', text: 'first result' }] } }));
  if (process.env.FAKE_CLAUDE_SUBAGENT === '1') {
    // One native subagent call in the CLI's own wire shape: the Agent/Task call, the subagent's
    // own lines carrying parent_tool_use_id, and the call's result on the parent's line.
    console.log(JSON.stringify({ type: 'assistant', message: { id: 'ag', model: 'claude-reported-fixture', content: [{ type: 'tool_use', id: 'toolu_agent_1', name: 'Task', input: { prompt: 'survey' } }] } }));
    console.log(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_agent_1', subagent_type: 'explore', message: { id: 's1', model: 'claude-reported-fixture', content: [{ type: 'text', text: 'subagent speaking' }] } }));
    console.log(JSON.stringify({ type: 'user', parent_tool_use_id: 'toolu_agent_1', message: { content: [{ type: 'tool_result', tool_use_id: 'sub-call-1', content: 'sub ok' }] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent_1', content: 'agent done' }] } }));
  }
  const firstResult = process.env.FAKE_CLAUDE_FIRST_RESULT
    ? JSON.parse(process.env.FAKE_CLAUDE_FIRST_RESULT)
    : { type: 'result', subtype: 'success', is_error: false, session_id: request.session_id, result: 'first result', total_cost_usd: 0.25, num_turns: 1 };
  console.log(JSON.stringify(firstResult));
  const emitContinuation = () => {
    console.log(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed', summary: 'done' }));
    console.log(JSON.stringify({ type: 'assistant', message: { id: 'a2', model: 'claude-reported-fixture', content: [{ type: 'text', text: 'background done' }] } }));
    const continuationResult = process.env.FAKE_CLAUDE_CONTINUATION_RESULT
      ? JSON.parse(process.env.FAKE_CLAUDE_CONTINUATION_RESULT)
      : { type: 'result', subtype: 'success', origin: { kind: 'task-notification' }, is_error: false, session_id: request.session_id, result: 'background done', total_cost_usd: 0.1, num_turns: 1 };
    console.log(JSON.stringify(continuationResult));
  };
  if (process.env.FAKE_CLAUDE_EARLY_CONTINUATION === '1') emitContinuation();
  else child.once('close', emitContinuation);
});
`;

export interface Fixture {
  home: string;
  cwd: string;
  trajectoryRoot: string;
  eventsFile: string;
  releaseMarker: string;
  backgroundMarker: string;
  bashCwdMarker: string;
  claudeMarker: string;
  claudeInvocationMarker: string;
  supervisorMarker: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function installFakeSupervisor(binDir: string): void {
  const compiled = path.join(binDir, 'fake-supervisor.mjs');
  const source = fs.readFileSync(FAKE_SUPERVISOR, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  fs.writeFileSync(compiled, output);
  writeExecutable(path.join(binDir, 'cortex-supervisor'),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(compiled)} "$@"\n`);
}

function installFakeClaude(binDir: string): void {
  writeExecutable(path.join(binDir, 'claude'), FAKE_CLAUDE_SOURCE);
}

export function installFailingWriteHook(file: string): void {
  fs.writeFileSync(file, `import fs from 'node:fs';
const originalOpen = fs.openSync.bind(fs);
const originalWrite = fs.writeSync.bind(fs);
let targetFd = null;
let writes = 0;
fs.openSync = function(file, ...args) {
  const fd = originalOpen(file, ...args);
  if (String(file) === process.env.FAIL_WRITE_PATH) targetFd = fd;
  return fd;
};
fs.writeSync = function(fd, ...args) {
  if (fd === targetFd && writes++ > 1) {
    const error = new Error('forced journal write failure');
    error.code = 'EIO';
    throw error;
  }
  return originalWrite(fd, ...args);
};
`);
}

export function fakeClaudeResult(
  sessionId: string, result: string, additions: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    session_id: sessionId, result, num_turns: 1, ...additions,
  });
}

export function writeProfile(file: string, extraOption: Record<string, string> = {}): void {
  fs.writeFileSync(file, JSON.stringify({
    defaultProfile: 'fixture',
    profiles: {
      fixture: {
        model: 'claude-requested-fixture', backend: 'claude', claudeBackend: 'print',
        provider: 'anthropic', fallback: [], extraOption,
      },
    },
  }));
}

function writeRunConfig(file: string): void {
  fs.writeFileSync(path.join(path.dirname(file), 'mcp-config-empty.json'), '{"mcpServers":{}}\n');
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 'cortex-agent-run-config/1',
    model_execution: { model_alias_policy: { kind: 'exact' } },
    role: {
      system_prompt: '', tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      plugin_dirs: [], mcp_composition: 'none',
      mcp_config_paths: ['mcp-config-empty.json'], disable_hooks: true,
    },
    bundle: {
      run_config: { arm: 'fixture' }, limits: {},
      adapter_hashes: { fixture: 'adapter' }, harness_hashes: null,
    },
  }));
}

function seedFixture(base: string): { home: string; cwd: string; trajectoryRoot: string } {
  const home = path.join(base, 'seeded-home');
  const cwd = path.join(base, 'task-workspace');
  const binDir = path.join(base, 'bin');
  const profileFile = path.join(home, 'config', 'profiles.json');
  fs.mkdirSync(path.dirname(profileFile), { recursive: true });
  fs.mkdirSync(cwd);
  fs.mkdirSync(binDir);
  installFakeSupervisor(binDir);
  installFakeClaude(binDir);
  writeProfile(profileFile);
  writeRunConfig(path.join(base, 'agent-run.json'));
  fs.writeFileSync(path.join(base, 'prompt.txt'), 'finish the fixture\r\n');
  const trajectoryRoot = path.join(base, 'trajectory');
  fs.mkdirSync(trajectoryRoot);
  return { home, cwd, trajectoryRoot };
}

function fixturePaths(base: string, seeded: ReturnType<typeof seedFixture>): Fixture {
  return {
    ...seeded,
    eventsFile: path.join(seeded.trajectoryRoot, 'events.jsonl'),
    releaseMarker: path.join(base, 'release'),
    backgroundMarker: path.join(base, 'background-done'),
    bashCwdMarker: path.join(base, 'bash-cwd'),
    claudeMarker: path.join(base, 'claude.jsonl'),
    claudeInvocationMarker: path.join(base, 'claude-invocations.jsonl'),
    supervisorMarker: path.join(base, 'supervisor.json'),
    args: [], env: {},
  };
}

function fixtureArgs(base: string, fixture: Fixture): string[] {
  return [
    '--prompt-file', path.join(base, 'prompt.txt'), '--agent-slot', 'parent', '--profile', 'fixture',
    '--cwd', fixture.cwd, '--output-format', 'jsonl', '--events-file', fixture.eventsFile,
    '--run-config', path.join(base, 'agent-run.json'),
    '--root-run-id', 'e2e-run', '--grace-ms', '50',
  ];
}

function fixtureEnv(base: string, fixture: Fixture): NodeJS.ProcessEnv {
  const binDir = path.join(base, 'bin');
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    LANG: 'C', CORTEX_HOME: fixture.home,
    CORTEX_SUPERVISOR_BINARY: path.join(binDir, 'cortex-supervisor'),
    CORTEX_PROJECTS_DIR: path.join(base, 'projects'),
    HOME: path.join(base, 'user-home'), XDG_CONFIG_HOME: path.join(base, 'xdg-config'),
    XDG_CACHE_HOME: path.join(base, 'xdg-cache'), CLAUDE_CONFIG_DIR: path.join(base, 'claude-config'),
    AGENT_RUN_E2E_OWNER: base,
    FAKE_SUPERVISOR_MODE: 'clean',
    FAKE_SUPERVISOR_FAILURE_FILE: path.join(base, 'supervisor-failure.txt'),
    FAKE_SUPERVISOR_PID_FILE: fixture.supervisorMarker,
    FAKE_CLAUDE_MARKER: fixture.claudeMarker,
    FAKE_CLAUDE_INVOCATIONS: fixture.claudeInvocationMarker,
    BASH_CWD_MARKER: fixture.bashCwdMarker,
    BACKGROUND_MARKER: fixture.backgroundMarker,
    RELEASE_MARKER: fixture.releaseMarker,
  };
}

export function createFixture(name = 'run'): Fixture {
  const base = path.join(root, name);
  const fixture = fixturePaths(base, seedFixture(base));
  fixture.args = fixtureArgs(base, fixture);
  fixture.env = fixtureEnv(base, fixture);
  return fixture;
}

export function fixtureRoot(): string {
  return root;
}

export function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
}

function observeFileState(
  file: string,
  condition: () => boolean,
  message: string,
  child: ChildProcess,
  diagnostics?: () => string,
): Promise<void> {
  if (condition()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(path.dirname(file), check);
    const finish = (error?: Error) => {
      watcher.close();
      child.off('error', onChildError);
      child.off('close', onChildClose);
      if (error) reject(error); else resolve();
    };
    function check(): void { if (condition()) finish(); }
    const failure = () => new Error(`${message}: ${diagnostics?.() ?? ''}`);
    const onChildError = (error: Error) => finish(error);
    const onChildClose = () => { if (condition()) finish(); else finish(failure()); };
    watcher.once('error', onChildError);
    child.once('error', onChildError);
    child.once('close', onChildClose);
    check();
  });
}

export function waitForFile(
  file: string, message: string, child: ChildProcess, diagnostics?: () => string,
): Promise<void> {
  return observeFileState(file, () => fs.existsSync(file), message, child, diagnostics);
}

export function waitForText(
  file: string, text: string, child: ChildProcess,
): Promise<void> {
  const contains = () => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(text);
  return observeFileState(file, contains, `missing '${text}' in ${file}`, child);
}

export function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    stream.on('data', chunk => { output += chunk.toString(); });
    stream.on('end', () => resolve(output));
    stream.on('error', reject);
  });
}

function listeningSocketInodes(pid: number): Set<string> {
  const inodes = new Set<string>();
  for (const file of fs.readdirSync(`/proc/${pid}/fd`)) {
    try {
      const target = fs.readlinkSync(`/proc/${pid}/fd/${file}`);
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match) inodes.add(match[1]);
    } catch {}
  }
  return inodes;
}

function listeningInodes(pid: number): Set<string> {
  const listening = new Set<string>();
  for (const name of ['tcp', 'tcp6']) {
    const lines = fs.readFileSync(`/proc/${pid}/net/${name}`, 'utf8').trim().split('\n').slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A') listening.add(fields[9]);
    }
  }
  return listening;
}

export function assertNoListeningSocket(pid: number): void {
  const processSockets = listeningSocketInodes(pid);
  const listeners = listeningInodes(pid);
  assert.deepEqual([...processSockets].filter(inode => listeners.has(inode)), []);
}

export function processTree(pid: number): string[] {
  const result: string[] = [];
  const visit = (current: number) => {
    try {
      const cmdline = fs.readFileSync(`/proc/${current}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
      result.push(`${current}:${cmdline}`);
      const childFile = `/proc/${current}/task/${current}/children`;
      const descendants = fs.readFileSync(childFile, 'utf8').trim().split(/\s+/).filter(Boolean);
      for (const child of descendants) visit(Number(child));
    } catch {}
  };
  visit(pid);
  return result;
}

export function fileTree(rootDir: string): string[] {
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(rootDir, absolute);
      result.push(entry.isDirectory() ? `${relative}/` : relative);
      if (entry.isDirectory()) walk(absolute);
    }
  };
  walk(rootDir);
  return result.sort();
}

interface TreeStat {
  type: 'directory' | 'file';
  size: number;
  mtimeMs: number;
}

export function snapshotTree(rootDir: string): Record<string, TreeStat> {
  return Object.fromEntries(fileTree(rootDir).map((relative) => {
    const absolute = path.join(rootDir, relative.replace(/\/$/, ''));
    const stat = fs.statSync(absolute);
    return [relative, {
      type: relative.endsWith('/') ? 'directory' : 'file', size: stat.size, mtimeMs: stat.mtimeMs,
    }];
  }));
}

export function parseNdjson(text: string): any[] {
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function markerRecords(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n')
      .filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function markerPids(file: string): number[] {
  return markerRecords(file).flatMap(record => [record.pid, record.bash_pid])
    .filter((value): value is number => typeof value === 'number' && value > 0);
}

function processStat(pid: number): { state: string; group: number } | null {
  try {
    const value = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = value.slice(value.lastIndexOf(') ') + 2).split(' ');
    return { state: fields[0], group: Number(fields[2]) };
  } catch {
    return null;
  }
}

function processHasOwner(pid: number, owner: string): boolean {
  try {
    const environment = fs.readFileSync(`/proc/${pid}/environ`);
    return environment.includes(Buffer.from(`AGENT_RUN_E2E_OWNER=${owner}\0`));
  } catch {
    return false;
  }
}

function ownedProcessExists(pid: number, owner: string): boolean {
  const stat = processStat(pid);
  if (stat === null) return false;
  return stat.state === 'Z' || processHasOwner(pid, owner);
}

function ownerPids(owner: string): number[] {
  return fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))
    .map(Number).filter(pid => processHasOwner(pid, owner));
}

function snapshotRun(run: TrackedRun): OwnedRun {
  const owner = run.fixture.env.AGENT_RUN_E2E_OWNER!;
  const claudePids = markerPids(run.fixture.claudeMarker);
  const supervisorPids = markerPids(run.fixture.supervisorMarker);
  const pids = [run.child.pid, ...supervisorPids, ...claudePids, ...ownerPids(owner)]
    .filter((value): value is number => value !== undefined);
  return {
    child: run.child,
    owner,
    pids: [...new Set(pids)],
    groups: [...new Set([run.child.pid, claudePids[0]].filter(
      (value): value is number => value !== undefined,
    ))],
  };
}

function signalOwnedGroup(run: OwnedRun, group: number, signal: NodeJS.Signals): void {
  const hasMember = run.pids.some(pid =>
    ownedProcessExists(pid, run.owner) && processStat(pid)?.group === group);
  if (!hasMember) return;
  try {
    process.kill(-group, signal);
  } catch {}
}

function signalOwnedRun(run: OwnedRun, signal: NodeJS.Signals): void {
  for (const group of run.groups) signalOwnedGroup(run, group, signal);
  for (const pid of run.pids) {
    if (!ownedProcessExists(pid, run.owner)) continue;
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function processGroupExists(group: number): boolean {
  return fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))
    .map(Number).some(pid => processStat(pid)?.group === group);
}

async function waitForOwnedExit(run: OwnedRun): Promise<void> {
  const active = () => run.pids.some(pid => ownedProcessExists(pid, run.owner))
    || run.groups.some(processGroupExists);
  while (active()) await delay(5);
}

export async function cleanupRuns(): Promise<void> {
  const active = [...runs];
  const owned = active.map(snapshotRun);
  for (const run of owned) signalOwnedRun(run, 'SIGTERM');
  await Promise.all(active.map(run => waitForExit(run.child)));
  await Promise.all(owned.map(waitForOwnedExit));
  runs = runs.filter(run => !active.includes(run));
}

function forceCleanupRuns(): void {
  for (const run of runs.map(snapshotRun)) signalOwnedRun(run, 'SIGKILL');
}

function installWorkerCleanup(): void {
  process.on('exit', forceCleanupRuns);
  for (const signal of WORKER_SIGNALS) {
    const handler = () => {
      forceCleanupRuns();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function removeWorkerCleanup(): void {
  process.removeListener('exit', forceCleanupRuns);
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  signalHandlers.clear();
}

export function spawnRun(
  fixture: Fixture, env: NodeJS.ProcessEnv = {}, stdin?: string | Buffer,
  imports: string[] = [],
): ChildProcess {
  const importArgs = imports.flatMap(value => ['--import', value]);
  const child = spawn(process.execPath, [...importArgs, '--import', 'tsx', ENTRY, 'agent-run', ...fixture.args], {
    detached: true,
    env: { ...fixture.env, ...env }, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  runs.push({ child, fixture });
  if (stdin !== undefined) child.stdin!.end(stdin);
  return child;
}

export async function processOutput(child: ChildProcess): Promise<{ stdout: string; stderr: string }> {
  const stdout = collect(child.stdout!);
  const stderr = collect(child.stderr!);
  await waitForExit(child);
  return { stdout: await stdout, stderr: await stderr };
}

export function terminalPath(fixture: Fixture): string {
  return path.join(fixture.trajectoryRoot, 'run-e2e-run.terminal.json');
}

export function terminalRecord(fixture: Fixture): any {
  return JSON.parse(fs.readFileSync(terminalPath(fixture), 'utf8'));
}

export function bashPid(fixture: Fixture): number {
  const lines = fs.readFileSync(fixture.claudeMarker, 'utf8').trim().split('\n');
  return JSON.parse(lines.at(-1)!).bash_pid;
}
