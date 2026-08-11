// input:  standalone task store, trial policy limits, manager actions
// output: durable task-tree generation, verdict and finalization assertions
// pos:    Standalone manager task-tree state-machine regression suite
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'vitest';
import { StandaloneTaskStore } from '../../../src/domain/agent-run/standalone-stores.js';
import {
  createTrialTaskTreeCoordinator,
} from '../../../src/domain/benchmark/trial-task-tree-coordinator.js';
import { createTrialClock } from '../../../src/domain/benchmark/trial-clock.js';

const TRIAL = 'trial-tree';
const PROJECT = 'benchmark';
const NOW = Date.parse('2026-08-11T00:00:00.000Z');
let root = '';
let tasks: StandaloneTaskStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-task-tree-'));
  tasks = new StandaloneTaskStore(path.join(root, 'tasks.json'));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function coordinator(taskStore = tasks) {
  return createTrialTaskTreeCoordinator({
    trialId: TRIAL, project: PROJECT, root, tasks: taskStore,
    clock: createTrialClock({ deadlineEpochMs: NOW + 60_000, now: () => NOW }),
    limits: { maxTasks: 12, maxDepth: 4 },
    qaEnabled: true,
  });
}

it('decomposes with declared dependencies and admits only dependency-ready tasks', async () => {
  const tree = coordinator();
  const rootTask = await tree.initializeRoot({ text: 'root task', doneWhen: 'root done' });
  const rootAttempt = await tree.startAttempt(rootTask.id, 'manager');
  await assert.rejects(tree.decompose(rootAttempt.capability, [
    { key: 'orphan', text: 'orphan', doneWhen: 'done',
      template: 'benchmark-coder-review', dependsOn: ['missing'] },
  ]), /unknown local dependency/i);
  const children = await tree.decompose(rootAttempt.capability, [
    { key: 'build', text: 'build', doneWhen: 'built', template: 'benchmark-coder-review' },
    { key: 'verify', text: 'verify', doneWhen: 'verified',
      template: 'benchmark-coder-review', dependsOn: ['build'] },
  ]);
  await tree.wait(rootAttempt.capability);

  assert.equal(children.length, 2);
  assert.deepEqual(children[1].depends_on, [children[0].id]);
  assert.deepEqual(tree.actionable().map(task => task.id), [children[0].id]);
  await assert.rejects(tree.startAttempt(children[1].id, 'coder'), /not actionable/i);
  await assert.rejects(tree.startAttempt(children[0].id, 'manager'), /role does not match/i);
});

it('mints a fresh generation for rework and fences duplicate/stale settlement', async () => {
  const tree = coordinator();
  const rootTask = await tree.initializeRoot({ text: 'root', doneWhen: 'done' });
  const rootAttempt = await tree.startAttempt(rootTask.id, 'manager');
  const [child] = await tree.decompose(rootAttempt.capability, [
    { key: 'leaf', text: 'leaf', doneWhen: 'done', template: 'benchmark-coder-review' },
  ]);
  await tree.wait(rootAttempt.capability);

  const first = await tree.startAttempt(child.id, 'coder');
  await assert.rejects(tree.decompose(first.capability, [
    { key: 'escape', text: 'escape', doneWhen: 'done', template: 'benchmark-coder-review' },
  ]), /capability does not allow task\.decompose/i);
  assert.equal(await tree.finishAttempt(first.capability, {
    kind: 'complete', note: 'first', threadId: 'thread-first', quiescent: true,
    manifestCommitted: true,
  }), true);
  assert.equal(await tree.finishAttempt(first.capability, {
    kind: 'complete', note: 'duplicate', threadId: 'thread-first', quiescent: true,
    manifestCommitted: true,
  }), false);

  await tree.resumeReadyManagers();
  const resumed = await tree.startAttempt(rootTask.id, 'manager');
  await tree.recordVerdict(resumed.capability, child.id, 'rejected', 'needs rework');
  const second = await tree.startAttempt(child.id, 'coder');
  assert.notEqual(second.dispatchGeneration, first.dispatchGeneration);
  assert.equal(await tree.finishAttempt(first.capability, {
    kind: 'complete', note: 'stale', threadId: 'thread-stale', quiescent: true,
    manifestCommitted: true,
  }), false);
  assert.equal(tree.snapshot().acceptance[child.id]?.reworkRound, 1);
});

it('supports nested managers, acceptance, wait/resume, and strict root completion', async () => {
  const tree = coordinator();
  const rootTask = await tree.initializeRoot({ text: 'root', doneWhen: 'done' });
  const rootAttempt = await tree.startAttempt(rootTask.id, 'manager');
  const [nested] = await tree.decompose(rootAttempt.capability, [
    { key: 'nested', text: 'nested', doneWhen: 'nested done', template: 'benchmark-manager' },
  ]);
  await tree.wait(rootAttempt.capability);

  const nestedAttempt = await tree.startAttempt(nested.id, 'manager');
  const [leaf] = await tree.decompose(nestedAttempt.capability, [
    { key: 'leaf', text: 'leaf', doneWhen: 'leaf done', template: 'benchmark-coder-review' },
  ]);
  await tree.wait(nestedAttempt.capability);
  const leafAttempt = await tree.startAttempt(leaf.id, 'coder');
  await tree.finishAttempt(leafAttempt.capability, {
    kind: 'complete', note: 'leaf done', threadId: 'thread-leaf', quiescent: true,
    manifestCommitted: true,
  });
  assert.deepEqual(await tree.resumeReadyManagers(), [nested.id]);

  const nestedResume = await tree.startAttempt(nested.id, 'manager');
  await tree.recordVerdict(nestedResume.capability, leaf.id, 'accepted', 'verified');
  await tree.completeManager(nestedResume.capability, 'nested complete');
  assert.deepEqual(await tree.resumeReadyManagers(), [rootTask.id]);

  const rootResume = await tree.startAttempt(rootTask.id, 'manager');
  await assert.rejects(tree.completeManager(rootResume.capability, 'too early'), /pending verdict/i);
  await tree.recordVerdict(rootResume.capability, nested.id, 'accepted', 'verified');
  await tree.completeManager(rootResume.capability, 'root complete');
  const evidence = await tree.finalize('completed');
  assert.deepEqual(evidence, {
    terminal: 'completed', rootCompleted: true, descendantsQuiescent: true,
    liveCapabilities: 0, writer: null,
  });
});

it('durably fences duplicate dispatch and writers across coordinator instances', async () => {
  const first = coordinator();
  const rootTask = await first.initializeRoot({ text: 'root', doneWhen: 'done' });
  const secondStore = new StandaloneTaskStore(path.join(root, 'tasks.json'));
  const second = coordinator(secondStore);
  const rootAttempt = await first.startAttempt(rootTask.id, 'manager');
  const children = await first.decompose(rootAttempt.capability, [
    { key: 'one', text: 'one', doneWhen: 'done', template: 'benchmark-coder-review' },
    { key: 'two', text: 'two', doneWhen: 'done', template: 'benchmark-coder-review' },
  ]);
  await assert.rejects(second.startAttempt(rootTask.id, 'manager'), /not actionable/i);

  const firstChild = await first.startAttempt(children[0].id, 'coder');
  const secondChild = await second.startAttempt(children[1].id, 'coder');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = first.withWriter(firstChild.capability, () => gate);
  await Promise.resolve();
  await assert.rejects(
    second.withWriter(secondChild.capability, async () => {}),
    /workspace writer already held/i,
  );
  release();
  await held;

  const rehydratedStore = new StandaloneTaskStore(path.join(root, 'tasks.json'));
  const rehydrated = coordinator(rehydratedStore);
  assert.equal(rehydrated.snapshot().attempts.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(root, 'coordinator', 'task-tree.json'), 'utf8',
  )).attempts.length, 3);
});

it('serializes one workspace writer and releases it after failure', async () => {
  const tree = coordinator();
  const rootTask = await tree.initializeRoot({ text: 'root', doneWhen: 'done' });
  const rootAttempt = await tree.startAttempt(rootTask.id, 'manager');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = tree.withWriter(rootAttempt.capability, () => gate);
  await Promise.resolve();
  await assert.rejects(
    tree.withWriter(rootAttempt.capability, async () => {}), /workspace writer already held/i,
  );
  release();
  await first;
  assert.equal(tree.snapshot().writer, null);
});

it('rehydrates rotations, artifacts, acceptance, and pending work from the trial root', async () => {
  const first = coordinator();
  const rootTask = await first.initializeRoot({ text: 'root', doneWhen: 'done' });
  const attempt = await first.startAttempt(rootTask.id, 'manager');
  const [child] = await first.decompose(attempt.capability, [
    { key: 'leaf', text: 'leaf', doneWhen: 'done', template: 'benchmark-coder-review' },
  ]);
  await first.checkpointManager(attempt.capability, 'durable checkpoint');
  await first.wait(attempt.capability);
  await tasks.flush();

  const rehydrated = coordinator();
  assert.equal(rehydrated.snapshot().tasks.some(task => task.id === child.id), true);
  assert.equal(rehydrated.snapshot().managers[rootTask.id]?.artifact, 'durable checkpoint');
  assert.equal(rehydrated.snapshot().managers[rootTask.id]?.rotations, 1);
  assert.deepEqual(rehydrated.actionable().map(task => task.id), [child.id]);
});

it('cancels live attempts and refuses successful finalization without quiescent manifests', async () => {
  const tree = coordinator();
  const rootTask = await tree.initializeRoot({ text: 'root', doneWhen: 'done' });
  const attempt = await tree.startAttempt(rootTask.id, 'manager');
  assert.equal(await tree.finishAttempt(attempt.capability, {
    kind: 'complete', note: 'unsafe', threadId: 'thread-root', quiescent: false,
    manifestCommitted: false,
  }), false);
  await assert.rejects(tree.finalize('completed'), /root task is not complete/i);
  await tree.cancel('cancelled by test');
  const evidence = await tree.finalize('cancelled');
  assert.equal(evidence.terminal, 'cancelled');
  assert.equal(evidence.liveCapabilities, 0);
  assert.equal(evidence.writer, null);
});
