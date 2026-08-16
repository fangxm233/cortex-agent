// input:  teardown guard and atomic production evidence exporter
// output: fail-closed teardown and three publication cases
// pos:    Transport teardown and atomic publication coverage
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// Design §13 (13.6) T16, against §4.5 F1–F6 and §4.6's "no transport teardown may bypass
// finalization". The sidecar here is a real stdio MCP server process spawned by the backend from
// the role's own frozen `--mcp-config`, so killing it is a real transport teardown rather than a
// simulated one. Each row asserts the same closed finalization set — quiescence proven, journal
// closed and hashed, terminal manifest published and re-validated, no descendant left behind —
// because a teardown that skipped any one of them leaves exactly the orphan the contract bars.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, it } from 'vitest';
import {
  buildSupervisor, claudeTrial, installFakeSupervisor, processAlive,
  readJson, runTrial, terminalManifestFile, waitForFile,
} from './long-mcp-trial-fixture.js';
import {
  createProductionBoundaryFixture, withPublishedProductionBoundary,
} from './production-evidence-boundary-fixture.js';

let root = '';

beforeAll(buildSupervisor, 120_000);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-teardown-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

it('fails closed when the control stream ends without a quiescent record (T16, §4.5)', async () => {
  // Ruling R2(b). "Reaches strict finalization" includes reaching the FAILURE terminal correctly:
  // a teardown whose supervisor never proves quiescence must publish no manifest at all rather than
  // a success over an unproven tree (`supervisor.ts:273-277` → `runner.ts:714`). Everything else in
  // this file proves the success terminal, which on its own would leave the fail-closed branch of
  // teardown untested.
  const trial = claudeTrial(root, {
    hold: { holdMs: 60_000, name: 'no-quiescent' }, deadlineSeconds: 600,
  });
  trial.options.supervisorBinary = installFakeSupervisor(root, 'no-quiescent');
  const run = runTrial(trial);
  await waitForFile(trial.server.startedFile);
  const sidecar = readJson(trial.server.pidFile) as { pid: number; pgid: number };
  process.kill(sidecar.pid, 'SIGKILL');

  const outcome = await run;
  assert.equal(outcome.terminal.state, 'failed');
  assert.equal(outcome.terminal.terminal_reason, 'containment_failure');
  assert.equal(outcome.terminal.manifest, null, 'a manifest was published without proven quiescence');
  assert.notEqual(outcome.exitCode, 0);
  // F6 is withheld too: no terminal manifest reaches disk, so no downstream reader can mistake this
  // run for a finalized one.
  assert.equal(fs.existsSync(terminalManifestFile(trial)), false);
  assert.equal(processAlive(sidecar.pid), false);
}, 115_000);

it('production evidence publication leaves no staging transport behind', async () => {
  await withPublishedProductionBoundary({}, (published) => {
    const parent = path.dirname(published.outputDirectory);
    assert.equal(fs.readdirSync(parent).some(name => name.includes('.staging-')), false);
  });
});

it('production evidence fails closed when a journal link disappears', async () => {
  const fixture = createProductionBoundaryFixture();
  try {
    fixture.sources.getJournal = () => null;
    await assert.rejects(fixture.publish(), /journal/i);
    assert.equal(fs.existsSync(fixture.input.outputDirectory), false);
  } finally {
    fixture.cleanup();
  }
});

it('production evidence never overwrites an existing publication', async () => {
  const fixture = createProductionBoundaryFixture();
  try {
    fs.mkdirSync(fixture.input.outputDirectory);
    fs.writeFileSync(path.join(fixture.input.outputDirectory, 'owner'), 'first');
    await assert.rejects(fixture.publish(), /exists/i);
    assert.equal(fs.readFileSync(path.join(fixture.input.outputDirectory, 'owner'), 'utf8'), 'first');
  } finally {
    fixture.cleanup();
  }
});
