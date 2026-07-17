// input:  Node test runner + webhook /webhook/manager-qa (ask/poll/answer) + thread-repo
// output: ask/poll/answer HTTP entry-point validation (DR-0016 up-ask channel)
// pos:    Verify the synchronous ask_manager / answer_subtask webhook bridge end to end
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { threadStore } from '../src/store/thread-repo.js';
import { createWebhookHandler } from '../src/orchestration/routing/webhook.js';
import { _testResetManagerQa } from '../src/orchestration/manager-qa.js';
import type { ThreadRecord, ThreadStatus } from '../src/core/types/thread-types.js';

const WEBHOOK_TOKEN = 'test-manager-qa-token';
process.env.CORTEX_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
const handler = createWebhookHandler();
const createdThreadIds = new Set<string>();
let seq = 0;

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
});

function makeThread(over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = over.id ?? `thr_wqa${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id, templateName: null, status: 'running' as ThreadStatus,
    channel: 'C-wqa', projectId: 'general', platformThreadId: null,
    userMessage: 'x', userMessageTs: 'ts', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'main', activeStage: null, currentStepIndex: 0,
    steps: [], iterationCounts: {}, totalCostUsd: 0,
    createdAt: now, updatedAt: now, endedAt: null, error: null, abortReason: null, metadata: null,
    ...over,
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

function postQa(body: any): Promise<{ statusCode: number; json: any }> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as any;
    req.method = 'POST';
    req.url = '/webhook/manager-qa';
    req.headers = { 'x-cortex-token': WEBHOOK_TOKEN };
    let statusCode = 200;
    let payload = '';
    const res: any = {
      writeHead: (code: number) => { statusCode = code; },
      end: (chunk?: string) => {
        if (chunk) payload += chunk;
        let json: any = null;
        try { json = JSON.parse(payload); } catch {}
        resolve({ statusCode, json });
      },
    };
    handler(req, res);
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
}

test('ask → poll → answer round-trips through the webhook (thread-parent path)', async () => {
  _testResetManagerQa();
  const manager = makeThread({ status: 'waiting', metadata: { taskId: 'm-task' } });
  const child = makeThread({ status: 'running', metadata: { parentThreadId: manager.id } });

  const ask = await postQa({ action: 'ask', threadId: child.id, question: 'Approach A or B?' });
  assert.equal(ask.json.success, true);
  assert.equal(ask.json.data.target, 'manager');
  const qid = ask.json.data.questionId;
  assert.ok(qid);
  const m = threadStore.get(manager.id)!;
  assert.equal(m.metadata!.pendingMessages!.length, 1);
  assert.match(m.metadata!.pendingMessages![0], /Approach A or B/);

  const pollBefore = await postQa({ action: 'poll', questionId: qid });
  assert.equal(pollBefore.json.success, true);
  assert.equal(pollBefore.json.data.answered, false);

  const ans = await postQa({ action: 'answer', question_id: qid, answer: 'Use A.' });
  assert.equal(ans.json.success, true);

  const pollAfter = await postQa({ action: 'poll', questionId: qid });
  assert.equal(pollAfter.json.success, true);
  assert.equal(pollAfter.json.data.answered, true);
  assert.equal(pollAfter.json.data.answer, 'Use A.');
});

test('ask on an unknown thread id fails cleanly', async () => {
  _testResetManagerQa();
  const ask = await postQa({ action: 'ask', threadId: 'thr_nope_' + Date.now(), question: 'q' });
  assert.equal(ask.json.success, false);
  assert.match(ask.json.error, /not found/i);
});

test('answer on an unknown question id fails cleanly', async () => {
  _testResetManagerQa();
  const ans = await postQa({ action: 'answer', question_id: 'q_nope', answer: 'x' });
  assert.equal(ans.json.success, false);
  assert.match(ans.json.error, /unknown|expired/i);
});

test('manager-qa rejects an unknown action', async () => {
  _testResetManagerQa();
  const r = await postQa({ action: 'frobnicate' });
  assert.equal(r.json.success, false);
  assert.match(r.json.error, /unknown action/i);
});
