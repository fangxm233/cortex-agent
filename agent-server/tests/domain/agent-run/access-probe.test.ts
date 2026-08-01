// input:  real strace, pinned launcher, controlled Node fixtures
// output: clean/negative verdicts and loud capability failures
// pos:    Process-level access-probe regression suite
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, it } from 'vitest';
import {
  formatAccessProbeSummary,
  runNodeAccessProbe,
  type AccessProbeVerdict,
} from '../../../src/domain/agent-run/access-probe.js';

const ENTRY = fileURLToPath(new URL('./access-probe-fixture.mjs', import.meta.url));
const INSTALL_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'access-probe-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function runFixture(mode: string): Promise<AccessProbeVerdict> {
  const workspace = path.join(root, 'workspace');
  const trialRoot = path.join(root, 'trial');
  const hostHome = path.join(root, 'host-home');
  const hostCortexHome = path.join(hostHome, '.cortex');
  const hostPath = path.join(hostCortexHome, 'data/probe-fixture.txt');
  fs.mkdirSync(workspace);
  fs.mkdirSync(hostCortexHome, { recursive: true });
  return runNodeAccessProbe({
    trialRoot,
    workspaceCwd: workspace,
    entry: ENTRY,
    args: [mode, path.join(trialRoot, 'logs'), hostPath],
    parentEnv: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    installRoot: INSTALL_ROOT,
    hostHome,
    hostCortexHome,
    timeoutMs: 15_000,
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
    });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.failureReason, 'ptrace_unavailable');
});
