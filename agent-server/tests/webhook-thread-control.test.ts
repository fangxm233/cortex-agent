// input:  Node test runner + webhook /webhook/thread-op `control` action + thread-repo
// output: control action validation + pendingControl persistence tests (DR-0015 problem 1)
// pos:    Verify the out-of-band control plane HTTP entry point (thread_abort/split/wait → webhook)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { threadStore } from '../src/store/thread-repo.js';
import { createWebhookHandler } from '../src/orchestration/routing/webhook.js';
import type { ThreadRecord, ThreadStatus } from '../src/core/types/thread-types.js';

// The webhook now enforces a bearer token on all routes (except /webhook/github). Set one
// for these control-plane tests and send it on every request.
const WEBHOOK_TOKEN = 'test-thread-control-token';
process.env.CORTEX_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
const handler = createWebhookHandler();
const createdThreadIds = new Set<string>();
let seq = 0;

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
});

function makeThread(over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = over.id ?? `thr_ctl${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id, templateName: null, status: 'running' as ThreadStatus,
    channel: 'C-ctl', projectId: 'general', platformThreadId: null,
    userMessage: 'x', userMessageTs: 'ts', workspacePath: '', artifactPath: '',
    agents: {}, activeAgent: 'main', activeStage: null, currentStepIndex: 2,
    steps: [], iterationCounts: {}, totalCostUsd: 0,
    createdAt: now, updatedAt: now, endedAt: null, error: null, abortReason: null, metadata: null,
    ...over,
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

/** Drive createWebhookHandler with a POST to /webhook/thread-op and resolve the parsed reply. */
function postThreadOp(body: any): Promise<{ statusCode: number; json: any }> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as any;
    req.method = 'POST';
    req.url = '/webhook/thread-op';
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

test('control abort writes pendingControl with kind + diagnosis and returns an ack', async () => {
  const t = makeThread();
  const { json } = await postThreadOp({ action: 'control', threadId: t.id, control: { action: 'abort', kind: 'too-big', diagnosis: 'three units' } });
  assert.equal(json.success, true);
  assert.equal(json.data.action, 'abort');
  assert.equal(json.data.requestedAtStep, 2, 'snapshots currentStepIndex');
  const pc = threadStore.get(t.id)!.metadata!.pendingControl!;
  assert.equal(pc.action, 'abort');
  assert.equal(pc.kind, 'too-big');
  assert.equal(pc.diagnosis, 'three units');
});

test('control split writes the typed subtasks array', async () => {
  const t = makeThread();
  const subtasks = [{ key: 'a', text: 'A' }, { key: 'b', text: 'B', depends_on: ['a'] }];
  const { json } = await postThreadOp({ action: 'control', threadId: t.id, control: { action: 'split', subtasks } });
  assert.equal(json.success, true);
  const pc = threadStore.get(t.id)!.metadata!.pendingControl!;
  assert.equal(pc.action, 'split');
  assert.equal(pc.subtasks!.length, 2);
});

test('control wait writes optional on_tasks / on_threads hints', async () => {
  const t = makeThread();
  const { json } = await postThreadOp({ action: 'control', threadId: t.id, control: { action: 'wait', on_tasks: ['aaaa'], on_threads: ['thr_z'] } });
  assert.equal(json.success, true);
  const pc = threadStore.get(t.id)!.metadata!.pendingControl!;
  assert.equal(pc.action, 'wait');
  assert.deepEqual(pc.onTasks, ['aaaa']);
  assert.deepEqual(pc.onThreads, ['thr_z']);
});

test('control rejects a second concurrent control on the same thread', async () => {
  const t = makeThread();
  const first = await postThreadOp({ action: 'control', threadId: t.id, control: { action: 'abort', kind: 'mis-scoped', diagnosis: 'x' } });
  assert.equal(first.json.success, true);
  const second = await postThreadOp({ action: 'control', threadId: t.id, control: { action: 'wait' } });
  assert.equal(second.json.success, false);
  assert.match(second.json.error, /already has a pending/);
  // The original signal is untouched.
  assert.equal(threadStore.get(t.id)!.metadata!.pendingControl!.action, 'abort');
});

test('control rejects a terminal thread', async () => {
  const t = makeThread({ status: 'completed' });
  const { json } = await postThreadOp({ action: 'control', threadId: t.id, control: { action: 'abort', kind: 'too-big', diagnosis: 'x' } });
  assert.equal(json.success, false);
  assert.match(json.error, /terminal/);
  assert.equal(threadStore.get(t.id)!.metadata?.pendingControl ?? null, null);
});

test('control rejects an unknown thread id', async () => {
  const { json } = await postThreadOp({ action: 'control', threadId: 'thr_nope_' + Date.now(), control: { action: 'abort', kind: 'too-big', diagnosis: 'x' } });
  assert.equal(json.success, false);
  assert.match(json.error, /not found/);
});

test('control rejects an unknown control action', async () => {
  const t = makeThread();
  const { json } = await postThreadOp({ action: 'control', threadId: t.id, control: { action: 'frobnicate' } });
  assert.equal(json.success, false);
  assert.match(json.error, /unknown control action/);
  assert.equal(threadStore.get(t.id)!.metadata?.pendingControl ?? null, null);
});

test('control rejects a missing control payload', async () => {
  const t = makeThread();
  const { json } = await postThreadOp({ action: 'control', threadId: t.id });
  assert.equal(json.success, false);
  assert.match(json.error, /requires threadId and control.action/);
});
