// input:  supervisor client, fake fixture, child processes
// output: protocol, watchdog, shutdown, and taxonomy evidence
// pos:    Agent-run supervisor client regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import {
  SupervisorContainmentError,
  SupervisorProtocolError,
  attachSupervisor,
  exitCodeFor,
  parseSupervisorLine,
  type SupervisorSession,
} from '../../../src/domain/agent-run/supervisor.js';

const FIXTURE = fileURLToPath(new URL('./fake-supervisor.ts', import.meta.url));
const CHILD = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];
const sessions: SupervisorSession[] = [];
const releaseFiles = new Set<string>();
let root = '';
let launcher = '';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createLauncher(): string {
  const file = path.join(root, 'fake-supervisor');
  const script = `#!/bin/sh\nexec ${shellQuote(process.execPath)} --import tsx ${shellQuote(FIXTURE)} "$@"\n`;
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

function restoreEnvironment(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withEnvironment<T>(values: NodeJS.ProcessEnv, action: () => T): T {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return action();
  } finally {
    restoreEnvironment(previous);
  }
}

interface AttachFixtureOptions {
  graceMs?: number;
  deadlineMs?: number;
  controlFd?: number;
  errorReason?: 'unsupported_platform' | 'containment_failed';
  releaseFile?: string;
  signalFile?: string;
  argvFile?: string;
}

function attachFixture(
  mode: string,
  args: string[],
  options: AttachFixtureOptions = {},
): SupervisorSession {
  const environment: NodeJS.ProcessEnv = {
    FAKE_SUPERVISOR_MODE: mode,
    FAKE_SUPERVISOR_ERROR_REASON: options.errorReason,
    FAKE_SUPERVISOR_RELEASE_FILE: options.releaseFile,
    FAKE_SUPERVISOR_SIGNAL_FILE: options.signalFile,
    FAKE_SUPERVISOR_ARGV_FILE: options.argvFile,
  };
  const session = withEnvironment(environment, () => attachSupervisor({
    binary: launcher,
    args,
    graceMs: options.graceMs,
    deadlineMs: options.deadlineMs,
    controlFd: options.controlFd,
  }));
  sessions.push(session);
  return session;
}

async function capturedRejection<T>(promise: Promise<T>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  throw new Error('expected promise to reject');
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function attachMissingBinary(): SupervisorSession {
  const session = attachSupervisor({
    binary: path.join(root, 'missing-supervisor'),
    args: [process.execPath, '-e', 'process.exit(0)'],
  });
  sessions.push(session);
  return session;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`process ${pid} survived for ${timeoutMs}ms`);
}

function cleanupProcessGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // The process group already exited.
  }
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-supervisor-'));
  launcher = createLauncher();
});

afterEach(async () => {
  for (const file of releaseFiles) fs.writeFileSync(file, 'release');
  releaseFiles.clear();
  await Promise.allSettled(sessions.splice(0).map(session => session.dispose()));
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const PARSER_TIMESTAMP = '2026-07-31T01:02:03.004Z';
const VALID_RECORDS = [
  { v: 1, type: 'started', pid: 10, pgid: 10, ts: PARSER_TIMESTAMP },
  { v: 1, type: 'exited', code: 42, signal: null, ts: PARSER_TIMESTAMP },
  { v: 1, type: 'quiescent', descendants: 0, ts: PARSER_TIMESTAMP },
  { v: 1, type: 'error', reason: 'unsupported_platform', ts: PARSER_TIMESTAMP },
] as const;
const INVALID_RECORDS = [
  ['malformed JSON', '{not-json'],
  ['missing version', JSON.stringify({ type: 'quiescent', descendants: 0, ts: PARSER_TIMESTAMP })],
  ['unknown version', JSON.stringify({ v: 2, type: 'quiescent', descendants: 0, ts: PARSER_TIMESTAMP })],
  ['unknown type', JSON.stringify({ v: 1, type: 'unknown', ts: PARSER_TIMESTAMP })],
  ['invalid variant field', JSON.stringify({ v: 1, type: 'started', pid: '10', pgid: 10, ts: PARSER_TIMESTAMP })],
  ['nonzero descendants', JSON.stringify({ v: 1, type: 'quiescent', descendants: 1, ts: PARSER_TIMESTAMP })],
  ['invalid timestamp', JSON.stringify({ v: 1, type: 'quiescent', descendants: 0, ts: 'today' })],
  ['unknown field', JSON.stringify({ v: 1, type: 'quiescent', descendants: 0, ts: PARSER_TIMESTAMP, extra: true })],
];

describe('valid supervisor lines', () => {
  for (const record of VALID_RECORDS) {
    it(`accepts ${record.type} records`, () => {
      assert.deepEqual(parseSupervisorLine(JSON.stringify(record)), record);
    });
  }
});

describe('invalid supervisor lines', () => {
  for (const [label, line] of INVALID_RECORDS) {
    it(`rejects ${label} explicitly`, () => {
      assert.throws(() => parseSupervisorLine(line), error => {
        assert.ok(error instanceof SupervisorProtocolError);
        assert.equal(error.reason, 'containment_failure');
        assert.equal(error.detail, 'protocol_violation');
        return true;
      });
    });
  }
});

it('reads a clean protocol from a real control fd and child process', async () => {
  const session = attachFixture('clean', [process.execPath, '-e', 'process.exit(0)']);
  const started = await session.started;
  assert.ok(started.pid > 0);
  assert.equal(started.pgid, started.pid);
  assert.deepEqual(await session.exited, { code: 0, signal: null });
  await session.quiescent;
});

it('forwards control, grace, and deadline arguments to the supervisor', async () => {
  const argvFile = path.join(root, 'argv.json');
  const childArgs = [process.execPath, '-e', 'process.exit(0)'];
  const session = attachFixture('clean', childArgs, {
    controlFd: 5, graceMs: 17, deadlineMs: 9999, argvFile,
  });
  await session.quiescent;
  assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')), [
    '--control-fd', '5', '--grace-ms', '17', '--deadline-ms', '9999', '--', ...childArgs,
  ]);
});

it('rejects a supervisor that exits without quiescence', async () => {
  const session = attachFixture('no-quiescent', [process.execPath, '-e', 'process.exit(0)']);
  await session.started;
  assert.deepEqual(await session.exited, { code: 0, signal: null });
  const error = await capturedRejection(session.quiescent);
  assert.ok(error instanceof SupervisorContainmentError);
  assert.equal(error.detail, 'missing_quiescent');
});

for (const detail of ['unsupported_platform', 'containment_failed'] as const) {
  it(`keeps ${detail} errors distinguishable from clean completion`, async () => {
    const session = attachFixture('error', CHILD, { errorReason: detail });
    const started = capturedRejection(session.started);
    const exited = capturedRejection(session.exited);
    const quiescent = capturedRejection(session.quiescent);
    for (const error of await Promise.all([started, exited, quiescent])) {
      assert.ok(error instanceof SupervisorContainmentError);
      assert.equal(error.detail, detail);
      assert.equal(exitCodeFor(error.reason), 125);
    }
  });
}

it('fails the session when malformed data appears mid-stream', async () => {
  const session = attachFixture('malformed', CHILD);
  await session.started;
  const exited = capturedRejection(session.exited);
  const quiescent = capturedRejection(session.quiescent);
  for (const error of await Promise.all([exited, quiescent])) {
    assert.ok(error instanceof SupervisorProtocolError);
    assert.equal(error.reason, 'containment_failure');
    assert.equal(error.detail, 'protocol_violation');
    assert.equal(exitCodeFor(error.reason), 125);
  }
});

for (const mode of ['out-of-order', 'duplicate-started'] as const) {
  it(`rejects the ${mode} lifecycle sequence`, async () => {
    const session = attachFixture(mode, CHILD);
    const error = await capturedRejection(session.quiescent);
    assert.ok(error instanceof SupervisorProtocolError);
    assert.equal(error.reason, 'containment_failure');
    assert.equal(exitCodeFor(error.reason), 125);
  });
}

for (const mode of ['trailing-malformed', 'trailing-duplicate', 'trailing-error'] as const) {
  it(`rejects ${mode} after a quiescent record`, async () => {
    const session = attachFixture(mode, [process.execPath, '-e', 'process.exit(0)']);
    await session.started;
    await session.exited;
    const error = await capturedRejection(session.quiescent);
    if (mode !== 'trailing-error') assert.ok(error instanceof SupervisorProtocolError);
    else assert.ok(error instanceof SupervisorContainmentError);
    assert.equal(exitCodeFor(error.reason), 125);
  });
}

it('rejects a control fd that closes before the lifecycle is complete', async () => {
  const session = attachFixture('control-close', CHILD);
  await session.started;
  const error = await capturedRejection(session.quiescent);
  assert.ok(error instanceof SupervisorContainmentError);
  assert.equal(error.detail, 'missing_quiescent');
  assert.equal(exitCodeFor(error.reason), 125);
});

it('rejects spawn failure with a directly mappable containment reason', async () => {
  const session = attachMissingBinary();
  const error = await capturedRejection(session.quiescent);
  assert.ok(error instanceof SupervisorContainmentError);
  assert.equal(error.detail, 'spawn_failed');
  assert.equal(exitCodeFor(error.reason), 125);
});

it('backstops a hung supervisor by killing its live process group first', async () => {
  const session = attachFixture('hang', CHILD, { deadlineMs: 5000, graceMs: 0 });
  const attachedAt = Date.now();
  let pgid = 0;
  try {
    const started = await session.started;
    pgid = started.pgid;
    const error = await within(capturedRejection(session.quiescent), 14_000);
    assert.ok(error instanceof SupervisorContainmentError);
    assert.equal(error.detail, 'deadline_backstop_descendants_may_survive');
    assert.equal(exitCodeFor(error.reason), 125);
    assert.ok(Date.now() - attachedAt >= 9900);
    await within(session.dispose(), 2000);
    await waitForProcessExit(started.pid, 2000);
  } finally {
    if (pgid > 0) cleanupProcessGroup(pgid);
  }
}, 20_000);

for (const reason of ['cancel', 'deadline'] as const) {
  it(`latches ${reason} before signalling and waits for delayed quiescence`, async () => {
    const releaseFile = path.join(root, `${reason}-release`);
    const signalFile = path.join(root, `${reason}-signals`);
    releaseFiles.add(releaseFile);
    const session = attachFixture('hold-quiescent', CHILD, { releaseFile, signalFile });
    await session.started;
    let quiescentSettled = false;
    void session.quiescent.then(
      () => { quiescentSettled = true; },
      () => { quiescentSettled = true; },
    );
    session.cancel(reason);
    session.cancel(reason);
    await session.exited;
    assert.equal(quiescentSettled, false);
    assert.equal(fs.readFileSync(signalFile, 'utf8'), 'SIGTERM\n');
    fs.writeFileSync(releaseFile, 'release');
    await session.quiescent;
    assert.equal(quiescentSettled, true);
  });
}

it('maps terminal reasons to the pinned process exit taxonomy', () => {
  assert.equal(exitCodeFor('ok'), 0);
  assert.equal(exitCodeFor('child_failure', 42), 42);
  assert.equal(exitCodeFor('child_failure'), 1);
  assert.equal(exitCodeFor('child_failure', 0), 1);
  assert.equal(exitCodeFor('deadline'), 124);
  assert.equal(exitCodeFor('cancelled'), 130);
  assert.equal(exitCodeFor('containment_failure'), 125);
  assert.equal(exitCodeFor('trajectory_write_failed'), 74);
});
