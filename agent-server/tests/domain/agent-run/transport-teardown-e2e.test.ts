// input:  a supervised trial whose declared MCP sidecar dies, or outlives, its call
// output: proof that no transport teardown shortens agent-run's ordered finalization
// pos:    Independent Gate-2 proving suite for design §13 (13.6) T16
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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
import { validateTrajectoryLifecycle } from '../../../src/domain/agent-run/manifest.js';
import {
  buildSupervisor, claudeTrial, journalRecords, processAlive, readJson, runTrial,
  terminalManifestFile, waitForExit, waitForFile,
  type ClaudeTrial, type TrialOutcome,
} from './long-mcp-trial-fixture.js';

let root = '';

beforeAll(buildSupervisor, 120_000);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-teardown-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * §4.5 F2/F4/F6 as one predicate, because they are only meaningful together: a manifest whose
 * journal digest was taken before the journal closed, or a digest published by a run that never
 * proved quiescence, is not evidence of anything.
 */
function assertFinalized(trial: ClaudeTrial, outcome: TrialOutcome): void {
  // F2 — quiescence is proven, and `terminalManifest` withholds the manifest when it is not.
  assert.notEqual(outcome.terminal.manifest, null, 'no terminal manifest was published');
  assert.equal(outcome.terminal.manifest.supervisor.quiescent, true);

  // F4 — the journal is closed and its digest and event count are the ones the manifest carries.
  const records = journalRecords(trial);
  assert.ok(records.length > 0, 'the journal holds no records');
  assert.equal(outcome.terminal.manifest.event_count, records.length - 1);

  // F6 — the manifest is on disk, re-readable, and identical to the one reported on stdout.
  const manifestFile = terminalManifestFile(trial);
  assert.equal(fs.existsSync(manifestFile), true, `no terminal manifest at ${manifestFile}`);
  assert.deepEqual(readJson(manifestFile), outcome.terminal.manifest);

  // The shipped lifecycle validator re-scans the journal against the published manifest, which is
  // the same read-back F6 requires before a manifest counts as published.
  assert.deepEqual(validateTrajectoryLifecycle({
    trajectoryRoot: trial.options.trajectoryRoot,
    rootRunId: trial.rootRunId,
    threadId: null,
  }), { ok: true, problems: [] });
}

it('finalizes the trial after the MCP sidecar is killed mid-call (T16, §4.5 F1-F6)', async () => {
  const trial = claudeTrial(root, {
    hold: { holdMs: 60_000, name: 'killed' }, deadlineSeconds: 600,
  });
  const run = runTrial(trial);
  // Kill only once the call is genuinely in flight, so the teardown lands mid-request rather than
  // before the server ever answered `tools/list`.
  await waitForFile(trial.server.startedFile);
  const sidecarPid = readJson(trial.server.pidFile).pid as number;
  process.kill(sidecarPid, 'SIGKILL');

  const outcome = await run;
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  assert.equal(outcome.terminal.state, 'completed');
  // The kill really interrupted the call: the backend saw its request fail, not a held answer.
  assert.equal(readJson(trial.mcpResult).ok, false);
  assertFinalized(trial, outcome);
  assert.equal(processAlive(sidecarPid), false);
}, 115_000);

it('keeps finalization intact when the sidecar exits non-zero mid-call (T16, §4.6)', async () => {
  // The shipped sidecar's own failure path is `process.exit(1)` (benchmark-thread-server.ts). Under
  // §4.6 that is harmless because the tree is not in that process; this row asserts the harmlessness
  // rather than assuming it.
  const trial = claudeTrial(root, {
    hold: { holdMs: 60_000, exitAfterMs: 400, exitCode: 1, name: 'self-exit' },
    deadlineSeconds: 600,
  });
  const outcome = await runTrial(trial);
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  assert.equal(outcome.terminal.state, 'completed');
  assert.equal(readJson(trial.mcpResult).ok, false);
  assertFinalized(trial, outcome);
  await waitForExit(readJson(trial.server.pidFile).pid as number);
}, 115_000);

it('reaps a sidecar still holding its call when the turn ends (T16, §4.6)', async () => {
  // The opposite teardown: the backend abandons the call and exits while the sidecar is still
  // holding. Nothing in the transport can settle this one — only the containment boundary can, and
  // a run that returned before it did would publish a manifest over a live descendant.
  const trial = claudeTrial(root, {
    hold: { holdMs: 90_000, name: 'orphan' }, deadlineSeconds: 600, detachMcp: true,
  });
  const run = runTrial(trial);
  await waitForFile(trial.server.startedFile);
  const sidecarPid = readJson(trial.server.pidFile).pid as number;

  const outcome = await run;
  assert.equal(outcome.exitCode, 0, `${outcome.stderr}\n${JSON.stringify(outcome.terminal)}`);
  assert.equal(outcome.terminal.state, 'completed');
  assertFinalized(trial, outcome);
  // The hold had 90 s to run and the run returned long before that, so a live pid here is an
  // escaped descendant rather than a slow one.
  assert.equal(
    processAlive(sidecarPid), false,
    `sidecar ${sidecarPid} outlived the trial that declared it`,
  );
}, 115_000);
