// input:  strace, native supervisor, Node fixtures
// output: isolation, evidence, and containment proofs
// pos:    Process-level access-probe regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, it } from 'vitest';
import {
  formatAccessProbeSummary,
  runNodeAccessProbe,
  type AccessProbeVerdict,
} from '../../../src/domain/agent-run/access-probe.js';

const ENTRY = fileURLToPath(new URL('./access-probe-fixture.mjs', import.meta.url));
const INSTALL_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SUPERVISOR = fileURLToPath(
  new URL('../../../native/cortex-supervisor/dist/cortex-supervisor', import.meta.url),
);
let root = '';

beforeAll(() => {
  const result = spawnSync('flock', [
    '-x', '/tmp/cortex-supervisor-build.lock', 'npm', 'run', 'build:supervisor',
  ], { cwd: INSTALL_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'access-probe-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface FixtureRunOptions {
  timeoutMs?: number;
  trialRoot?: string;
}

async function runFixture(
  mode: string, options: FixtureRunOptions = {},
): Promise<AccessProbeVerdict> {
  const workspace = path.join(root, 'workspace');
  const trialRoot = options.trialRoot ?? path.join(root, 'trial');
  const hostHome = path.join(root, 'host-home');
  const hostCortexHome = path.join(hostHome, '.cortex');
  const hostPath = path.join(hostCortexHome, 'data/probe-fixture.txt');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.dirname(hostPath), { recursive: true });
  if (mode === 'ephemeral-symlink') fs.writeFileSync(hostPath, 'secret');
  return runNodeAccessProbe({
    trialRoot, workspaceCwd: workspace, entry: ENTRY,
    args: [mode, path.join(trialRoot, 'logs'), hostPath],
    parentEnv: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    installRoot: INSTALL_ROOT, hostHome, hostCortexHome,
    supervisorBinary: SUPERVISOR,
    timeoutMs: options.timeoutMs ?? 15_000,
  });
}

function offender(verdict: AccessProbeVerdict, syscall: string, reason?: string) {
  return verdict.violations.find(item => item.syscall === syscall
    && (reason === undefined || item.reason === reason));
}

it('returns ok for a fixture confined to C8 allowed roots', async () => {
    const verdict = await runFixture('clean');

    assert.equal(verdict.failureReason, undefined, formatAccessProbeSummary(verdict));
    assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.ok, true);
  assert.ok(verdict.counts.fileCalls > 0);
}, 20_000);

it('detects a deliberate write below host ~/.cortex and names its path', async () => {
    const verdict = await runFixture('host-write');
    const violation = offender(verdict, 'openat', 'host_cortex_path');

    assert.equal(verdict.ok, false);
    assert.ok(violation, formatAccessProbeSummary(verdict));
  assert.match(violation.path, /host-home\/\.cortex\/data\/probe-fixture\.txt$/);
  assert.equal(violation.reason, 'host_cortex_path');
}, 20_000);

it('detects a deliberate listen syscall', async () => {
    const verdict = await runFixture('listen');
    const violation = offender(verdict, 'listen');

    assert.equal(verdict.ok, false);
  assert.ok(violation, formatAccessProbeSummary(verdict));
  assert.match(violation.path, /127\.0\.0\.1:\d+/);
}, 20_000);

it('detects a deliberate connect syscall even when the connection fails', async () => {
    const verdict = await runFixture('connect');
    const violation = offender(verdict, 'connect');

    assert.equal(verdict.ok, false);
  assert.ok(violation, formatAccessProbeSummary(verdict));
  assert.equal(violation.path, '127.0.0.1:9');
}, 20_000);

it('detects host access through a symlink removed before probe exit', async () => {
  const verdict = await runFixture('ephemeral-symlink');
  const violation = offender(verdict, 'newfstatat', 'host_cortex_path')
    ?? offender(verdict, 'statx', 'host_cortex_path');

  assert.equal(verdict.ok, false);
  assert.ok(violation, formatAccessProbeSummary(verdict));
  assert.match(violation.path, /host-home\/\.cortex\/data\/probe-fixture\.txt$/);
}, 20_000);

it('does not ingest stale evidence when reusing a trial root', async () => {
  const trialRoot = path.join(root, 'reused-trial');
  const denied = await runFixture('host-write', { trialRoot });
  const clean = await runFixture('clean', { trialRoot });

  assert.equal(denied.ok, false);
  assert.equal(clean.ok, true, formatAccessProbeSummary(clean));
  assert.deepEqual(clean.violations, []);
}, 30_000);

it('detects a host write after the target tampers with visible trace files', async () => {
  const verdict = await runFixture('trace-tamper');
  const violation = offender(verdict, 'openat', 'host_cortex_path');

  assert.equal(verdict.ok, false);
  assert.ok(violation, formatAccessProbeSummary(verdict));
  assert.match(violation.path, /host-home\/\.cortex\/data\/probe-fixture\.txt$/);
}, 20_000);

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}

it('kills a detached setsid descendant when the probe times out', async () => {
  const verdict = await runFixture('detached-timeout', { timeoutMs: 5_000 });
  const pidPath = path.join(root, 'workspace/descendant.pid');
  const pid = Number(fs.readFileSync(pidPath, 'utf8'));
  const exited = await waitForProcessExit(pid, 3_000);
  if (!exited) process.kill(pid, 'SIGKILL');

  assert.equal(verdict.failureReason, 'probe_timeout');
  assert.equal(exited, true, `detached tracee survived probe timeout: ${pid}`);
}, 15_000);

it('fails loudly when strace is unavailable', async () => {
    const verdict = await runNodeAccessProbe({
      trialRoot: path.join(root, 'trial'),
      workspaceCwd: root,
      entry: ENTRY,
      args: ['clean', path.join(root, 'trial/logs'), 'unused'],
      installRoot: INSTALL_ROOT,
      hostHome: path.join(root, 'host'),
      hostCortexHome: path.join(root, 'host/.cortex'),
      stracePath: path.join(root, 'missing-strace'),
      supervisorBinary: SUPERVISOR,
    });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.failureReason, 'strace_unavailable');
});

it('fails loudly when ptrace is unavailable', async () => {
    const fakeStrace = path.join(root, 'ptrace-denied');
    fs.writeFileSync(fakeStrace,
      '#!/bin/sh\necho "strace: ptrace(PTRACE_TRACEME): Operation not permitted" >&2\nexit 1\n',
      { mode: 0o755 });
    const verdict = await runNodeAccessProbe({
      trialRoot: path.join(root, 'trial'),
      workspaceCwd: root,
      entry: ENTRY,
      args: ['clean', path.join(root, 'trial/logs'), 'unused'],
      installRoot: INSTALL_ROOT,
      hostHome: path.join(root, 'host'),
      hostCortexHome: path.join(root, 'host/.cortex'),
      stracePath: fakeStrace,
      supervisorBinary: SUPERVISOR,
    });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.failureReason, 'ptrace_unavailable');
});
