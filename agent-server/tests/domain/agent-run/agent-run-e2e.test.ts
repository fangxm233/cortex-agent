// input:  cortex CLI, stdin config, fake Claude accounting, procfs
// output: isolation, journal, accounting, and completion proofs
// pos:    Process-level one-shot agent-run regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../../../src/entry/cli.ts', import.meta.url));
const FAKE_SUPERVISOR = fileURLToPath(new URL('./fake-supervisor.ts', import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;
let root = '';
let children: ChildProcess[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-e2e-'));
  children = [];
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all(children.map(waitForExit));
  fs.rmSync(root, { recursive: true, force: true });
});

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

function installFailingWriteHook(file: string): void {
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

function installFakeClaude(binDir: string): void {
  writeExecutable(path.join(binDir, 'claude'), `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
appendFileSync(process.env.FAKE_CLAUDE_INVOCATIONS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.includes('--version')) {
  console.log(process.env.FAKE_CLAUDE_VERSION ?? 'fixture-claude 1.0.0');
  process.exit(0);
}
writeFileSync(process.env.FAKE_CLAUDE_MARKER, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
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
  const firstResult = process.env.FAKE_CLAUDE_FIRST_RESULT
    ? JSON.parse(process.env.FAKE_CLAUDE_FIRST_RESULT)
    : { type: 'result', subtype: 'success', is_error: false, session_id: request.session_id, result: 'first result', total_cost_usd: 0.25, num_turns: 1 };
  console.log(JSON.stringify(firstResult));
  child.once('close', () => {
    console.log(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed', summary: 'done' }));
    console.log(JSON.stringify({ type: 'assistant', message: { id: 'a2', model: 'claude-reported-fixture', content: [{ type: 'text', text: 'background done' }] } }));
    const continuationResult = process.env.FAKE_CLAUDE_CONTINUATION_RESULT
      ? JSON.parse(process.env.FAKE_CLAUDE_CONTINUATION_RESULT)
      : { type: 'result', subtype: 'success', origin: { kind: 'task-notification' }, is_error: false, session_id: request.session_id, result: 'background done', total_cost_usd: 0.1, num_turns: 1 };
    console.log(JSON.stringify(continuationResult));
  });
});
`);
}

function fakeClaudeResult(
  sessionId: string, result: string, additions: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    session_id: sessionId, result, num_turns: 1, ...additions,
  });
}

function writeProfile(file: string, extraOption: Record<string, string> = {}): void {
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

interface Fixture {
  home: string;
  cwd: string;
  trajectoryRoot: string;
  eventsFile: string;
  releaseMarker: string;
  backgroundMarker: string;
  bashCwdMarker: string;
  claudeMarker: string;
  claudeInvocationMarker: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function createFixture(name = 'run'): Fixture {
  const base = path.join(root, name);
  const home = path.join(base, 'seeded-home');
  const cwd = path.join(base, 'task-workspace');
  const binDir = path.join(base, 'bin');
  const profileFile = path.join(home, 'config', 'profiles.json');
  const runConfigFile = path.join(base, 'agent-run.json');
  const promptFile = path.join(base, 'prompt.txt');
  fs.mkdirSync(path.dirname(profileFile), { recursive: true });
  fs.mkdirSync(cwd);
  fs.mkdirSync(binDir);
  installFakeSupervisor(binDir);
  installFakeClaude(binDir);
  writeProfile(profileFile);
  writeRunConfig(runConfigFile);
  fs.writeFileSync(promptFile, 'finish the fixture\r\n');
  const trajectoryRoot = path.join(base, 'trajectory');
  fs.mkdirSync(trajectoryRoot);
  const fixture = {
    home, cwd, trajectoryRoot,
    eventsFile: path.join(trajectoryRoot, 'events.jsonl'),
    releaseMarker: path.join(base, 'release'),
    backgroundMarker: path.join(base, 'background-done'),
    bashCwdMarker: path.join(base, 'bash-cwd'),
    claudeMarker: path.join(base, 'claude.jsonl'),
    claudeInvocationMarker: path.join(base, 'claude-invocations.jsonl'),
    args: [] as string[], env: {} as NodeJS.ProcessEnv,
  };
  fixture.args = [
    '--prompt-file', promptFile, '--agent-slot', 'parent', '--profile', 'fixture',
    '--cwd', cwd, '--output-format', 'jsonl', '--events-file', fixture.eventsFile,
    '--run-config', runConfigFile,
    '--root-run-id', 'e2e-run', '--grace-ms', '50',
  ];
  fixture.env = {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    LANG: 'C',
    CORTEX_HOME: home,
    CORTEX_SUPERVISOR_BINARY: 'cortex-supervisor',
    CORTEX_PROJECTS_DIR: path.join(base, 'projects'),
    HOME: path.join(base, 'user-home'),
    XDG_CONFIG_HOME: path.join(base, 'xdg-config'),
    XDG_CACHE_HOME: path.join(base, 'xdg-cache'),
    CLAUDE_CONFIG_DIR: path.join(base, 'claude-config'),
    FAKE_SUPERVISOR_MODE: 'clean',
    FAKE_SUPERVISOR_FAILURE_FILE: path.join(base, 'supervisor-failure.txt'),
    FAKE_CLAUDE_MARKER: fixture.claudeMarker,
    FAKE_CLAUDE_INVOCATIONS: fixture.claudeInvocationMarker,
    BASH_CWD_MARKER: fixture.bashCwdMarker,
    BACKGROUND_MARKER: fixture.backgroundMarker,
    RELEASE_MARKER: fixture.releaseMarker,
  };
  return fixture;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('close', () => resolve()));
}

async function waitForFile(
  file: string, message: string, child?: ChildProcess, diagnostics?: () => string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(file)) {
    if (child?.exitCode !== null) throw new Error(`${message}: ${diagnostics?.() ?? ''}`);
    if (Date.now() >= deadline) throw new Error(`${message}: ${diagnostics?.() ?? ''}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitForText(file: string, text: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes(text)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for '${text}' in ${file}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function collect(stream: NodeJS.ReadableStream): Promise<string> {
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

function assertNoListeningSocket(pid: number): void {
  const processSockets = listeningSocketInodes(pid);
  const listeners = listeningInodes(pid);
  assert.deepEqual([...processSockets].filter(inode => listeners.has(inode)), []);
}

function processTree(pid: number): string[] {
  const result: string[] = [];
  const visit = (current: number) => {
    try {
      const cmdline = fs.readFileSync(`/proc/${current}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
      result.push(`${current}:${cmdline}`);
      const children = fs.readFileSync(`/proc/${current}/task/${current}/children`, 'utf8').trim();
      for (const child of children.split(/\s+/).filter(Boolean)) visit(Number(child));
    } catch {}
  };
  visit(pid);
  return result;
}

function fileTree(rootDir: string): string[] {
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

function snapshotTree(rootDir: string): Record<string, TreeStat> {
  return Object.fromEntries(fileTree(rootDir).map((relative) => {
    const absolute = path.join(rootDir, relative.replace(/\/$/, ''));
    const stat = fs.statSync(absolute);
    return [relative, {
      type: relative.endsWith('/') ? 'directory' : 'file',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }];
  }));
}

function parseNdjson(text: string): any[] {
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function spawnRun(
  fixture: Fixture, env: NodeJS.ProcessEnv = {}, stdin?: string | Buffer,
  imports: string[] = [],
): ChildProcess {
  const importArgs = imports.flatMap(value => ['--import', value]);
  const child = spawn(process.execPath, [...importArgs, '--import', 'tsx', ENTRY, 'agent-run', ...fixture.args], {
    env: { ...fixture.env, ...env }, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  if (stdin !== undefined) child.stdin!.end(stdin);
  return child;
}

async function processOutput(child: ChildProcess): Promise<{ stdout: string; stderr: string }> {
  const stdout = collect(child.stdout!);
  let stderrText = '';
  child.stderr!.on('data', chunk => { stderrText += chunk.toString(); });
  const stderr = collect(child.stderr!);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `run did not exit: ${stderrText}\nprocesses=${JSON.stringify(processTree(child.pid!))}`,
    )), 30_000);
  });
  try { await Promise.race([waitForExit(child), timeout]); }
  finally { clearTimeout(timer!); }
  return { stdout: await stdout, stderr: await stderr };
}

function terminalPath(fixture: Fixture): string {
  return path.join(fixture.trajectoryRoot, 'run-e2e-run.terminal.json');
}

function terminalRecord(fixture: Fixture): any {
  return JSON.parse(fs.readFileSync(terminalPath(fixture), 'utf8'));
}

function bashPid(fixture: Fixture): number {
  const lines = fs.readFileSync(fixture.claudeMarker, 'utf8').trim().split('\n');
  return JSON.parse(lines.at(-1)!).bash_pid;
}

it('runs one daemon-free contained turn through background quiescence', async () => {
  const fixture = createFixture();
  const homeBefore = snapshotTree(fixture.home);
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'agent-run', ...fixture.args], {
    env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const stdout = collect(child.stdout!);
  let stderrText = '';
  child.stderr!.on('data', chunk => { stderrText += chunk.toString(); });
  const stderr = collect(child.stderr!);
  const diagnostics = () => `${stderrText}\nhome=${JSON.stringify(fileTree(fixture.home))}`
    + `\nprocesses=${JSON.stringify(processTree(child.pid!))}`
    + `\nsupervisor=${fs.existsSync(fixture.env.FAKE_SUPERVISOR_FAILURE_FILE!)
      ? fs.readFileSync(fixture.env.FAKE_SUPERVISOR_FAILURE_FILE!, 'utf8') : ''}`;

  await waitForFile(fixture.claudeMarker, 'fake Claude did not start', child, diagnostics);
  await waitForFile(
    path.join(fixture.trajectoryRoot, 'run-e2e-run.started.json'),
    'started marker missing', child, diagnostics,
  );
  assertNoListeningSocket(child.pid!);
  assert.equal(
    processTree(child.pid!).some(line => /entry\/(?:app|daemon)\.(?:js|ts)/.test(line)),
    false,
    'agent-run must not start the app or daemon entry point',
  );
  assert.equal(child.exitCode, null, 'run exited before the background child was released');
  fs.writeFileSync(fixture.releaseMarker, 'release');
  await waitForExit(child);
  const stdoutText = await stdout;
  const stderrFinal = await stderr;

  assert.equal(child.exitCode, 0, `${stderrFinal}\nstdout=${stdoutText}\n${diagnostics()}`);
  assert.equal(fs.readFileSync(fixture.bashCwdMarker, 'utf8').trim(), fixture.cwd);
  assert.equal(JSON.parse(fs.readFileSync(fixture.claudeMarker, 'utf8').split('\n')[0]).cwd, fixture.cwd);
  assert.equal(fs.readFileSync(fixture.backgroundMarker, 'utf8').trim(), 'done');

  const homeAfter = snapshotTree(fixture.home);
  assert.deepEqual(homeAfter, homeBefore, 'agent-run must not mutate its minimally seeded home');
  assert.deepEqual(fileTree(fixture.trajectoryRoot), [
    'events.jsonl', // required append-only normalized event journal
    'run-e2e-run.started.json', // atomic evidence that the run began
    'run-e2e-run.terminal.json', // atomic terminal lifecycle truth
  ]);
  for (const forbidden of ['sessions.json', 'threads.json', 'executions.json', 'tasks', 'data']) {
    assert.equal(fs.existsSync(path.join(fixture.home, forbidden)), false, `${forbidden} must not exist`);
  }

  const journalText = fs.readFileSync(fixture.eventsFile, 'utf8');
  const records = parseNdjson(journalText);
  assert.equal(records[0].type, 'run_header');
  assert.equal(records[0].resolved_cwd, fixture.cwd);
  assert.equal(records[0].canonical_instruction_sha256, sha256('finish the fixture\r\n'));
  assert.equal(records[0].model_visible_prompt_sha256, sha256('finish the fixture\r\n'));
  assert.equal(records[0].system_prompt_sha256, sha256(''));
  assert.deepEqual(records.map(record => record.seq), records.map((_, index) => index));
  for (const record of records) {
    assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(record.model_execution_identity_hash, SHA256);
    assert.equal(record.model_execution_identity_hash, records[0].model_execution_identity_hash);
    assert.equal(record.role_tool_surface_hash, records[0].role_tool_surface_hash);
    assert.equal(record.bundle_manifest_hash, records[0].bundle_manifest_hash);
  }
  const assistantEvents = records.filter(record => record.event?.type === 'assistant_text');
  assert.ok(assistantEvents.length >= 2);
  assert.ok(assistantEvents.every(record => record.reported_model === 'claude-reported-fixture'));

  const terminal = terminalRecord(fixture);
  assert.equal(terminal.state, 'completed');
  assert.equal(terminal.terminal_reason, 'ok');
  assert.deepEqual(terminal.supervisor, { quiescent: true, descendants: 0 });
  assert.equal(terminal.event_count, records.length - 1);
  assert.equal(terminal.model_execution_identity_hash, records[0].model_execution_identity_hash);
  assert.equal(terminal.role_tool_surface_hash, records[0].role_tool_surface_hash);
  assert.equal(terminal.bundle_manifest_hash, records[0].bundle_manifest_hash);

  const stdoutLines = stdoutText.trimEnd().split('\n');
  const journalLines = journalText.trimEnd().split('\n');
  assert.deepEqual(stdoutLines.slice(0, journalLines.length), journalLines);
  const finalOutput = JSON.parse(stdoutLines.at(-1)!);
  assert.equal(finalOutput.type, 'terminal');
  assert.equal(finalOutput.ok, true);
  assert.equal(finalOutput.root_run_id, 'e2e-run');
  assert.deepEqual(finalOutput.manifest, terminal);
  assert.equal(finalOutput.terminal_reason, 'ok');

  fs.unlinkSync(fixture.claudeMarker);
  const retry = spawnRun(fixture);
  const retryOutput = await processOutput(retry);
  assert.equal(retry.exitCode, 74);
  assert.equal(parseNdjson(retryOutput.stdout).at(-1).terminal_reason, 'trajectory_write_failed');
  assert.equal(fs.existsSync(fixture.claudeMarker), false, 'retry must fail before spawning Claude');
  assert.deepEqual(snapshotTree(fixture.home), homeAfter);
}, 45_000);

it('ignores ambient background caps and journals the held continuation before success', async () => {
  const fixture = createFixture('ambient-background-cap');
  const child = spawnRun(fixture, {
    CORTEX_BG_WAIT_MAX_S: '0.05', CORTEX_BG_GRACE_S: '0.05',
  });
  await waitForText(fixture.eventsFile, 'turn_complete');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(child.exitCode, null, 'ambient wait caps must not release a one-shot run');
  assert.equal(fs.existsSync(terminalPath(fixture)), false, 'success cannot publish before continuation');
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  const records = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'));
  assert.ok(records.some(record => record.event?.type === 'assistant_text'
    && record.event.text === 'background done'));
  assert.equal(terminalRecord(fixture).terminal_reason, 'ok');
}, 45_000);

it('falls back to one when a signalled child has no exit code', async () => {
  const fixture = createFixture();
  const child = spawnRun(fixture, { FAKE_CLAUDE_MODE: 'signal' });
  const output = await processOutput(child);
  assert.equal(child.exitCode, 1, output.stderr);
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'child_failure');
  assert.equal(terminalRecord(fixture).state, 'failed');
}, 45_000);

it('preserves a supervised child failure exit code', async () => {
  const fixture = createFixture();
  const child = spawnRun(fixture, { FAKE_CLAUDE_MODE: 'fail' });
  const output = await processOutput(child);
  assert.equal(child.exitCode, 7, output.stderr);
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'child_failure');
  assert.equal(terminalRecord(fixture).state, 'failed');
  assert.equal(terminalRecord(fixture).terminal_reason, 'child_failure');
}, 45_000);

for (const code of [124, 125, 130]) {
  it(`keeps child exit ${code} classified as child_failure`, async () => {
    const fixture = createFixture(`child-${code}`);
    const child = spawnRun(fixture, {
      FAKE_CLAUDE_MODE: 'fail', FAKE_CLAUDE_EXIT_CODE: String(code),
    });
    const output = await processOutput(child);
    assert.equal(child.exitCode, code, output.stderr);
    assert.equal(terminalRecord(fixture).terminal_reason, 'child_failure');
  }, 45_000);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  it(`${signal} cancels the supervisor and waits for descendant quiescence`, async () => {
    const fixture = createFixture();
    const child = spawnRun(fixture);
    const stdout = collect(child.stdout!);
    const stderr = collect(child.stderr!);
    await waitForFile(fixture.bashCwdMarker, 'background Bash did not start', child);
    const descendant = bashPid(fixture);
    child.kill(signal);
    await waitForExit(child);
    assert.equal(child.exitCode, 130, await stderr);
    assert.equal(fs.existsSync(`/proc/${descendant}`), false);
    assert.equal(fs.existsSync(fixture.backgroundMarker), false);
    assert.equal(parseNdjson(await stdout).at(-1).terminal_reason, 'cancelled');
    assert.equal(terminalRecord(fixture).state, 'cancelled');
  }, 45_000);
}

it('a supervisor-owned deadline exits 124 after quiescence', async () => {
  const fixture = createFixture();
  fixture.args.push('--deadline-ms', '2000');
  const child = spawnRun(fixture);
  const output = await processOutput(child);
  assert.equal(child.exitCode, 124, output.stderr);
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'deadline');
  assert.equal(terminalRecord(fixture).state, 'timeout');
  assert.equal(terminalRecord(fixture).supervisor.quiescent, true);
}, 45_000);

for (const invalidProfile of ['pi', 'fallback'] as const) {
  it(`rejects a ${invalidProfile} profile before invoking Claude`, async () => {
    const fixture = createFixture(`profile-${invalidProfile}`);
    const entry = invalidProfile === 'pi'
      ? { model: 'pi-fixture', backend: 'pi', provider: 'anthropic', fallback: [] }
      : {
        model: 'claude-requested-fixture', backend: 'claude', provider: 'anthropic',
        fallback: [{ model: 'fallback-fixture', backend: 'claude' }],
      };
    fs.writeFileSync(path.join(fixture.home, 'config', 'profiles.json'), JSON.stringify({
      defaultProfile: 'fixture', profiles: { fixture: entry },
    }));
    const child = spawnRun(fixture);
    const output = await processOutput(child);
    assert.equal(child.exitCode, 1, output.stderr);
    assert.equal(fixture.env.CORTEX_HOME, fixture.home);
    assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'protocol_violation');
    assert.equal(fs.existsSync(fixture.claudeInvocationMarker), false);
    assert.equal(fs.existsSync(fixture.eventsFile), false);
  }, 45_000);
}

it('rejects an empty tool role before probing or spawning Claude', async () => {
  const fixture = createFixture('empty-role-tools');
  const configPath = fixture.args[fixture.args.indexOf('--run-config') + 1];
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.role.tools = [];
  fs.writeFileSync(configPath, JSON.stringify(config));
  const output = await processOutput(spawnRun(fixture));
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'protocol_violation');
  assert.equal(fs.existsSync(fixture.claudeInvocationMarker), false);
  assert.equal(fs.existsSync(fixture.eventsFile), false);
}, 45_000);

it('rejects profile argv extras before probing or spawning Claude', async () => {
  const fixture = createFixture('profile-extra-option');
  writeProfile(
    path.join(fixture.home, 'config', 'profiles.json'),
    { '--permission-mode': 'default' },
  );
  const output = await processOutput(spawnRun(fixture));
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'protocol_violation');
  assert.equal(fs.existsSync(fixture.claudeInvocationMarker), false);
  assert.equal(fs.existsSync(fixture.eventsFile), false);
}, 45_000);

it('fails closed before Claude when the supervisor binary is not executable', async () => {
  const fixture = createFixture();
  fixture.args.push('--supervisor-binary', path.join(root, 'missing-supervisor'));
  const child = spawnRun(fixture);
  const output = await processOutput(child);
  assert.equal(child.exitCode, 125, output.stderr);
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'containment_failure');
  assert.equal(fs.existsSync(fixture.claudeMarker), false);
  assert.equal(fs.existsSync(fixture.eventsFile), false);
}, 45_000);

for (const mode of ['error', 'no-quiescent', 'malformed'] as const) {
  it(`fails closed when supervisor mode ${mode} cannot prove quiescence`, async () => {
    const fixture = createFixture(mode);
    const child = spawnRun(fixture, {
      FAKE_SUPERVISOR_MODE: mode,
      FAKE_SUPERVISOR_ERROR_REASON: 'containment_failed',
    });
    if (mode === 'no-quiescent') {
      await waitForText(fixture.eventsFile, 'turn_complete');
      fs.writeFileSync(fixture.releaseMarker, 'release');
    }
    const output = await processOutput(child);
    assert.equal(child.exitCode, 125, output.stderr);
    assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'containment_failure');
    assert.equal(fs.existsSync(terminalPath(fixture)), false);
  }, 45_000);
}

it('runs with neutral defaults while treating agent-slot only as a journal label', async () => {
  const fixture = createFixture('neutral-defaults');
  const configIndex = fixture.args.indexOf('--run-config');
  fixture.args.splice(configIndex, 2);
  fixture.args[3] = 'benchmark-coder';
  const child = spawnRun(fixture);
  await waitForText(fixture.eventsFile, 'turn_complete');
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  const header = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'))[0];
  assert.equal(header.agent_slot, 'benchmark-coder');
}, 45_000);

it('journals compaction without reading or watching daemon settings', async () => {
  const fixture = createFixture('compact-isolation');
  const homeBefore = snapshotTree(fixture.home);
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const child = spawnRun(fixture, {
    FAKE_CLAUDE_COMPACT: '1', CORTEX_NOTIFY_COMPACTION: 'on',
  });
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  assert.doesNotMatch(output.stderr, /Deprecated env CORTEX_NOTIFY_COMPACTION/);
  assert.deepEqual(snapshotTree(fixture.home), homeBefore);
  const records = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'));
  assert.ok(records.some(record => record.event?.type === 'context_compacted'));
}, 45_000);

it('reads a stdin run config with relative paths based at the invoking cwd', async () => {
  const fixture = createFixture('stdin-run-config');
  const configIndex = fixture.args.indexOf('--run-config');
  const configPath = fixture.args[configIndex + 1];
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const mcpPath = path.join(path.dirname(configPath), 'mcp-config-empty.json');
  config.role.mcp_config_paths = [path.relative(process.cwd(), mcpPath)];
  fixture.args[configIndex + 1] = '-';
  const child = spawnRun(fixture, {}, JSON.stringify(config));
  await waitForText(fixture.eventsFile, 'turn_complete');
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  assert.equal(terminalRecord(fixture).terminal_reason, 'ok');
}, 45_000);

it('rejects two stdin file inputs before launching Claude', async () => {
  const fixture = createFixture('stdin-conflict');
  fixture.args[1] = '-';
  fixture.args[fixture.args.indexOf('--run-config') + 1] = '-';
  const child = spawnRun(fixture, {}, 'single stdin stream');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 1);
  assert.match(output.stderr, /Cannot use '-' for both --prompt-file and --run-config/);
  assert.match(output.stderr, /--prompt-file <path> with --run-config -/);
  assert.match(output.stderr, /--prompt-file - with --run-config <path>/);
  assert.equal(fs.existsSync(fixture.claudeMarker), false);
}, 45_000);

it('preserves raw stdin bytes while hashing the model-visible string', async () => {
  const fixture = createFixture();
  fixture.args[1] = '-';
  const promptCapture = path.join(root, 'prompt-capture.json');
  const prompt = Buffer.from([0x66, 0x80, 0x0a]);
  const modelVisible = prompt.toString('utf8');
  const child = spawnRun(fixture, { PROMPT_CAPTURE: promptCapture }, prompt);
  await waitForText(fixture.eventsFile, 'turn_complete');
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  const request = JSON.parse(fs.readFileSync(promptCapture, 'utf8'));
  assert.equal(request.message.content, modelVisible);
  const header = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'))[0];
  assert.equal(header.canonical_instruction_sha256, sha256(prompt));
  assert.equal(header.model_visible_prompt_sha256, sha256(modelVisible));
}, 45_000);

it('keeps unreported cost and usage null without fabricating cost records', async () => {
  const fixture = createFixture('unknown-accounting');
  const first = fakeClaudeResult('e2e-run', 'unknown');
  const continuation = fakeClaudeResult('e2e-run', 'unknown', {
    origin: { kind: 'task-notification' },
  });
  const child = spawnRun(fixture, {
    FAKE_CLAUDE_FIRST_RESULT: first,
    FAKE_CLAUDE_CONTINUATION_RESULT: continuation,
  });
  await waitForText(fixture.eventsFile, 'turn_complete');
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  const records = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'));
  assert.deepEqual(records.filter(record => record.event?.type === 'cost_record'), []);
  const terminal = terminalRecord(fixture);
  assert.equal(terminal.cost_usd, null);
  assert.deepEqual(terminal.tokens, { input: null, output: null });
}, 45_000);

it('preserves explicitly reported cost and usage exactly', async () => {
  const fixture = createFixture('reported-accounting');
  const reported = fakeClaudeResult('e2e-run', 'reported', {
    total_cost_usd: 0.375,
    usage: { input_tokens: 321, output_tokens: 54 },
    modelUsage: { 'claude-reported-accounting': {} },
  });
  const continuation = fakeClaudeResult('e2e-run', 'reported continuation', {
    origin: { kind: 'task-notification' }, total_cost_usd: 0.375,
  });
  const child = spawnRun(fixture, {
    FAKE_CLAUDE_FIRST_RESULT: reported,
    FAKE_CLAUDE_CONTINUATION_RESULT: continuation,
  });
  await waitForText(fixture.eventsFile, 'turn_complete');
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const output = await processOutput(child);
  assert.equal(child.exitCode, 0, output.stderr);
  const records = parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'));
  const costEvents = records.filter(record => record.event?.type === 'cost_record')
    .map(record => record.event);
  assert.deepEqual(costEvents, [{
    type: 'cost_record', provider: 'anthropic', model: 'claude-reported-accounting',
    tokens_in: 321, tokens_out: 54, cost_usd: 0.375,
  }]);
  const terminal = terminalRecord(fixture);
  assert.equal(terminal.cost_usd, 0.375);
  assert.deepEqual(terminal.tokens, { input: 321, output: 54 });
}, 45_000);

it('includes the probed Claude version in frozen model identity', async () => {
  const identities: string[] = [];
  for (const [name, version] of [['version-a', 'fixture-claude 1'], ['version-b', 'fixture-claude 2']]) {
    const fixture = createFixture(name);
    const child = spawnRun(fixture, { FAKE_CLAUDE_VERSION: version });
    await waitForText(fixture.eventsFile, 'turn_complete');
    fs.writeFileSync(fixture.releaseMarker, 'release');
    const output = await processOutput(child);
    assert.equal(parseNdjson(output.stdout).at(-1).ok, true);
    identities.push(parseNdjson(fs.readFileSync(fixture.eventsFile, 'utf8'))[0]
      .model_execution_identity_hash);
  }
  assert.notEqual(identities[0], identities[1]);
}, 45_000);

it('does not turn a closed diagnostics pipe into a trajectory failure', async () => {
  const fixture = createFixture();
  const child = spawnRun(fixture);
  child.stdout!.destroy();
  const stderr = collect(child.stderr!);
  await waitForText(fixture.eventsFile, 'turn_complete');
  fs.writeFileSync(fixture.releaseMarker, 'release');
  await waitForExit(child);
  assert.equal(child.exitCode, 0, await stderr);
  assert.equal(terminalRecord(fixture).terminal_reason, 'ok');
}, 45_000);

it('rejects an existing started marker before creating a journal or spawning Claude', async () => {
  const fixture = createFixture();
  const marker = path.join(fixture.trajectoryRoot, 'run-e2e-run.started.json');
  const original = '{"existing":true}\n';
  fs.writeFileSync(marker, original);
  const output = await processOutput(spawnRun(fixture));
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'trajectory_write_failed');
  assert.equal(fs.existsSync(fixture.eventsFile), false);
  assert.equal(fs.existsSync(fixture.claudeMarker), false);
  assert.equal(fs.readFileSync(marker, 'utf8'), original);
}, 45_000);

it('turns a required event write failure into trajectory_write_failed', async () => {
  const fixture = createFixture();
  fs.writeFileSync(fixture.releaseMarker, 'release');
  const hook = path.join(root, 'fail-write.mjs');
  installFailingWriteHook(hook);
  const child = spawnRun(fixture, { FAIL_WRITE_PATH: fixture.eventsFile }, undefined, [hook]);
  const output = await processOutput(child);
  assert.equal(child.exitCode, 74, output.stderr);
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'trajectory_write_failed');
  if (fs.existsSync(terminalPath(fixture))) {
    assert.equal(terminalRecord(fixture).state, 'failed');
    assert.equal(terminalRecord(fixture).terminal_reason, 'trajectory_write_failed');
  }
  assert.equal(
    fs.existsSync(terminalPath(fixture)) && terminalRecord(fixture).state === 'completed', false,
  );
}, 45_000);

it('fails a trajectory open without launching Claude or publishing completion', async () => {
  const fixture = createFixture();
  fs.chmodSync(fixture.trajectoryRoot, 0o500);
  const child = spawnRun(fixture);
  const output = await processOutput(child);
  fs.chmodSync(fixture.trajectoryRoot, 0o700);
  assert.equal(child.exitCode, 74, output.stderr);
  assert.equal(parseNdjson(output.stdout).at(-1).terminal_reason, 'trajectory_write_failed');
  assert.equal(fs.existsSync(fixture.claudeMarker), false);
  assert.equal(fs.existsSync(terminalPath(fixture)), false);
}, 45_000);
