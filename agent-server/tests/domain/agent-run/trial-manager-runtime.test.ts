// input:  trial task tree and scripted fake-provider attempts
// output: nested manager, rework, cancellation and finalization assertions
// pos:    Standalone manager runtime integration regression suite
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'vitest';
import { StandaloneTaskStore } from '../../../src/domain/agent-run/standalone-stores.js';
import {
  createTrialManagerRuntime,
  type TrialManagerAttemptInput,
  type TrialManagerAttemptResult,
} from '../../../src/domain/agent-run/trial-manager-runtime.js';
import { createTrialClock } from '../../../src/domain/benchmark/trial-clock.js';
import {
  createTrialParentQuestionBridge,
} from '../../../src/domain/benchmark/trial-manager-qa.js';
import { createTrialTaskTreeCoordinator } from
  '../../../src/domain/benchmark/trial-task-tree-coordinator.js';

const NOW = Date.parse('2026-08-11T00:00:00.000Z');
let root = '';

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-runtime-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it('ships the one-step manager role and template consumed by production policy compilation', () => {
  const base = path.resolve('defaults/config/thread-templates');
  const agent = JSON.parse(fs.readFileSync(
    path.join(base, 'agents', 'benchmark-manager.json'), 'utf8',
  ));
  const template = JSON.parse(fs.readFileSync(
    path.join(base, 'templates', 'benchmark-manager.json'), 'utf8',
  ));
  assert.deepEqual(agent, {
    name: 'benchmark-manager',
    description: 'Standalone benchmark task-tree manager',
    profile: '__active__', persistSession: false,
    directive: 'file:benchmark-manager.md', systemPrompt: 'file:benchmark-manager.md',
    entryStage: 'manage',
    stages: { manage: {
      description: 'Advance one durable manager state-machine turn.',
      promptTemplate: '{{input}}',
    } },
    tools: 'Read,Write', mcpComposition: 'none',
  });
  assert.deepEqual(template, {
    name: 'benchmark-manager',
    description: 'One isolated standalone manager turn',
    agents: ['benchmark-manager'], transitions: [],
    entryAgent: 'benchmark-manager', entryStage: 'manage',
    maxTotalSteps: 1, disableHooks: true,
  });
  for (const directory of ['systemPrompts', 'directives']) {
    assert.equal(fs.existsSync(path.resolve(
      'defaults/prompts', directory, 'benchmark-manager.md',
    )), true);
  }
});

function completed(
  input: TrialManagerAttemptInput,
  summary: string,
): TrialManagerAttemptResult {
  return {
    taskId: input.task.id,
    threadId: `thread-${input.task.id}-${input.attemptOrdinal}`,
    state: 'completed', summary, manifestCommitted: true, quiescent: true,
    proposal: input.role === 'coder' ? { kind: 'complete', note: 'leaf complete' } : null,
  };
}

function harness(runAttempt: (input: TrialManagerAttemptInput) => Promise<TrialManagerAttemptResult>) {
  const tasks = new StandaloneTaskStore(path.join(root, 'tasks.json'));
  const clock = createTrialClock({ deadlineEpochMs: NOW + 120_000, now: () => NOW });
  const tree = createTrialTaskTreeCoordinator({
    trialId: 'trial-runtime', project: 'benchmark', root, tasks, clock,
    limits: { maxTasks: 12, maxDepth: 4 }, qaEnabled: true,
  });
  const parentQuestions = createTrialParentQuestionBridge({
    trialId: 'trial-runtime', root, clock, maxQuestions: 2,
  });
  return {
    tree,
    runtime: createTrialManagerRuntime({
      tree, parentQuestions, runAttempt, signal: new AbortController().signal,
      rootTask: { text: 'root manager task', doneWhen: 'all descendants accepted' },
    }),
  };
}

it('runs dependencies, rejection/rework, nested managers, acceptance, and root completion', async () => {
  const calls = new Map<string, number>();
  const generations = new Map<string, string[]>();
  const { runtime, tree } = harness(async (input) => {
    const count = (calls.get(input.task.text) ?? 0) + 1;
    calls.set(input.task.text, count);
    const seen = generations.get(input.task.text) ?? [];
    seen.push(input.capability.dispatch_generation);
    generations.set(input.task.text, seen);
    if (input.task.text === 'root manager task' && count === 1) {
      return completed(input, JSON.stringify({ actions: [{ type: 'decompose', subtasks: [
        { key: 'leaf', text: 'leaf', done_when: 'leaf done', template: 'benchmark-coder-review' },
        { key: 'nested', text: 'nested', done_when: 'nested done',
          template: 'benchmark-manager', depends_on: ['leaf'] },
      ] }, { type: 'wait' }] }));
    }
    if (input.task.text === 'root manager task' && count === 2) {
      const leaf = input.context.children.find(child => child.text === 'leaf')!;
      return completed(input, JSON.stringify({ actions: [
        { type: 'reject', task_id: leaf.id, note: 'rework once' }, { type: 'wait' },
      ] }));
    }
    if (input.task.text === 'root manager task' && count === 3) {
      const leaf = input.context.children.find(child => child.text === 'leaf')!;
      return completed(input, JSON.stringify({ actions: [
        { type: 'accept', task_id: leaf.id, note: 'accepted' }, { type: 'wait' },
      ] }));
    }
    if (input.task.text === 'nested' && count === 1) {
      return completed(input, JSON.stringify({ actions: [
        { type: 'ask', question: 'which nested path?' },
      ] }));
    }
    if (input.task.text === 'nested' && count === 2) {
      assert.equal(input.context.parentAnswer, 'use the verified path');
      return completed(input, JSON.stringify({ actions: [{ type: 'decompose', subtasks: [
        { key: 'nested-leaf', text: 'nested leaf', done_when: 'done',
          template: 'benchmark-coder-review' },
      ] }, { type: 'wait' }] }));
    }
    if (input.task.text === 'nested') {
      return completed(input, JSON.stringify({ actions: [
        { type: 'accept', task_id: input.context.children[0].id, note: 'accepted' },
        { type: 'complete', note: 'nested complete' },
      ] }));
    }
    if (input.task.text === 'root manager task' && input.context.pendingQuestions.length > 0) {
      return completed(input, JSON.stringify({ actions: [
        { type: 'answer', question_id: input.context.pendingQuestions[0].questionId,
          answer: 'use the verified path' },
        { type: 'wait' },
      ] }));
    }
    if (input.task.text === 'root manager task') {
      const nested = input.context.children.find(child => child.text === 'nested')!;
      return completed(input, JSON.stringify({ actions: [
        { type: 'accept', task_id: nested.id, note: 'accepted' },
        { type: 'complete', note: 'root complete' },
      ] }));
    }
    return completed(input, 'leaf implementation');
  });

  const result = await runtime.run();
  assert.equal(result.state, 'completed');
  assert.equal(result.finalization.rootCompleted, true);
  assert.equal(result.finalization.descendantsQuiescent, true);
  assert.equal(calls.get('leaf'), 2);
  assert.equal(calls.get('nested leaf'), 1);
  assert.equal(new Set(generations.get('leaf')).size, 2);
  assert.equal(tree.snapshot().tasks.every(task => task.status === 'done'), true);
  assert.equal(result.attempts.every(attempt => attempt.manifestCommitted && attempt.quiescent), true);
});

it('rehydrates a typed root question and resumes only after the matching answer', async () => {
  let turns = 0;
  const runAttempt = async (input: TrialManagerAttemptInput) => {
    turns += 1;
    if (turns === 1) {
      return completed(input, JSON.stringify({ actions: [
        { type: 'ask', question: 'choose A or B' },
      ] }));
    }
    assert.equal(input.context.parentAnswer, 'choose A');
    return completed(input, JSON.stringify({ actions: [
      { type: 'complete', note: 'answered root complete' },
    ] }));
  };
  const { runtime, tree } = harness(runAttempt);
  const pending = await runtime.run();
  assert.equal(pending.state, 'needs_parent_answer');
  assert.equal(pending.parentQuestion?.question, 'choose A or B');

  const clock = createTrialClock({ deadlineEpochMs: NOW + 120_000, now: () => NOW });
  const rehydrated = createTrialManagerRuntime({
    tree,
    parentQuestions: createTrialParentQuestionBridge({
      trialId: 'trial-runtime', root, clock, maxQuestions: 2,
    }),
    runAttempt, signal: new AbortController().signal,
    rootTask: { text: 'root manager task', doneWhen: 'all descendants accepted' },
  });
  const rehydratedPending = await rehydrated.run();
  assert.equal(rehydratedPending.state, 'needs_parent_answer');
  assert.equal(turns, 1);
  assert.deepEqual(rehydrated.answerParent({
    questionId: pending.parentQuestion!.questionId,
    attemptId: 'wrong-attempt', answer: 'wrong',
  }), { success: false, message: 'answer_stale' });
  assert.equal(rehydrated.answerParent({
    questionId: pending.parentQuestion!.questionId,
    attemptId: pending.parentQuestion!.attemptId, answer: 'choose A',
  }).success, true);
  const resumed = await rehydrated.run();
  assert.equal(resumed.state, 'completed');
});

it('cancels the active attempt and publishes no successful finalization', async () => {
  const controller = new AbortController();
  const tasks = new StandaloneTaskStore(path.join(root, 'tasks.json'));
  const clock = createTrialClock({ deadlineEpochMs: NOW + 120_000, now: () => NOW });
  const tree = createTrialTaskTreeCoordinator({
    trialId: 'trial-cancel', project: 'benchmark', root, tasks, clock,
    limits: { maxTasks: 4, maxDepth: 2 }, qaEnabled: false,
  });
  const parentQuestions = createTrialParentQuestionBridge({
    trialId: 'trial-cancel', root, clock, maxQuestions: 0,
  });
  const runtime = createTrialManagerRuntime({
    tree, parentQuestions, signal: controller.signal,
    rootTask: { text: 'cancel root', doneWhen: 'never' },
    runAttempt: input => new Promise(resolve => {
      input.signal.addEventListener('abort', () => resolve({
        taskId: input.task.id, threadId: 'thread-cancel', state: 'cancelled', summary: '',
        manifestCommitted: false, quiescent: true, proposal: null,
      }), { once: true });
    }),
  });
  const run = runtime.run();
  controller.abort();
  const result = await run;
  assert.equal(result.state, 'cancelled');
  assert.equal(result.finalization.rootCompleted, false);
  assert.equal(result.finalization.liveCapabilities, 0);
});

it('fails closed when an attempt lacks terminal durability or descendant quiescence', async () => {
  const { runtime } = harness(async input => ({
    taskId: input.task.id, threadId: 'thread-unsafe', state: 'completed', summary: '{}',
    manifestCommitted: false, quiescent: false, proposal: null,
  }));
  const result = await runtime.run();
  assert.equal(result.state, 'failed');
  assert.equal(result.finalization.rootCompleted, false);
  assert.equal(result.attempts[0].manifestCommitted, false);
  assert.equal(result.attempts[0].quiescent, false);
});
