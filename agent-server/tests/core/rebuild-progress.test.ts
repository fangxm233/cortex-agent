import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  finishRebuildStep,
  planRebuildProgress,
  readRebuildProgress,
  settleRebuildProgress,
  startRebuildStep,
  writeRebuildProgress,
  type RebuildProgress,
} from '../../src/core/rebuild-progress.js';

// The progress file is passed explicitly here (the functions take it) so these cases touch a temp
// dir and never the store — one less reason for a unit test to depend on an isolated home.
const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-rebuild-progress-'));
  dirs.push(dir);
  return path.join(dir, 'daemon-rebuild.json');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A clock that advances a second per read, so ordering assertions do not depend on wall time. */
function fakeClock(startMs = Date.parse('2026-09-21T06:00:00.000Z')) {
  let ms = startMs;
  return () => { const at = new Date(ms); ms += 1000; return at; };
}

function plan(names: RebuildProgress['steps'][number]['name'][] = ['server', 'web', 'install', 'restart']) {
  return planRebuildProgress({ reason: 'src change: core/foo.ts', names, daemonPid: 4242, now: fakeClock() });
}

test('a planned pipeline publishes every step up front so a reader knows the total', () => {
  const progress = plan();
  assert.equal(progress.status, 'running');
  assert.equal(progress.current, null);
  assert.equal(progress.daemonPid, 4242);
  assert.deepEqual(progress.steps.map((s) => [s.name, s.status]), [
    ['server', 'pending'], ['web', 'pending'], ['install', 'pending'], ['restart', 'pending'],
  ]);
});

test('starting and finishing a step moves only that step and tracks what is in flight', () => {
  const clock = fakeClock();
  const started = startRebuildStep(plan(), 'server', clock);
  assert.equal(started.current, 'server');
  assert.equal(started.steps[0].status, 'running');
  assert.ok(started.steps[0].startedAt);
  assert.equal(started.steps[1].status, 'pending', 'the next step must not be touched');

  const done = finishRebuildStep(started, 'server', 'done', null, clock);
  assert.equal(done.current, null, 'nothing is in flight between two steps');
  assert.equal(done.steps[0].status, 'done');
  assert.ok(done.steps[0].endedAt);
});

test('an install step carries which path ran, because the two cost very different time', () => {
  const clock = fakeClock();
  const fast = finishRebuildStep(startRebuildStep(plan(), 'install', clock), 'install', 'done', 'fast', clock);
  assert.equal(fast.steps[2].detail, 'fast');
});

test('settling abandons pending steps instead of leaving them looking queued', () => {
  const clock = fakeClock();
  const failed = finishRebuildStep(startRebuildStep(plan(), 'server', clock), 'server', 'failed', 'exit 2', clock);
  const settled = settleRebuildProgress(failed, 'aborted', 'Rebuild aborted at step "server" (exit 2)', clock);

  assert.equal(settled.status, 'aborted');
  assert.equal(settled.current, null);
  assert.ok(settled.endedAt);
  assert.equal(settled.detail, 'Rebuild aborted at step "server" (exit 2)');
  assert.deepEqual(settled.steps.map((s) => s.status), ['failed', 'skipped', 'skipped', 'skipped']);
});

test('a record survives a write/read round trip', () => {
  const file = tmpFile();
  const progress = startRebuildStep(plan(), 'web');
  assert.equal(writeRebuildProgress(progress, file), true);
  assert.deepEqual(readRebuildProgress(file), progress);
});

test('a missing or unreadable record reads as "no rebuild", never as a throw', () => {
  const file = tmpFile();
  assert.equal(readRebuildProgress(file), null, 'no file yet');

  writeFileSync(file, '{"status":"running"', 'utf8');
  assert.equal(readRebuildProgress(file), null, 'truncated JSON');

  writeFileSync(file, '{"status":"running","reason":"x"}', 'utf8');
  assert.equal(readRebuildProgress(file), null, 'JSON without the step plan is not a record');
});
