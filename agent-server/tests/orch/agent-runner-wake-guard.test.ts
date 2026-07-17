// input:  AgentRunner.route + manager-qa top-of-tree escalation + thread-callback wakeSession shape
// output: regression tests — synthetic wake notices must NOT be consumed by the human-answer backstop
// pos:    2026-07-05 bug: askManager (top of tree) armed the channel backstop, then wakeSession routed
//         the question notice through agentRunner.route, whose tryAnswerFromHuman consumed the notice
//         itself as "the human's answer" — the question echoed back to the asker and never reached
//         the origin session or the human.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // MUST be first — isolates store singletons
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/orchestration/agent-runner.js';
import { askManager, getAnswer, _testResetManagerQa } from '../../src/orchestration/manager-qa.js';
import { buildSyntheticWakeMessage } from '../../src/orchestration/thread-callback.js';
import { SYNTHETIC_CALLBACK_SENDER } from '../../src/platform/types.js';
import { threadStore } from '../../src/store/thread-repo.js';
import { MockAdapter } from '../../src/platform/testing.js';
import type { ThreadRecord, ThreadStatus } from '../../src/core/types/thread-types.js';

const createdThreadIds = new Set<string>();
let seq = 0;

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
});

function makeAskingThread(channel: string): ThreadRecord {
  const id = `thr_wg${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id, templateName: 'manager', status: 'running' as ThreadStatus, channel,
    projectId: 'general', platformThreadId: null, userMessage: 'x', userMessageTs: 'ts',
    workspacePath: '', artifactPath: '', agents: {}, activeAgent: 'main', activeStage: null,
    currentStepIndex: 0, steps: [], iterationCounts: {}, totalCostUsd: 0,
    createdAt: now, updatedAt: now, endedAt: null, error: null, abortReason: null,
    metadata: { taskId: 'TOP1', taskProject: 'proj', trigger: 'task-dispatch' },
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

/** Arm a top-of-tree escalation on `channel`: the asking thread's task has no parent, so
 *  askManager arms the human backstop and (noop here) wakes the origin session. */
async function armTopOfTreeQuestion(channel: string): Promise<string> {
  const asking = makeAskingThread(channel);
  const readTask = (_p: string | null, taskId: string) =>
    taskId === 'TOP1' ? { parent: null, origin_channel: channel } : null;
  const res = await askManager(asking.id, 'Which reviewer strategy: A or B?', {
    readTask,
    resume: () => { throw new Error('must not resume — no manager'); },
    wakeOriginSession: () => {},
  });
  assert.equal(res.ok, true, 'ask registered');
  return res.ok ? res.questionId : '';
}

function routeCtx(channel: string, message: Record<string, unknown>) {
  return {
    message: { ref: { conduit: channel, messageId: `M${seq++}` }, isBot: false, kind: 'user', raw: null, ...message },
    channel,
    adapter: new MockAdapter() as any,
    threadAnchorId: null,
    hasFiles: false,
    userMessage: String(message.text ?? ''),
    agentMessage: String(message.text ?? ''),
  };
}

test('synthetic wake notice is NOT consumed as the human answer (proceeds to a normal agent turn)', async () => {
  _testResetManagerQa();
  const channel = `wg-ch-${seq++}`;
  const qid = await armTopOfTreeQuestion(channel);

  const enqueued: string[] = [];
  const runner = new AgentRunner({ enqueue: (ch) => { enqueued.push(ch); return false; }, track: () => {} });

  // Exactly what wakeSession routes for the escalation notice.
  const notice = buildSyntheticWakeMessage(channel, '[Subtask question — #TOP1] Which reviewer strategy: A or B?', 'manager-qa');
  await runner.route(routeCtx(channel, notice as unknown as Record<string, unknown>) as any);

  const got = getAnswer(qid);
  assert.equal(got.answered, false, 'the wake notice must not answer the question it delivers');
  assert.deepEqual(enqueued, [channel], 'the notice proceeds to normal turn handling (origin agent gets to read it)');
});

test('a real human reply on the armed channel IS consumed as the answer (backstop preserved)', async () => {
  _testResetManagerQa();
  const channel = `wg-ch-${seq++}`;
  const qid = await armTopOfTreeQuestion(channel);

  const enqueued: string[] = [];
  const runner = new AgentRunner({ enqueue: (ch) => { enqueued.push(ch); return false; }, track: () => {} });

  await runner.route(routeCtx(channel, { text: 'Use strategy B.', senderId: 'U-human-1' }) as any);

  const got = getAnswer(qid);
  assert.equal(got.answered, true, 'human reply captured by the backstop');
  assert.equal(got.answer, 'Use strategy B.');
  assert.deepEqual(enqueued, [], 'consumed reply short-circuits normal turn handling');
});

test('buildSyntheticWakeMessage carries the shared synthetic sender id (guard/shape stay in sync)', () => {
  const msg = buildSyntheticWakeMessage('C-x', 'notice text', 'tag1');
  assert.equal(msg.senderId, SYNTHETIC_CALLBACK_SENDER);
  assert.equal(msg.text, 'notice text');
  assert.equal(msg.ref.conduit, 'C-x');
  assert.match(msg.ref.messageId, /tag1/);
});
