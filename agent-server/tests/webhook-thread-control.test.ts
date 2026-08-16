// input:  thread-op webhook, thread store, detached runner
// output: control persistence plus root and descendant evidence tests
// pos:    Verifies thread control and production evidence injection
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll, beforeAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const detached = vi.hoisted(() => ({ runThreadDetached: vi.fn() }));
vi.mock('../src/orchestration/thread-executor.js', () => ({
  runThreadDetached: detached.runThreadDetached,
}));

import { CONFIG_DIR } from '../src/core/paths.js';
import { threadStore } from '../src/store/thread-repo.js';
import { loadConfig } from '../src/domain/threads/template-loader.js';
import { ctx as jobCtx } from '../src/domain/scheduling/job-registry.js';
import { createWebhookHandler } from '../src/orchestration/routing/webhook.js';
import type {
  ProductionBenchmarkEvidenceContext, ThreadRecord, ThreadStatus,
} from '../src/core/types/thread-types.js';

// The webhook now enforces a bearer token on all routes (except /webhook/github). Set one
// for these control-plane tests and send it on every request.
const WEBHOOK_TOKEN = 'test-thread-control-token';
process.env.CORTEX_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
const handler = createWebhookHandler();
const createdThreadIds = new Set<string>();
let seq = 0;

beforeAll(() => {
  const agentPath = path.join(
    CONFIG_DIR, 'thread-templates', 'agents', 'evidence-child-agent.json',
  );
  fs.mkdirSync(path.dirname(agentPath), { recursive: true });
  fs.writeFileSync(agentPath, JSON.stringify({
    name: 'evidence-child-agent', profile: '__active__', persistSession: false,
    directive: 'Test descendant evidence propagation', promptTemplate: '{{input}}',
  }));
  loadConfig();
  jobCtx.adapter = {
    postMessage: vi.fn().mockResolvedValue(null),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
});

afterAll(async () => {
  jobCtx.adapter = null;
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

test('native root start accepts one validated production evidence context', async () => {
  const evidence: ProductionBenchmarkEvidenceContext = {
    schema_version: 'cortex-production-benchmark-evidence-context/1',
    trial_id: 'trial-native-root', root_run_id: 'root-native-root',
    bundle_manifest_hash: 'e'.repeat(64),
    model_execution: {
      model_alias_policy: { policy: 'exact' }, cli_name: 'pi',
      cli_version: 'pi-fixture-1', max_output_tokens: 65_536,
    },
  };

  const { json } = await postThreadOp({
    action: 'start', agent: 'evidence-child-agent', message: 'root work',
    projectId: 'atlas', productionBenchmarkEvidenceContext: evidence,
  });

  assert.equal(json.success, true);
  const root = threadStore.get(json.data.threadId)!;
  createdThreadIds.add(root.id);
  assert.deepEqual(root.metadata?.productionBenchmarkEvidenceContext, evidence);
});

test('native root start refuses malformed production evidence before dispatch', async () => {
  const callsBefore = detached.runThreadDetached.mock.calls.length;
  const { json } = await postThreadOp({
    action: 'start', agent: 'evidence-child-agent', message: 'root work',
    productionBenchmarkEvidenceContext: { trial_id: 'unsealed' },
  });

  assert.equal(json.success, false);
  assert.match(json.error, /production benchmark evidence context invalid/i);
  assert.equal(detached.runThreadDetached.mock.calls.length, callsBefore);
});

test('native child start inherits parent evidence after thread-store reload', async () => {
  const evidence: ProductionBenchmarkEvidenceContext = {
    schema_version: 'cortex-production-benchmark-evidence-context/1',
    trial_id: 'trial-native-child',
    root_run_id: 'root-native-child',
    bundle_manifest_hash: 'e'.repeat(64),
    model_execution: {
      model_alias_policy: { policy: 'exact' },
      cli_name: 'claude',
      cli_version: 'claude-fixture-1',
      max_output_tokens: null,
    },
  };
  const parent = makeThread({
    projectId: 'atlas',
    metadata: { productionBenchmarkEvidenceContext: evidence },
  });
  await threadStore.flush();
  threadStore.load();

  const { json } = await postThreadOp({
    action: 'start', agent: 'evidence-child-agent', message: 'nested work',
    projectId: 'atlas', parentThreadId: parent.id, wait: false,
  });

  assert.equal(json.success, true);
  const child = threadStore.get(json.data.threadId)!;
  createdThreadIds.add(child.id);
  assert.equal(child.metadata?.parentThreadId, parent.id);
  assert.equal(child.metadata?.rootThreadId, parent.id);
  assert.deepEqual(child.metadata?.productionBenchmarkEvidenceContext, evidence);
  assert.equal(detached.runThreadDetached.mock.calls[0][0], child.id);
});

test('native child start refuses a missing persisted parent', async () => {
  const callsBefore = detached.runThreadDetached.mock.calls.length;
  const { json } = await postThreadOp({
    action: 'start', agent: 'evidence-child-agent', message: 'orphan work',
    projectId: 'atlas', parentThreadId: 'thr_missing_parent', wait: false,
  });

  assert.equal(json.success, false);
  assert.match(json.error, /parent thread.*missing|not found/i);
  assert.equal(detached.runThreadDetached.mock.calls.length, callsBefore);
});

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
