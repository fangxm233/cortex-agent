// input:  trial-local thread/task projections and capability tokens
// output: nearest-manager and direct-parent Q&A lifecycle assertions
// pos:    Standalone manager Q&A routing regression suite
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'vitest';
import type { Task } from '../../../src/core/task-parser.js';
import type { ActorCapabilityMintRequest } from '../../../src/domain/benchmark/capabilities.js';
import { mintActorCapability } from '../../../src/domain/benchmark/capabilities.js';
import {
  ANSWER_STALE,
  createTrialManagerQaMailbox,
  createTrialParentQuestionBridge,
  type TrialQaThread,
  type TrialQaThreadStore,
} from '../../../src/domain/benchmark/trial-manager-qa.js';
import { createTrialClock } from '../../../src/domain/benchmark/trial-clock.js';

const TRIAL = 'trial-manager-qa';
const NOW = Date.parse('2026-08-11T00:00:00.000Z');
let root = '';

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-manager-qa-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function task(id: string, parent: string | null): Task {
  return {
    id, project: 'benchmark', text: id, why: '', done_when: '', priority: 'medium',
    status: 'open', template: 'benchmark-manager', plan: '', parent, depends_on: [], gpu: null,
    gpu_count: 0, blocked_by: null, claimed_by: null, claimed_at: null,
    dispatch_generation: `gen-${id}`, paused: false, approval_needed: false, approved_at: null,
    not_before: null, completed_at: null, completed_note: null, pending_at: null,
    origin_session_id: null, origin_channel: null, origin_thread_id: null,
  };
}

function capability(
  taskId: string,
  overrides: Partial<ActorCapabilityMintRequest> = {},
) {
  return mintActorCapability({
    trial_id: TRIAL, task_id: taskId, dispatch_generation: `gen-${taskId}`,
    attempt_id: `attempt-${taskId}`, role: 'manager', ancestry: [],
    capability_whitelist: ['qa.ask', 'qa.answer'], issued_at_epoch_ms: NOW, ...overrides,
  });
}

function thread(taskId: string, parentThreadId: string | null = null): TrialQaThread {
  return {
    id: `thread-${taskId}`, status: 'waiting', metadata: {
      taskId, parentThreadId, dispatchGeneration: `gen-${taskId}`,
      attemptId: `attempt-${taskId}`,
    },
  };
}

function threadStore(rows: TrialQaThread[]): TrialQaThreadStore {
  const values = new Map(rows.map(row => [row.id, row]));
  return {
    get: id => values.get(id) ?? null,
    getAll: () => [...values.values()],
    mutate: async (id, update) => {
      const value = values.get(id);
      if (value) update(value);
    },
  };
}

function mailbox(rows: Task[], threads: TrialQaThreadStore) {
  return createTrialManagerQaMailbox({
    trialId: TRIAL, root, threads,
    tasks: { getById: id => rows.find(row => row.id === id) ?? null },
    clock: createTrialClock({ deadlineEpochMs: NOW + 60_000, now: () => NOW }),
    isTerminalStatus: status => ['completed', 'failed', 'cancelled', 'aborted'].includes(status),
  });
}

it('refuses Q&A when the actor capability does not grant it', () => {
  const rows = [task('root', null), task('leaf', 'root')];
  const qa = mailbox(rows, threadStore([thread('root'), thread('leaf')]));
  const denied = capability('leaf', {
    capability_whitelist: ['task.read'], allowed_actions: ['task.read'],
  });
  assert.throws(() => qa.ask(denied, 'not admitted'), /qa_no_target/i);
});

it('routes a leaf and nested manager only to their direct live manager', async () => {
  const rows = [task('root', null), task('nested', 'root'), task('leaf', 'nested')];
  const threads = threadStore([thread('root'), thread('nested'), thread('leaf')]);
  const qa = mailbox(rows, threads);

  const leafQuestion = qa.ask(capability('leaf'), 'leaf question');
  await qa.deliver(leafQuestion.questionId);
  assert.equal(threads.get('thread-nested')?.metadata?.pendingQuestions?.[0]?.question,
    'leaf question');
  assert.equal(threads.get('thread-root')?.metadata?.pendingQuestions, undefined);

  const nestedQuestion = qa.ask(capability('nested'), 'nested question');
  await qa.deliver(nestedQuestion.questionId);
  assert.equal(threads.get('thread-root')?.metadata?.pendingQuestions?.[0]?.question,
    'nested question');
});

it('refuses stale, wrong-manager, wrong-generation, and duplicate answers', () => {
  const rows = [task('root', null), task('leaf', 'root')];
  const threads = threadStore([thread('root'), thread('leaf')]);
  const qa = mailbox(rows, threads);
  const { questionId } = qa.ask(capability('leaf'), 'which path?');

  assert.deepEqual(qa.answer(capability('leaf'), questionId, 'wrong'), {
    success: false, message: ANSWER_STALE,
  });
  assert.deepEqual(qa.answer(capability('root', {
    dispatch_generation: 'stale-generation',
  }), questionId, 'stale'), { success: false, message: ANSWER_STALE });
  assert.equal(qa.answer(capability('root'), questionId, 'use A').success, true);
  assert.deepEqual(qa.answer(capability('root'), questionId, 'use B'), {
    success: false, message: ANSWER_STALE,
  });
  assert.deepEqual(qa.poll(questionId), { found: true, answered: true, answer: 'use A' });
  assert.deepEqual(qa.poll(questionId), { found: false, answered: false, answer: null });
});

it('rehydrates durable manager questions without ambient state', async () => {
  const rows = [task('root', null), task('leaf', 'root')];
  const threads = threadStore([thread('root'), thread('leaf')]);
  const first = mailbox(rows, threads);
  const { questionId } = first.ask(capability('leaf'), 'persist me');
  await first.deliver(questionId);

  const rehydrated = mailbox(rows, threads);
  assert.equal(rehydrated.openQuestions(TRIAL)[0]?.questionId, questionId);
  assert.equal(rehydrated.openQuestions('other-trial').length, 0);
});

it('binds root questions to one typed direct-parent attempt and rejects stale answers', () => {
  const bridge = createTrialParentQuestionBridge({
    trialId: TRIAL, root,
    clock: createTrialClock({ deadlineEpochMs: NOW + 60_000, now: () => NOW }),
    maxQuestions: 2,
  });
  const rootCapability = capability('root');
  const question = bridge.record(rootCapability, 'root question');
  assert.deepEqual(bridge.resolveOuterCall(question.questionId), {
    questionId: question.questionId,
    attemptId: 'attempt-root',
    question: 'root question',
  });
  assert.deepEqual(bridge.accept({
    questionId: question.questionId, attemptId: 'wrong-attempt', answer: 'wrong',
  }), { success: false, message: ANSWER_STALE });
  assert.equal(bridge.accept({
    questionId: question.questionId, attemptId: 'attempt-root', answer: 'answer',
  }).success, true);
  assert.deepEqual(bridge.poll(question.questionId), {
    found: true, answered: true, answer: 'answer',
  });
  assert.deepEqual(bridge.accept({
    questionId: question.questionId, attemptId: 'attempt-root', answer: 'duplicate',
  }), { success: false, message: ANSWER_STALE });
});

it('invalidates unanswered root questions on cancellation', () => {
  const bridge = createTrialParentQuestionBridge({
    trialId: TRIAL, root,
    clock: createTrialClock({ deadlineEpochMs: NOW + 60_000, now: () => NOW }),
    maxQuestions: 1,
  });
  const question = bridge.record(capability('root'), 'cancel me');
  bridge.invalidate('attempt-root');
  assert.deepEqual(bridge.accept({
    questionId: question.questionId, attemptId: 'attempt-root', answer: 'late',
  }), { success: false, message: ANSWER_STALE });
});
