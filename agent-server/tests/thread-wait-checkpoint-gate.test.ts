// input:  Node test runner + state-machine artifact-hash baseline + webhook control gate
// output: checkpoint-gate tests — baseline recording (createThread / recordStepResult) +
//         isArtifactUnchangedSinceStepStart + webhook wait rejection/acceptance
// pos:    Verify DR-0017 W2: thread_wait is rejected unless the artifact was edited this
//         step (turn-level edit detection; hash-based, mtime-proof). abort/split unaffected.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DEFAULTS_DIR, CONFIG_DIR } from '../src/core/paths.js';
import { threadStore } from '../src/store/thread-repo.js';
import { createWebhookHandler } from '../src/orchestration/routing/webhook.js';
import {
  createThread,
  recordStepResult,
  isArtifactUnchangedSinceStepStart,
  loadConfig,
  mergeThreadTemplates,
} from '../src/domain/threads/index.js';
import type { ThreadRecord, ThreadStatus } from '../src/core/types/thread-types.js';

const WEBHOOK_TOKEN = 'test-checkpoint-gate-token';
process.env.CORTEX_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
const handler = createWebhookHandler();
const createdThreadIds = new Set<string>();
let seq = 0;

beforeAll(() => {
  mergeThreadTemplates(
    path.join(DEFAULTS_DIR, 'config', 'thread-templates'),
    path.join(CONFIG_DIR, 'thread-templates'),
  );
  loadConfig();
});

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
});

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function makeRealThread(): ThreadRecord {
  const t = createThread('C-ckpt', {
    templateName: 'coder-review',
    userMessage: 'x',
    userMessageTs: `ts_${seq++}`,
  });
  createdThreadIds.add(t.id);
  return t;
}

function makeBareThread(over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = `thr_ck${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id, templateName: null, status: 'running' as ThreadStatus,
    channel: 'C-ckpt', projectId: 'general', platformThreadId: null,
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

// --- baseline recording ---

test('createThread records the initial artifact hash as the step-start baseline', () => {
  const t = makeRealThread();
  assert.equal(t.metadata?.stepStartArtifactHash, sha256(''), 'fresh workspace artifact is empty');
});

test('recordStepResult refreshes the baseline to the post-step artifact state', async () => {
  const t = makeRealThread();
  fs.writeFileSync(t.artifactPath, '## Plan v1');
  await recordStepResult(t.id, 'coder', { output: 'done', costUsd: 0, numTurns: 1, durationS: 1 });
  assert.equal(threadStore.get(t.id)!.metadata?.stepStartArtifactHash, sha256('## Plan v1'),
    'next step starts against the artifact as this step left it');
});

// --- isArtifactUnchangedSinceStepStart ---

test('unchanged artifact since baseline → true; edited → false', () => {
  const t = makeRealThread();
  assert.equal(isArtifactUnchangedSinceStepStart(t.id), true);
  fs.writeFileSync(t.artifactPath, '## Checkpoint\ndelegations...');
  assert.equal(isArtifactUnchangedSinceStepStart(t.id), false);
});

test('fail-open cases: no artifactPath / no baseline → false (never blocks)', () => {
  const noArtifact = makeBareThread({ artifactPath: '' });
  assert.equal(isArtifactUnchangedSinceStepStart(noArtifact.id), false);
  const noBaseline = makeBareThread({ artifactPath: '/tmp/nonexistent-ckpt-artifact.md', metadata: {} });
  assert.equal(isArtifactUnchangedSinceStepStart(noBaseline.id), false);
});

// --- webhook gate ---

test('wait is rejected with a checkpoint hint when the artifact was not edited this step', async () => {
  const t = makeRealThread();
  const { json } = await postThreadOp({ action: 'control', threadId: t.id, control: { action: 'wait' } });
  assert.equal(json.success, false);
  assert.match(json.error, /checkpoint/i, 'error must tell the agent to update the artifact');
  assert.match(json.error, /delegations|decisions|remaining plan|assumptions/i, 'error names the checkpoint structure');
  assert.equal(threadStore.get(t.id)!.metadata?.pendingControl ?? null, null, 'no control intent persisted');
});

test('wait is accepted after the artifact is edited within the step', async () => {
  const t = makeRealThread();
  fs.writeFileSync(t.artifactPath, '## Checkpoint\ndelegations / decisions / remaining plan / assumptions');
  const { json } = await postThreadOp({ action: 'control', threadId: t.id, control: { action: 'wait' } });
  assert.equal(json.success, true);
  assert.equal(threadStore.get(t.id)!.metadata?.pendingControl?.action, 'wait');
});

test('abort is NOT gated by the checkpoint check', async () => {
  const t = makeRealThread();
  const { json } = await postThreadOp({ action: 'control', threadId: t.id, control: { action: 'abort', kind: 'too-big', diagnosis: 'x' } });
  assert.equal(json.success, true, 'abort must never be blocked by the checkpoint gate');
});

test('wait passes for legacy threads without a recorded baseline (fail-open)', async () => {
  const t = makeBareThread({ artifactPath: '/tmp/nonexistent-ckpt-artifact-2.md', metadata: {} });
  const { json } = await postThreadOp({ action: 'control', threadId: t.id, control: { action: 'wait' } });
  assert.equal(json.success, true);
});
