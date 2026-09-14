// input:  AgentRunner.route + manager-qa top-of-tree escalation + the gateway's delivery shapes
// output: regression tests — the DR-0016 human-answer backstop sits on the ONE entry every message
//         takes, and synthetic wake notices must NOT be consumed by it
// pos:    2026-07-05 bug: askManager (top of tree) armed the channel backstop, then the origin-session
//         wake routed the question notice through agentRunner.route, whose backstop check consumed
//         the notice itself as "the human's answer" — the question echoed back to the asker and never
//         reached the origin session or the human.
//         The check is armed by manager-qa through the `human-answer-backstop` leaf registry and
//         read in `AgentRunner._routeWithAdmission`, so EVERY entry passes it: an inbound platform
//         message, the web chat box (ui-service → deliverToSession), a resume, a callback. Phase 3
//         of plan/orchestration-turn-refactor.md briefly moved it up to `Orchestrator` — that lost
//         the web chat box, which is exactly the path the third test here pins down.

import '../_test-home.js'; // MUST be first — isolates store singletons
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { AgentRunner, type AgentRunnerCtx } from '../../src/orchestration/agent-runner.js';
import { Orchestrator, type OrchMessageContext } from '../../src/orchestration/orchestrator.js';
import { askManager, getAnswer, _testResetManagerQa } from '../../src/orchestration/manager-qa.js';
import { buildDeliveryMessage, deliverToSession } from '../../src/orchestration/session-gateway.js';
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

/** AgentRunner with the queue seam spied, so "was it short-circuited" is directly observable. */
function makeRunner() {
  const enqueued: string[] = [];
  const runner = new AgentRunner({ enqueue: (ch) => { enqueued.push(ch); return false; }, track: () => {} });
  return { runner, enqueued };
}

test('synthetic wake notice is NOT consumed as the human answer (proceeds to a normal agent turn)', async () => {
  _testResetManagerQa();
  const channel = `wg-ch-${seq++}`;
  const qid = await armTopOfTreeQuestion(channel);

  const { runner, enqueued } = makeRunner();

  // Exactly what the origin-session wake delivers for the escalation notice.
  const notice = buildDeliveryMessage({
    channel, text: '[Subtask question — #TOP1] Which reviewer strategy: A or B?',
    origin: 'subtask-question', tag: 'manager-qa',
  });
  await runner.route(routeCtx(channel, notice as unknown as Record<string, unknown>) as any);

  const got = getAnswer(qid);
  assert.equal(got.answered, false, 'the wake notice must not answer the question it delivers');
  assert.deepEqual(enqueued, [channel], 'the notice proceeds to normal turn handling (origin agent gets to read it)');
});

test('a real human reply on the armed channel IS consumed as the answer (backstop preserved)', async () => {
  _testResetManagerQa();
  const channel = `wg-ch-${seq++}`;
  const qid = await armTopOfTreeQuestion(channel);

  const { runner, enqueued } = makeRunner();

  await runner.route(routeCtx(channel, { text: 'Use strategy B.', senderId: 'U-human-1' }) as any);

  const got = getAnswer(qid);
  assert.equal(got.answered, true, 'human reply captured by the backstop');
  assert.equal(got.answer, 'Use strategy B.');
  assert.deepEqual(enqueued, [], 'consumed reply short-circuits normal turn handling');
});

test('a human answer typed in the WEB chat box is consumed too (deliverToSession → route)', async () => {
  _testResetManagerQa();
  const channel = `wg-web-${seq++}`;
  const qid = await armTopOfTreeQuestion(channel);

  const { runner, enqueued } = makeRunner();

  // The web path: ui-service hands the text to the gateway, which builds a `web-user` delivery and
  // routes it. The escalation channel really can be a `web:…` conduit — findEscalationChannel
  // returns the task's origin_channel, and a task dispatched from the web UI carries exactly that.
  await deliverToSession({
    channel, text: 'Use strategy B.', origin: 'web-user',
    adapter: new MockAdapter() as any,
    route: (ctx: AgentRunnerCtx) => runner.route(ctx),
  });

  const got = getAnswer(qid);
  assert.equal(got.answered, true, 'a web-typed reply is a human reply');
  assert.equal(got.answer, 'Use strategy B.');
  assert.deepEqual(enqueued, [], 'consumed reply short-circuits normal turn handling');
});

test('a message addressed to a live thread never reaches the agent entry (so never the backstop)', async () => {
  _testResetManagerQa();
  const channel = `wg-ch-${seq++}`;
  const qid = await armTopOfTreeQuestion(channel);

  // The backstop lives inside agentRunner.route; the thread branch routes elsewhere, so this is
  // an Orchestrator-level assertion — a message owned by a live thread never gets that far.
  const routed: string[] = [];
  const threaded: string[] = [];
  const orch = new Orchestrator({
    agentRunner: { async route(ctx: any) { routed.push(ctx.channel); } },
    threadExecutor: { async route(ctx: any) { threaded.push(ctx.channel); } },
  });
  const ctx = {
    ...routeCtx(channel, { text: 'Use strategy B.', senderId: 'U-human-1' }),
    threadAddMatch: null, threadStartMatch: null,
    existingThread: { id: 'thr-x' }, isActiveThread: true,
  } as unknown as OrchMessageContext;
  await orch.handleMessage(ctx);

  assert.deepEqual(threaded, [channel], 'the thread branch owns it');
  assert.deepEqual(routed, [], 'the agent entry (and its backstop) is never reached');
  assert.equal(getAnswer(qid).answered, false, 'a thread turn was never a candidate answer');
});

test('the wake shape carries the shared synthetic sender id (guard/shape stay in sync)', () => {
  const msg = buildDeliveryMessage({ channel: 'C-x', text: 'notice text', origin: 'task-callback', tag: 'tag1' });
  assert.equal(msg.text, 'notice text');
  assert.equal(msg.ref.conduit, 'C-x');
  assert.match(msg.ref.messageId, /tag1/);
  // The chat hint names what actually woke the session.
  assert.equal(msg.systemOrigin, 'task-callback');
  assert.equal(buildDeliveryMessage({ channel: 'C-x', text: 'n', origin: 'thread-callback', tag: 't' }).systemOrigin, 'thread-callback');
  assert.equal(buildDeliveryMessage({ channel: 'C-x', text: 'n', origin: 'subtask-question', tag: 't' }).systemOrigin, 'subtask-question');
});
