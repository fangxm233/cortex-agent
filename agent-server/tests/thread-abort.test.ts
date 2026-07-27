// input:  Node test runner + thread control plane (pendingControl) + abort + summary
// output: peekPendingControl / clearPendingControl / abortThread state + preamble tests
// pos:    Verify agent-initiated abort infrastructure (DR-0015 control plane — tool-driven)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from '../src/core/utils.js';
import { threadStore } from '../src/store/thread-repo.js';
import {
  abortThread,
  buildStepPrompt,
  cancelThread,
  cleanupWorkspace,
  createThread,
  peekPendingControl,
  clearPendingControl,
  listAgents,
  loadConfig,
  resolveAgentSlotConfig,
  THREAD_PROTOCOL_PREAMBLE,
} from '../src/domain/threads/index.js';
import { buildThreadSummary, finalizeAbortedThread } from '../src/domain/threads/runner.js';
import type { ThreadRecord } from '../src/core/types/thread-types.js';

const THREADS_FILE = path.join(DATA_DIR, 'threads.json');
let threadsBackup: string | null = null;
let threadsBackupExisted = false;
const createdThreadIds = new Set<string>();

beforeAll(() => {
  try {
    threadsBackup = fs.readFileSync(THREADS_FILE, 'utf8');
    threadsBackupExisted = true;
  } catch {
    threadsBackup = null;
    threadsBackupExisted = false;
  }
  loadConfig();
});

afterAll(async () => {
  for (const id of createdThreadIds) {
    try { cleanupWorkspace(id); } catch {}
    await threadStore.delete(id);
  }
  if (threadsBackupExisted && threadsBackup != null) {
    fs.writeFileSync(THREADS_FILE, threadsBackup);
  } else {
    try { fs.unlinkSync(THREADS_FILE); } catch {}
  }
  await threadStore.flush();
});

process.on('exit', () => {
  if (threadsBackupExisted && threadsBackup != null) {
    try { fs.writeFileSync(THREADS_FILE, threadsBackup); } catch {}
  }
});

function trackThreadId(id: string): string {
  createdThreadIds.add(id);
  return id;
}

function makeAdHocThread(artifactBody = ''): ThreadRecord {
  const anyAgent = listAgents()[0];
  assert.ok(anyAgent, 'loadConfig should populate at least one agent');
  const thread = createThread(`C-abort-${Math.random().toString(36).slice(2, 8)}`, {
    agentName: anyAgent.name,
    userMessage: 'x',
    userMessageTs: 'ts',
  });
  trackThreadId(thread.id);
  if (artifactBody) fs.writeFileSync(thread.artifactPath, artifactBody);
  return thread;
}

/** Simulate the webhook `control` action writing pendingControl (out-of-band signal). */
async function setControl(threadId: string, control: NonNullable<ThreadRecord['metadata']>['pendingControl']): Promise<void> {
  await threadStore.mutate(threadId, (t) => { (t.metadata ??= {}).pendingControl = control; });
}

// --- pendingControl: abort signal (out-of-band, tool-driven) ---

test('peekPendingControl returns null when no control signal is set', () => {
  const thread = makeAdHocThread('normal output without any abort signal.\n');
  assert.equal(peekPendingControl(thread.id), null);
});

test('peekPendingControl returns null for missing / unknown thread id', () => {
  assert.equal(peekPendingControl('thr_does-not-exist-' + Date.now()), null);
});

test('peekPendingControl returns the abort signal written by the control action', async () => {
  const thread = makeAdHocThread();
  await setControl(thread.id, { action: 'abort', kind: 'too-big', diagnosis: 'three independent units' });
  const c = peekPendingControl(thread.id);
  assert.equal(c?.action, 'abort');
  assert.equal(c?.kind, 'too-big');
  assert.equal(c?.diagnosis, 'three independent units');
});

test('peekPendingControl does NOT clear; clearPendingControl removes the signal so it fires once', async () => {
  const thread = makeAdHocThread();
  await setControl(thread.id, { action: 'abort', kind: 'mis-scoped', diagnosis: 'scope wrong' });
  assert.equal(peekPendingControl(thread.id)?.action, 'abort');
  assert.equal(peekPendingControl(thread.id)?.action, 'abort', 'peek is non-destructive');
  await clearPendingControl(thread.id);
  assert.equal(peekPendingControl(thread.id), null);
});

test('clearPendingControl is a no-op when nothing is set (and for unknown ids)', async () => {
  const thread = makeAdHocThread();
  await clearPendingControl(thread.id); // no throw
  await clearPendingControl('thr_nope-' + Date.now()); // no throw
  assert.equal(peekPendingControl(thread.id), null);
});

// --- REGRESSION: artifact prose mentioning the old markers must NOT trigger control ---
// These reproduce the 2026-06-13 double-abort incident: worker artifact text that merely
// references [ABORT] must produce NO control signal under the out-of-band mechanism.

test('artifact text "No [ABORT]." does NOT produce any pending control', () => {
  const thread = makeAdHocThread('Feasibility confirmed. Proceed. No [ABORT].\n');
  assert.equal(peekPendingControl(thread.id), null, 'prose mentioning [ABORT] must not signal abort');
});

test('a plan that says "[ABORT: too-big — ...]" in the artifact does NOT produce any pending control', () => {
  const thread = makeAdHocThread('Plan: if the LEAP asset is missing, escalate with [ABORT: too-big — LEAP asset].\n');
  assert.equal(peekPendingControl(thread.id), null, 'conditional plan text must not signal abort');
});

test('artifact mentioning [SPLIT] / [WAIT_CHILDREN] prose does NOT produce any pending control', () => {
  const thread = makeAdHocThread('We could [SPLIT] this, or emit [WAIT_CHILDREN] later, but for now we just do it.\n');
  assert.equal(peekPendingControl(thread.id), null);
});

// --- abortThread ---

test('abortThread transitions running thread to aborted + records reason + sets endedAt', async () => {
  const thread = makeAdHocThread();
  const ok = await abortThread(thread.id, 'test case 1');
  assert.equal(ok, true);

  const updated = threadStore.get(thread.id)!;
  assert.equal(updated.status, 'aborted');
  assert.equal(updated.abortReason, 'test case 1');
  assert.ok(updated.endedAt, 'endedAt should be set');
  assert.equal(updated.error, null, 'error should remain null — abort is not a failure');
});

test('abortThread with null reason leaves abortReason as null', async () => {
  const thread = makeAdHocThread();
  const ok = await abortThread(thread.id, null);
  assert.equal(ok, true);

  const updated = threadStore.get(thread.id)!;
  assert.equal(updated.status, 'aborted');
  assert.equal(updated.abortReason, null);
});

test('abortThread is idempotent — second call returns false and does not mutate', async () => {
  const thread = makeAdHocThread();
  assert.equal(await abortThread(thread.id, 'once'), true);
  const firstEndedAt = threadStore.get(thread.id)!.endedAt;

  assert.equal(await abortThread(thread.id, 'twice'), false);
  const updated = threadStore.get(thread.id)!;
  assert.equal(updated.abortReason, 'once', 'abortReason should not be overwritten');
  assert.equal(updated.endedAt, firstEndedAt, 'endedAt should not be overwritten');
});

test('abortThread returns false for unknown thread id', async () => {
  assert.equal(await abortThread('thr_nope-' + Date.now(), 'x'), false);
});

test('abortThread returns false after cancelThread has terminated the thread (cancelled wins)', async () => {
  const thread = makeAdHocThread();
  assert.equal(await cancelThread(thread.id), true);
  assert.equal(threadStore.get(thread.id)!.status, 'cancelled');
  assert.equal(await abortThread(thread.id, 'late abort'), false);
  assert.equal(threadStore.get(thread.id)!.status, 'cancelled');
  assert.equal(threadStore.get(thread.id)!.abortReason, null);
});

test('cancelThread returns false after abortThread has terminated the thread (aborted wins)', async () => {
  const thread = makeAdHocThread();
  assert.equal(await abortThread(thread.id, 'first'), true);
  assert.equal(await cancelThread(thread.id), false);
  assert.equal(threadStore.get(thread.id)!.status, 'aborted');
});

// --- finalizeAbortedThread: block owning task BEFORE onEnd (DR-0015 problem 2) ---

test('finalizeAbortedThread aborts the thread then invokes onAbort with the owning task + reason', async () => {
  const thread = makeAdHocThread();
  const calls: Array<{ taskId: string; project: string | null; reason: string | null }> = [];
  await finalizeAbortedThread(
    thread.id,
    { taskId: 'abcd', taskProject: 'proj' } as any,
    'too-big',
    { onAbort: async (info) => { calls.push(info); } } as any,
  );
  assert.equal(threadStore.get(thread.id)!.status, 'aborted');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { taskId: 'abcd', project: 'proj', reason: 'too-big' });
});

test('finalizeAbortedThread skips onAbort when metadata has no taskId (non-dispatch thread)', async () => {
  const thread = makeAdHocThread();
  const calls: unknown[] = [];
  await finalizeAbortedThread(
    thread.id,
    { taskId: null, taskProject: null } as any,
    null,
    { onAbort: async (info) => { calls.push(info); } } as any,
  );
  assert.equal(threadStore.get(thread.id)!.status, 'aborted');
  assert.equal(calls.length, 0);
});

test('finalizeAbortedThread tolerates a missing onAbort callback', async () => {
  const thread = makeAdHocThread();
  await finalizeAbortedThread(thread.id, { taskId: 'efgh', taskProject: 'p' } as any, 'x', {} as any);
  assert.equal(threadStore.get(thread.id)!.status, 'aborted');
});

// --- buildThreadSummary rendering for aborted status ---

function minimalAbortedThread(reason: string | null, endedAt: string | null): ThreadRecord {
  return {
    id: 'thr_fake', templateName: null, status: 'aborted',
    channel: 'C1', projectId: 'general', platformThreadId: null,
    userMessage: '', userMessageTs: 'ts',
    workspacePath: '', artifactPath: '',
    agents: { main: { slotId: 'main', profile: '__active__', sessionId: null, sessionName: null, status: 'completed', lastOutput: null, persistSession: false } },
    activeAgent: 'main', activeStage: null, currentStepIndex: 1,
    steps: [{ stepIndex: 0, agentSlotId: 'main', stage: null, executionId: null, sessionId: null, sessionName: null, input: '', output: 'x', costUsd: 0, numTurns: 1, durationS: 1, startedAt: null, endedAt: null }],
    iterationCounts: {}, totalCostUsd: 0,
    createdAt: '2026-04-16T10:00:00Z', updatedAt: '2026-04-16T10:00:01Z',
    endedAt, error: null, abortReason: reason, metadata: null,
  };
}

test('buildThreadSummary renders stopped emoji for aborted status', () => {
  const thread = minimalAbortedThread('blocked on upstream', '2026-04-16T10:00:05Z');
  const summary = buildThreadSummary({ thread, finalOutput: null, totalCostUsd: 0, totalNumTurns: 0, lastAgentResult: null, executionId: null });
  assert.match(summary, /^🛑/);
  assert.match(summary, /Aborted: blocked on upstream/);
});

test('buildThreadSummary renders "Aborted (no reason given)" when abortReason is null', () => {
  const thread = minimalAbortedThread(null, '2026-04-16T10:00:05Z');
  const summary = buildThreadSummary({ thread, finalOutput: null, totalCostUsd: 0, totalNumTurns: 0, lastAgentResult: null, executionId: null });
  assert.match(summary, /Aborted \(no reason given\)/);
});

// --- THREAD_PROTOCOL_PREAMBLE injection into buildStepPrompt ---

test('THREAD_PROTOCOL_PREAMBLE teaches the thread_abort tool (not the old artifact marker)', () => {
  // Guards against accidental edits that drop the actual instruction OR reintroduce the marker.
  assert.match(THREAD_PROTOCOL_PREAMBLE, /thread_abort/);
  assert.match(THREAD_PROTOCOL_PREAMBLE, /Cortex Thread Protocol/);
  assert.doesNotMatch(THREAD_PROTOCOL_PREAMBLE, /\[ABORT/, 'must not instruct writing the old [ABORT] marker');
});

test('THREAD_PROTOCOL_PREAMBLE teaches task-based delegation without the removed thread_start tool', () => {
  assert.match(THREAD_PROTOCOL_PREAMBLE, /thread_wait/);
  assert.match(THREAD_PROTOCOL_PREAMBLE, /thread_split/);
  assert.match(THREAD_PROTOCOL_PREAMBLE, /cortex-task spawn/);
  assert.doesNotMatch(THREAD_PROTOCOL_PREAMBLE, /thread_start/);
  assert.doesNotMatch(THREAD_PROTOCOL_PREAMBLE, /\[WAIT_CHILDREN\]/, 'must not instruct writing the old marker');
  // Acceptance-before-trust: child results must be verified against the contract.
  assert.match(THREAD_PROTOCOL_PREAMBLE, /verif/i);
});

test('buildStepPrompt injects THREAD_PROTOCOL_PREAMBLE for ad-hoc thread with workspace artifact', () => {
  const anyAgent = listAgents()[0];
  const agentConfig = resolveAgentSlotConfig(anyAgent.name)!;
  const thread = createThread(`C-preamble-${Math.random().toString(36).slice(2, 8)}`, {
    agentName: anyAgent.name,
    userMessage: 'hello world',
    userMessageTs: 'ts',
  });
  trackThreadId(thread.id);

  const prompt = buildStepPrompt(thread.id, agentConfig);
  assert.ok(prompt.includes(THREAD_PROTOCOL_PREAMBLE), 'preamble should be auto-injected for artifact-owning thread');
});

test('buildStepPrompt does NOT inject preamble for a thread with no artifact path', () => {
  const anyAgent = listAgents()[0];
  const agentConfig = resolveAgentSlotConfig(anyAgent.name)!;
  const thread = createThread(`C-noart-${Math.random().toString(36).slice(2, 8)}`, {
    agentName: anyAgent.name,
    userMessage: 'hello',
    userMessageTs: 'ts',
  });
  trackThreadId(thread.id);

  thread.artifactPath = '';
  threadStore.set(thread);

  assert.equal(threadStore.get(thread.id)!.artifactPath, '', 'thread should have no artifact path');
  const prompt = buildStepPrompt(thread.id, agentConfig);
  assert.equal(prompt.includes(THREAD_PROTOCOL_PREAMBLE), false, 'preamble should not fire without artifact');
});

test('buildStepPrompt skips preamble when resuming a persistent session (slot.sessionId set)', () => {
  const anyAgent = listAgents()[0];
  const agentConfig = { ...resolveAgentSlotConfig(anyAgent.name)!, persistSession: true };
  const thread = createThread(`C-resume-${Math.random().toString(36).slice(2, 8)}`, {
    agentName: anyAgent.name,
    userMessage: 'hi',
    userMessageTs: 'ts',
  });
  trackThreadId(thread.id);

  const firstPrompt = buildStepPrompt(thread.id, agentConfig);
  assert.ok(firstPrompt.includes(THREAD_PROTOCOL_PREAMBLE), 'first trigger should include preamble');

  const record = threadStore.get(thread.id)!;
  record.agents[agentConfig.slotId].sessionId = 'fake-session-uuid';
  threadStore.set(record);

  const resumedPrompt = buildStepPrompt(thread.id, agentConfig);
  assert.equal(resumedPrompt.includes(THREAD_PROTOCOL_PREAMBLE), false, 'resume should skip preamble (already delivered)');
});
