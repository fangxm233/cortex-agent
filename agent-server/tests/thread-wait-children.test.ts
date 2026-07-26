// input:  thread repo, wait controls, thread state machine
// output: thread-child wait-set and restart regression tests
// pos:    Verifies parent suspension on child threads
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { threadStore } from '../src/store/thread-repo.js';
import {
  peekPendingControl,
  clearPendingControl,
  tryEnterWaiting,
  detectSplitFromControl,
} from '../src/domain/threads/index.js';
import type { ThreadRecord, ThreadMetadata, ThreadStatus, AgentStep } from '../src/core/types/thread-types.js';

const createdThreadIds = new Set<string>();
const tmpDirs: string[] = [];
let seq = 0;

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function makeThread(over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = over.id ?? `thr_wait${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id,
    templateName: null,
    status: 'running' as ThreadStatus,
    channel: 'C-wait-test',
    projectId: 'general',
    platformThreadId: null,
    userMessage: 'x',
    userMessageTs: 'ts',
    workspacePath: '',
    artifactPath: '',
    agents: {},
    activeAgent: 'main',
    activeStage: null,
    currentStepIndex: 0,
    steps: [],
    iterationCounts: {},
    totalCostUsd: 0,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    error: null,
    abortReason: null,
    metadata: null,
    ...over,
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

function makeThreadWithArtifact(artifactBody: string, over: Partial<ThreadRecord> = {}): ThreadRecord {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thr-wait-'));
  tmpDirs.push(dir);
  const artifactPath = path.join(dir, 'artifact.md');
  fs.writeFileSync(artifactPath, artifactBody);
  return makeThread({ workspacePath: dir, artifactPath, ...over });
}

function step(output: string | null): AgentStep {
  return {
    stepIndex: 0, agentSlotId: 'main', stage: null, executionId: null,
    sessionId: null, sessionName: null, input: '', output,
    costUsd: 0, numTurns: 1, durationS: 1, startedAt: null, endedAt: null,
  };
}

// --- wait control signal (out-of-band, tool-driven) ---

async function setControl(threadId: string, control: NonNullable<ThreadMetadata>['pendingControl']): Promise<void> {
  await threadStore.mutate(threadId, (t) => { (t.metadata ??= {}).pendingControl = control; });
}

test('no wait control signal when neither artifact nor last step set one', () => {
  const t = makeThreadWithArtifact('normal progress.\n', { steps: [step('done with step')] });
  assert.equal(peekPendingControl(t.id), null);
});

test('peekPendingControl returns null for unknown thread id', () => {
  assert.equal(peekPendingControl('thr_nope_' + Date.now()), null);
});

test('a wait control signal is read from pendingControl (set by thread_wait → control action)', async () => {
  const t = makeThread();
  await setControl(t.id, { action: 'wait', onThreads: null, onTasks: null });
  assert.equal(peekPendingControl(t.id)?.action, 'wait');
});

test('clearPendingControl drains a wait signal so it fires exactly once', async () => {
  const t = makeThread();
  await setControl(t.id, { action: 'wait' });
  assert.equal(peekPendingControl(t.id)?.action, 'wait');
  await clearPendingControl(t.id);
  assert.equal(peekPendingControl(t.id), null);
});

// REGRESSION: artifact prose mentioning [WAIT_CHILDREN] must NOT create a wait control signal.
test('artifact text mentioning [WAIT_CHILDREN] does NOT create a wait control signal', () => {
  const t = makeThreadWithArtifact('Plan: spawn children, then [WAIT_CHILDREN] when ready.\n', {
    steps: [step('progress; will [WAIT_CHILDREN] next time')],
  });
  assert.equal(peekPendingControl(t.id), null, 'prose must not trigger wait');
});

// --- tryEnterWaiting ---

test('tryEnterWaiting returns false when waitingOn is empty or missing', async () => {
  const t1 = makeThread();
  assert.equal(await tryEnterWaiting(t1.id), false);
  const t2 = makeThread({ metadata: { waitingOn: [] } as ThreadMetadata });
  assert.equal(await tryEnterWaiting(t2.id), false);
  assert.equal(threadStore.get(t2.id)!.status, 'running');
});

test('tryEnterWaiting enters waiting when a child is still active', async () => {
  const child = makeThread({ status: 'running' });
  const parent = makeThread({ metadata: { waitingOn: [child.id], childThreadIds: [child.id] } });
  assert.equal(await tryEnterWaiting(parent.id), true);
  const updated = threadStore.get(parent.id)!;
  assert.equal(updated.status, 'waiting');
  assert.deepEqual(updated.metadata!.waitingOn, [child.id]);
});

test('explicit onThreads replaces the inferred thread wait set', async () => {
  const first = makeThread({ status: 'running' });
  const second = makeThread({ status: 'running' });
  const parent = makeThread({ metadata: {
    waitingOn: [first.id, second.id],
    childThreadIds: [first.id, second.id],
  } });

  assert.equal(await tryEnterWaiting(parent.id, { onThreads: [second.id] }), true);
  assert.deepEqual(threadStore.get(parent.id)!.metadata!.waitingOn, [second.id]);
});

test('explicit empty onThreads suppresses inferred thread children', async () => {
  const child = makeThread({ status: 'running' });
  const parent = makeThread({ metadata: { waitingOn: [child.id], childThreadIds: [child.id] } });

  assert.equal(await tryEnterWaiting(parent.id, { onThreads: [] }), false);
  assert.deepEqual(threadStore.get(parent.id)!.metadata!.waitingOn, []);
});

test('explicit onThreads keeps only unique live linked children', async () => {
  const live = makeThread({ status: 'running' });
  const done = makeThread({ status: 'completed' });
  const unrelated = makeThread({ status: 'running' });
  const parent = makeThread({ metadata: {
    waitingOn: [live.id, done.id],
    childThreadIds: [live.id, done.id],
  } });

  assert.equal(await tryEnterWaiting(parent.id, {
    onThreads: [live.id, live.id, done.id, unrelated.id, 'thr_missing'],
  }), true);
  assert.deepEqual(threadStore.get(parent.id)!.metadata!.waitingOn, [live.id]);
});

test('tryEnterWaiting filters out terminal and missing children before deciding', async () => {
  const done = makeThread({ status: 'completed' });
  const live = makeThread({ status: 'running' });
  const missingId = 'thr_purged_' + Date.now();
  const parent = makeThread({ metadata: { waitingOn: [done.id, live.id, missingId] } });
  assert.equal(await tryEnterWaiting(parent.id), true);
  const updated = threadStore.get(parent.id)!;
  assert.equal(updated.status, 'waiting');
  assert.deepEqual(updated.metadata!.waitingOn, [live.id]);
});

test('tryEnterWaiting returns false (and stays running) when all children are already terminal', async () => {
  const done = makeThread({ status: 'completed' });
  const failed = makeThread({ status: 'failed' });
  const parent = makeThread({ metadata: { waitingOn: [done.id, failed.id] } });
  assert.equal(await tryEnterWaiting(parent.id), false);
  const updated = threadStore.get(parent.id)!;
  assert.equal(updated.status, 'running');
  assert.deepEqual(updated.metadata!.waitingOn, []);
});

test('tryEnterWaiting returns false for unknown thread id', async () => {
  assert.equal(await tryEnterWaiting('thr_nope_' + Date.now()), false);
});

// --- detectSplitFromControl (DR-0015: derives split from pendingControl, not artifact) ---

test('detectSplitFromControl returns split=false when no control signal present', () => {
  const t = makeThreadWithArtifact('just regular work\n');
  const r = detectSplitFromControl(t.id);
  assert.equal(r.split, false);
  assert.equal(r.subtasks, null);
  assert.equal(r.error, null);
});

test('detectSplitFromControl returns split=false for a non-split control (e.g. abort)', async () => {
  const t = makeThread();
  await setControl(t.id, { action: 'abort', kind: 'too-big', diagnosis: 'x' });
  const r = detectSplitFromControl(t.id);
  assert.equal(r.split, false);
});

test('detectSplitFromControl returns the typed subtasks array from a split control', async () => {
  const t = makeThread();
  await setControl(t.id, { action: 'split', subtasks: [
    { key: 'a', text: 'do part A', 'done-when': 'A exists' },
    { key: 'b', text: 'do part B', depends_on: ['a'] },
  ] });
  const r = detectSplitFromControl(t.id);
  assert.equal(r.split, true);
  assert.equal(r.error, null);
  assert.equal(r.subtasks!.length, 2);
  assert.equal(r.subtasks![0].text, 'do part A');
});

test('detectSplitFromControl reports error when the subtasks array is empty', async () => {
  const t = makeThread();
  await setControl(t.id, { action: 'split', subtasks: [] });
  const r = detectSplitFromControl(t.id);
  assert.equal(r.split, true);
  assert.equal(r.subtasks, null);
  assert.ok(r.error);
});

test('detectSplitFromControl reports error when subtasks is missing entirely', async () => {
  const t = makeThread();
  await setControl(t.id, { action: 'split', subtasks: null });
  const r = detectSplitFromControl(t.id);
  assert.equal(r.split, true);
  assert.equal(r.subtasks, null);
  assert.ok(r.error);
});

// REGRESSION: artifact prose containing a fenced [SPLIT] block must NOT create a split.
test('artifact text with a [SPLIT] code fence does NOT create a split control signal', () => {
  const body = [
    'analysis: this task is actually three independent units.',
    '[SPLIT]',
    '```json',
    JSON.stringify({ subtasks: [{ text: 'do part A' }] }),
    '```',
  ].join('\n');
  const t = makeThreadWithArtifact(body);
  assert.equal(peekPendingControl(t.id), null, 'artifact prose must not signal split');
  const r = detectSplitFromControl(t.id);
  assert.equal(r.split, false);
});

// --- markRunningAsFailedOnStartup: waiting-on-children survives restart ---

test('markRunningAsFailedOnStartup fails running threads but preserves waiting-on-children parents', async () => {
  const running = makeThread({ status: 'running' });
  const child = makeThread({ status: 'running' });
  const waitingParent = makeThread({ status: 'waiting', metadata: { waitingOn: [child.id] } });
  const plainWaiting = makeThread({ status: 'waiting', metadata: null });

  await threadStore.markRunningAsFailedOnStartup();

  assert.equal(threadStore.get(running.id)!.status, 'failed');
  assert.equal(threadStore.get(child.id)!.status, 'failed', 'in-flight children are interrupted by restart');
  assert.equal(threadStore.get(waitingParent.id)!.status, 'waiting', 'suspended parent must survive restart');
  assert.equal(threadStore.get(plainWaiting.id)!.status, 'failed', 'legacy waiting (no children) keeps old semantics');
});

// --- cleanup: stale waiting parents are failed as a leak safety net ---

test('cleanup marks over-age waiting threads as failed instead of leaking them forever', async () => {
  const child = makeThread({ status: 'running' });
  const stale = makeThread({ status: 'waiting', metadata: { waitingOn: [child.id] } });
  const fresh = makeThread({ status: 'waiting', metadata: { waitingOn: [child.id] } });
  // Backdate via the live record reference (set() would refresh updatedAt).
  threadStore.get(stale.id)!.updatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  await threadStore.cleanup();

  assert.equal(threadStore.get(stale.id)!.status, 'failed');
  assert.ok(/stale/i.test(threadStore.get(stale.id)!.error || ''));
  assert.equal(threadStore.get(fresh.id)!.status, 'waiting', 'recent waiting parent untouched');
});
