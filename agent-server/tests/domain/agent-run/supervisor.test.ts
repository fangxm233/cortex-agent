// input:  supervisor client, fake fixture, child processes
// output: protocol, shutdown-order, and exit-taxonomy evidence
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

describe('parseSupervisorLine', () => {
  const timestamp = '2026-07-31T01:02:03.004Z';
  const valid = [
    [{ v: 1, type: 'started', pid: 10, pgid: 10, ts: timestamp }],
    [{ v: 1, type: 'exited', code: 42, signal: null, ts: timestamp }],
    [{ v: 1, type: 'quiescent', descendants: 0, ts: timestamp }],
    [{ v: 1, type: 'error', reason: 'unsupported_platform', ts: timestamp }],
  ] as const;

  for (const [record] of valid) {
    it(`accepts ${record.type} records`, () => {
      assert.deepEqual(parseSupervisorLine(JSON.stringify(record)), record);
    });
  }

  const invalid = [
    ['malformed JSON', '{not-json'],
    ['missing version', JSON.stringify({ type: 'quiescent', descendants: 0, ts: timestamp })],
    ['unknown version', JSON.stringify({ v: 2, type: 'quiescent', descendants: 0, ts: timestamp })],
    ['unknown type', JSON.stringify({ v: 1, type: 'unknown', ts: timestamp })],
    ['invalid variant field', JSON.stringify({ v: 1, type: 'started', pid: '10', pgid: 10, ts: timestamp })],
    ['nonzero descendants', JSON.stringify({ v: 1, type: 'quiescent', descendants: 1, ts: timestamp })],
    ['invalid timestamp', JSON.stringify({ v: 1, type: 'quiescent', descendants: 0, ts: 'today' })],
    ['unknown field', JSON.stringify({ v: 1, type: 'quiescent', descendants: 0, ts: timestamp, extra: true })],
  ];

  for (const [label, line] of invalid) {
    it(`rejects ${label} explicitly`, () => {
      assert.throws(() => parseSupervisorLine(line), error => {
        assert.ok(error instanceof SupervisorProtocolError);
        assert.equal(error.reason, 'protocol_violation');
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
    assert.equal(error.reason, 'protocol_violation');
  }
});

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
  assert.equal(exitCodeFor('deadline'), 124);
  assert.equal(exitCodeFor('cancelled'), 130);
  assert.equal(exitCodeFor('containment_failure'), 125);
  const trajectoryWriteFailureCode = exitCodeFor('trajectory_write_failed');
  assert.equal(trajectoryWriteFailureCode, 74);
  for (const otherCode of [0, 1, 124, 125, 130]) {
    assert.notEqual(trajectoryWriteFailureCode, otherCode);
  }
});
