// input:  thread runner, prompt readiness, store, mock adapter
// output: lifecycle, snapshot buffering, and wait-control regressions
// pos:    Verifies thread runtime helpers in isolation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DATA_DIR } from '../src/core/utils.js';
import { threadStore } from '../src/store/thread-repo.js';
import {
  buildThreadSummary,
  initThreadContext,
  evaluateAndTransition,
  finalizeThread,
  consumeWaitControl,
  getActiveHandle,
  cancelActiveThread,
  type ThreadRunResult,
  type ThreadContext,
} from '../src/domain/threads/runner.js';
import { buildReadyStepPrompt, buildStepPrompt } from '../src/domain/threads/prompt-builder.js';
import { evictPendingUserInput, registerPendingUserInput, waitForPendingUserInputs } from '../src/domain/threads/pending-user-inputs.js';
import { MockAdapter } from '../src/platform/testing.js';
import type { ThreadRecord, RunThreadOptions, AgentSlotConfig } from '../src/core/types/thread-types.js';

// --- threads.json backup / restore so tests do not pollute production state ---

const THREADS_FILE = path.join(DATA_DIR, 'threads.json');
let threadsBackup: string | null = null;
let threadsBackupExisted = false;
const testThreadIds = new Set<string>();

beforeAll(() => {
  try {
    threadsBackup = fs.readFileSync(THREADS_FILE, 'utf8');
    threadsBackupExisted = true;
  } catch {
    threadsBackup = null;
    threadsBackupExisted = false;
  }
});

afterAll(async () => {
  if (threadsBackupExisted && threadsBackup != null) {
    fs.writeFileSync(THREADS_FILE, threadsBackup);
  } else {
    try { fs.unlinkSync(THREADS_FILE); } catch {}
  }
  for (const id of testThreadIds) await threadStore.delete(id);
  await threadStore.flush();
});

process.on('exit', () => {
  if (threadsBackupExisted && threadsBackup != null) {
    try { fs.writeFileSync(THREADS_FILE, threadsBackup); } catch {}
  }
});

function makeThreadRecord(init: Partial<ThreadRecord> & { id: string; channel: string }): ThreadRecord {
  const now = new Date().toISOString();
  return {
    id: init.id,
    templateName: init.templateName ?? null,
    status: init.status ?? 'running',
    channel: init.channel,
    projectId: init.projectId ?? 'general',
    platformThreadId: init.platformThreadId ?? null,
    userMessage: init.userMessage ?? 'hello',
    userMessageTs: init.userMessageTs ?? '111.000',
    workspacePath: init.workspacePath ?? '',
    artifactPath: init.artifactPath ?? '',
    agents: init.agents ?? {
      main: { slotId: 'main', profile: '__active__', sessionId: null, sessionName: null, status: 'idle', lastOutput: null, persistSession: false },
    },
    activeAgent: init.activeAgent ?? 'main',
    activeStage: init.activeStage ?? null,
    currentStepIndex: init.currentStepIndex ?? 0,
    steps: init.steps ?? [],
    iterationCounts: init.iterationCounts ?? {},
    totalCostUsd: init.totalCostUsd ?? 0,
    createdAt: init.createdAt ?? now,
    updatedAt: init.updatedAt ?? now,
    endedAt: init.endedAt ?? null,
    error: init.error ?? null,
    abortReason: init.abortReason ?? null,
    metadata: init.metadata ?? null,
  };
}

function registerTestThread(record: ThreadRecord): void {
  testThreadIds.add(record.id);
  threadStore.set(record);
}

function uniqueThreadId(prefix: string): string {
  const id = `thr_test-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return id;
}

/** Minimal OutputStream stand-in for ThreadContext literals in unit tests. */
const noopStream = { emitText: () => {}, flush: async () => {} } as any;

function makeRunOpts(channel: string, overrides: Partial<RunThreadOptions> = {}): RunThreadOptions {
  return {
    adapter: new MockAdapter() as any,
    channel,
    destination: { type: 'interactive-reply', conduit: channel, sessionId: '' },
    threadAnchorId: null,
    statusMsg: null,
    startTime: Date.now(),
    onProgress: null,
    ...overrides,
  };
}

// --- buildThreadSummary ---

test('buildThreadSummary renders completed single-step thread on one line', () => {
  const thread = makeThreadRecord({
    id: 'thr_x', channel: 'C1', status: 'completed', totalCostUsd: 0.1234,
    createdAt: '2026-04-16T10:00:00Z', endedAt: '2026-04-16T10:00:12Z',
    steps: [{ stepIndex: 0, agentSlotId: 'main', stage: null, executionId: null, sessionId: null, sessionName: null, input: '', output: 'ok', costUsd: 0.1234, numTurns: 2, durationS: 12, startedAt: null, endedAt: null }],
  });
  const summary = buildThreadSummary({ thread, finalOutput: 'ok', totalCostUsd: 0.1234, totalNumTurns: 2, lastAgentResult: null, executionId: null, stopReason: null });
  assert.match(summary, /^✅ Thread complete \| 1 steps \| \$0\.1234 \|/);
  assert.equal(summary.split('\n').length, 1, 'single-step threads should not include per-step breakdown');
});

test('buildThreadSummary includes per-step breakdown when >1 step', () => {
  const thread = makeThreadRecord({
    id: 'thr_x', channel: 'C1', status: 'completed', totalCostUsd: 0.3,
    createdAt: '2026-04-16T10:00:00Z', endedAt: '2026-04-16T10:00:30Z',
    steps: [
      { stepIndex: 0, agentSlotId: 'planner', stage: null, executionId: null, sessionId: null, sessionName: null, input: '', output: 'a', costUsd: 0.1, numTurns: 1, durationS: 10, startedAt: null, endedAt: null },
      { stepIndex: 1, agentSlotId: 'coder', stage: null, executionId: null, sessionId: null, sessionName: null, input: '', output: 'b', costUsd: 0.2, numTurns: 3, durationS: 20, startedAt: null, endedAt: null },
    ],
  });
  const summary = buildThreadSummary({ thread, finalOutput: 'b', totalCostUsd: 0.3, totalNumTurns: 4, lastAgentResult: null, executionId: null, stopReason: null });
  const lines = summary.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /planner: 1 turns · \$0\.1000 ·/);
  assert.match(lines[2], /coder: 3 turns · \$0\.2000 ·/);
});

test('buildThreadSummary uses blocked emoji for cancelled and error for failed', () => {
  const base = makeThreadRecord({ id: 'thr_y', channel: 'C1', createdAt: '2026-04-16T10:00:00Z', endedAt: '2026-04-16T10:00:01Z' });
  const cancelled = { ...base, status: 'cancelled' as const };
  const failed = { ...base, status: 'failed' as const, error: 'boom' };
  const sCancel = buildThreadSummary({ thread: cancelled, finalOutput: null, totalCostUsd: 0, totalNumTurns: 0, lastAgentResult: null, executionId: null, stopReason: null });
  const sFail = buildThreadSummary({ thread: failed, finalOutput: null, totalCostUsd: 0, totalNumTurns: 0, lastAgentResult: null, executionId: null, stopReason: null });
  assert.match(sCancel, /^🚫/);
  assert.match(sFail, /^❌/);
  assert.match(sFail, /Error: boom/);
});

test('buildThreadSummary handles missing per-step cost/turns/duration as "?"', () => {
  const thread = makeThreadRecord({
    id: 'thr_z', channel: 'C1', status: 'completed', totalCostUsd: 0,
    createdAt: '2026-04-16T10:00:00Z', endedAt: '2026-04-16T10:00:00Z',
    steps: [
      { stepIndex: 0, agentSlotId: 'a', stage: null, executionId: null, sessionId: null, sessionName: null, input: '', output: null, costUsd: null, numTurns: null, durationS: null, startedAt: null, endedAt: null },
      { stepIndex: 1, agentSlotId: 'b', stage: null, executionId: null, sessionId: null, sessionName: null, input: '', output: null, costUsd: null, numTurns: null, durationS: null, startedAt: null, endedAt: null },
    ],
  });
  const summary = buildThreadSummary({ thread, finalOutput: null, totalCostUsd: 0, totalNumTurns: 0, lastAgentResult: null, executionId: null, stopReason: null });
  assert.match(summary, /a: \? · \? · \?/);
  assert.match(summary, /b: \? · \? · \?/);
});

test('buildThreadSummary elapsed is 0 when endedAt is null', () => {
  const thread = makeThreadRecord({
    id: 'thr_w', channel: 'C1', status: 'completed', totalCostUsd: 0, endedAt: null,
    steps: [{ stepIndex: 0, agentSlotId: 'main', stage: null, executionId: null, sessionId: null, sessionName: null, input: '', output: '', costUsd: 0, numTurns: 0, durationS: 0, startedAt: null, endedAt: null }],
  });
  const summary = buildThreadSummary({ thread, finalOutput: '', totalCostUsd: 0, totalNumTurns: 0, lastAgentResult: null, executionId: null, stopReason: null });
  assert.ok(summary.length > 0);
  assert.doesNotMatch(summary, /NaN/);
});

// --- initThreadContext ---

test('initThreadContext on a thread returns template=null for ad-hoc and a non-null OutputStream', () => {
  const id = uniqueThreadId('init-adhoc');
  registerTestThread(makeThreadRecord({ id, channel: 'C-init-1', templateName: null }));
  const ctx = initThreadContext(id, makeRunOpts('C-init-1'));
  assert.equal(ctx.template, null);
  assert.ok(ctx.stream, 'threads should get an OutputStream aggregator');
  assert.equal(ctx.lastAgentResult, null);
  assert.equal(ctx.totalNumTurns, 0);
  assert.equal(ctx.thread.id, id);
});

test('initThreadContext throws when thread does not exist', () => {
  assert.throws(() => initThreadContext('thr_does-not-exist-xxxx', makeRunOpts('C-init-3')), /Thread not found/);
});

// --- evaluateAndTransition short-circuit paths ---

test('evaluateAndTransition returns false for ad-hoc thread (no template)', async () => {
  const id = uniqueThreadId('eval-adhoc');
  registerTestThread(makeThreadRecord({ id, channel: 'C-eval-2', templateName: null }));
  const ctx: ThreadContext = { thread: threadStore.get(id)!, template: null, meta: null, stream: noopStream, lastAgentResult: null, totalNumTurns: 0, stopReason: null };
  const stepCtx = { agentSlotId: 'main', agentConfig: { slotId: 'main', profile: '__active__', persistSession: false }, isFirstStep: true, multiAgent: false } as any;
  const result = await evaluateAndTransition(id, stepCtx, ctx, makeRunOpts('C-eval-2'));
  assert.equal(result, false);
});

// --- wait-control boundary ---

test('consumeWaitControl forwards explicit selectors before clearing the control', async () => {
  const firstId = uniqueThreadId('wait-first');
  const secondId = uniqueThreadId('wait-second');
  const parentId = uniqueThreadId('wait-parent');
  registerTestThread(makeThreadRecord({ id: firstId, channel: 'C-wait', status: 'running' }));
  registerTestThread(makeThreadRecord({ id: secondId, channel: 'C-wait', status: 'running' }));
  registerTestThread(makeThreadRecord({
    id: parentId,
    channel: 'C-wait',
    metadata: {
      waitingOn: [firstId, secondId],
      childThreadIds: [firstId, secondId],
      pendingControl: { action: 'wait', onThreads: [secondId], onTasks: null },
    },
  }));
  const control = threadStore.get(parentId)!.metadata!.pendingControl!;

  assert.equal(await consumeWaitControl(parentId, control), true);
  const updated = threadStore.get(parentId)!;
  assert.equal(updated.metadata!.pendingControl, null);
  assert.deepEqual(updated.metadata!.waitingOn, [secondId]);
});

// --- finalizeThread ---

test('finalizeThread falls back to lastAgentResult.finalOutput when artifact missing', async () => {
  const id = uniqueThreadId('final-fallback');
  registerTestThread(makeThreadRecord({ id, channel: 'C-fin-1', templateName: null, artifactPath: '/nonexistent/path/artifact.md', totalCostUsd: 0.5 }));
  const ctx: ThreadContext = {
    thread: threadStore.get(id)!, template: null, meta: null, stream: noopStream,
    lastAgentResult: { finalOutput: 'from-agent' }, totalNumTurns: 3, stopReason: null,
  };
  const result = await finalizeThread(id, ctx);
  assert.equal(result.finalOutput, 'from-agent');
  assert.equal(result.totalCostUsd, 0.5);
  assert.equal(result.totalNumTurns, 3);
});

test('finalizeThread reads artifact file when present and prefers it over lastAgentResult', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-runner-artifact-'));
  const artifactPath = path.join(tmp, 'artifact.md');
  fs.writeFileSync(artifactPath, 'from-artifact');

  const id = uniqueThreadId('final-artifact');
  registerTestThread(makeThreadRecord({ id, channel: 'C-fin-2', templateName: null, artifactPath, totalCostUsd: 0.1 }));
  const ctx: ThreadContext = {
    thread: threadStore.get(id)!, template: null, meta: null, stream: noopStream,
    lastAgentResult: { finalOutput: 'from-agent-fallback' }, totalNumTurns: 1, stopReason: null,
  };
  const result = await finalizeThread(id, ctx);
  assert.equal(result.finalOutput, 'from-artifact');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('finalizeThread flushes OutputStream with final output when stream is present', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-runner-vm-'));
  const artifactPath = path.join(tmp, 'artifact.md');
  fs.writeFileSync(artifactPath, 'final text');

  const id = uniqueThreadId('final-vm');
  registerTestThread(makeThreadRecord({ id, channel: 'C-fin-3', templateName: null, artifactPath }));
  const appended: string[] = [];
  let flushCount = 0;
  const fakeStream = {
    emitText: (t: string) => { appended.push(t); },
    flush: async () => { flushCount++; },
  };
  const ctx: ThreadContext = {
    thread: threadStore.get(id)!, template: null, meta: null, stream: fakeStream as any,
    lastAgentResult: null, totalNumTurns: 0, stopReason: null,
  };
  await finalizeThread(id, ctx);
  assert.deepEqual(appended, ['final text']);
  assert.equal(flushCount, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('finalizeThread does not flush stream when finalOutput is null', async () => {
  const id = uniqueThreadId('final-null');
  registerTestThread(makeThreadRecord({ id, channel: 'C-fin-4', templateName: null, artifactPath: '/nonexistent' }));
  let flushed = false;
  const fakeStream = { emitText: () => {}, flush: async () => { flushed = true; } };
  const ctx: ThreadContext = {
    thread: threadStore.get(id)!, template: null, meta: null, stream: fakeStream as any,
    lastAgentResult: null, totalNumTurns: 0, stopReason: null,
  };
  const result = await finalizeThread(id, ctx);
  assert.equal(result.finalOutput, null);
  assert.equal(flushed, false);
});

test('finalizeThread includes executionId from last step when steps have executionId', async () => {
  const id = uniqueThreadId('execid');
  registerTestThread(makeThreadRecord({
    id, channel: 'C-exec', templateName: null,
    steps: [{
      stepIndex: 0, agentSlotId: 'main', stage: null,
      executionId: 'exec_abc123',
      sessionId: null, sessionName: null,
      input: '', output: null, costUsd: null, numTurns: null,
      durationS: null, startedAt: null, endedAt: null,
    }],
  }));
  const ctx: ThreadContext = {
    thread: threadStore.get(id)!, template: null, meta: null, stream: noopStream,
    lastAgentResult: null, totalNumTurns: 0, stopReason: null,
  };
  const result = await finalizeThread(id, ctx);
  assert.equal(result.executionId, 'exec_abc123');
});

test('finalizeThread returns null executionId when no steps exist', async () => {
  const id = uniqueThreadId('execid-null');
  registerTestThread(makeThreadRecord({
    id, channel: 'C-exec2', templateName: null,
    steps: [],
  }));
  const ctx: ThreadContext = {
    thread: threadStore.get(id)!, template: null, meta: null, stream: noopStream,
    lastAgentResult: null, totalNumTurns: 0, stopReason: null,
  };
  const result = await finalizeThread(id, ctx);
  assert.equal(result.executionId, null);
});

// --- Re-exports delegate to running-executions ---

test('getActiveHandle returns null for unknown channel (pass-through delegation)', () => {
  const result = getActiveHandle('channel-does-not-exist-' + Math.random());
  assert.equal(result, null);
});

// --- buildStepPrompt with pendingMessages ---

test('buildStepPrompt includes pendingMessages from thread metadata', () => {
  const id = uniqueThreadId('prompt-pending');
  registerTestThread(makeThreadRecord({
    id, channel: 'C-prompt',
    metadata: { pendingMessages: ['first reply', 'second reply'] },
    workspacePath: '', artifactPath: '',
  }));

  const agentConfig: AgentSlotConfig = {
    slotId: 'main',
    profile: '__active__',
    persistSession: false,
    promptTemplate: '{{input}}',
  };

  const prompt = buildStepPrompt(id, agentConfig, null);
  assert.match(prompt, /first reply/);
  assert.match(prompt, /second reply/);
  assert.match(prompt, /用户回复|buffered/i);
});

test('buildStepPrompt unchanged when no pendingMessages', () => {
  const id = uniqueThreadId('prompt-none');
  registerTestThread(makeThreadRecord({
    id, channel: 'C-prompt2',
    metadata: {},
    workspacePath: '', artifactPath: '',
  }));

  const agentConfig: AgentSlotConfig = {
    slotId: 'main',
    profile: '__active__',
    persistSession: false,
    promptTemplate: '{{input}}',
  };

  const prompt = buildStepPrompt(id, agentConfig, null);
  assert.doesNotMatch(prompt, /用户回复|buffered/i);
});

test('buildStepPrompt consumes structured buffered user input alongside legacy notices', () => {
  const id = uniqueThreadId('prompt-user-input');
  registerTestThread(makeThreadRecord({
    id, channel: 'C-prompt-user-input',
    metadata: {
      pendingMessages: ['child result ready'],
      pendingUserInputs: [{ id: 'buf_1', text: 'inspect /tmp/thread-report.txt' }],
    },
    workspacePath: '', artifactPath: '',
  }));
  const agentConfig: AgentSlotConfig = {
    slotId: 'main', profile: '__active__', persistSession: false, promptTemplate: '{{input}}',
  };

  const prompt = buildStepPrompt(id, agentConfig, null);

  assert.match(prompt, /child result ready/);
  assert.match(prompt, /\/tmp\/thread-report\.txt/);
  assert.deepEqual(threadStore.get(id)?.metadata?.pendingMessages, []);
  assert.deepEqual((threadStore.get(id)?.metadata as any)?.pendingUserInputs, []);
});

test('buildReadyStepPrompt waits for its snapshot and leaves later arrivals for the next step', async () => {
  const id = uniqueThreadId('prompt-ready-snapshot');
  registerTestThread(makeThreadRecord({
    id, channel: 'C-prompt-ready',
    metadata: {
      pendingMessages: ['legacy before'],
      pendingUserInputs: [{ id: 'buf_a', text: 'first prepared input' }],
    },
    workspacePath: '', artifactPath: '',
  }));
  let releaseA!: () => void;
  const pendingA = new Promise<void>((resolve) => { releaseA = resolve; });
  registerPendingUserInput(id, 'buf_a', pendingA);
  const agentConfig: AgentSlotConfig = {
    slotId: 'main', profile: '__active__', persistSession: false, promptTemplate: '{{input}}',
  };

  const readyPrompt = buildReadyStepPrompt(id, agentConfig, null);
  const thread = threadStore.get(id)!;
  thread.metadata!.pendingMessages!.push('legacy after');
  thread.metadata!.pendingUserInputs!.push({ id: 'buf_b', text: 'second pending input' });
  await threadStore.set(thread);
  const neverB = new Promise<void>(() => {});
  registerPendingUserInput(id, 'buf_b', neverB);
  releaseA();
  const prompt = await readyPrompt;

  assert.match(prompt, /legacy before/);
  assert.match(prompt, /first prepared input/);
  assert.doesNotMatch(prompt, /legacy after|second pending input/);
  assert.deepEqual(threadStore.get(id)?.metadata?.pendingMessages, ['legacy after']);
  assert.deepEqual(threadStore.get(id)?.metadata?.pendingUserInputs, [
    { id: 'buf_b', text: 'second pending input' },
  ]);
  evictPendingUserInput(id, 'buf_b');
});

test('buildReadyStepPrompt preserves its legacy snapshot across cap shift and push', async () => {
  const id = uniqueThreadId('prompt-ready-legacy-cap');
  const originalNotices = Array.from({ length: 10 }, (_, index) => `notice ${index}`);
  registerTestThread(makeThreadRecord({
    id, channel: 'C-prompt-ready-cap',
    metadata: {
      pendingMessages: [...originalNotices],
      pendingUserInputs: [{ id: 'buf_gate', text: 'prepared input' }],
    },
    workspacePath: '', artifactPath: '',
  }));
  let release!: () => void;
  const preparation = new Promise<void>((resolve) => { release = resolve; });
  registerPendingUserInput(id, 'buf_gate', preparation);
  const agentConfig: AgentSlotConfig = {
    slotId: 'main', profile: '__active__', persistSession: false, promptTemplate: '{{input}}',
  };

  const readyPrompt = buildReadyStepPrompt(id, agentConfig, null);
  const thread = threadStore.get(id)!;
  thread.metadata!.pendingMessages!.shift();
  thread.metadata!.pendingMessages!.push('late notice');
  await threadStore.set(thread);
  release();
  const prompt = await readyPrompt;

  for (const notice of originalNotices) assert.match(prompt, new RegExp(notice));
  assert.doesNotMatch(prompt, /late notice/);
  assert.deepEqual(threadStore.get(id)?.metadata?.pendingMessages, ['late notice']);
});

test('evictPendingUserInput releases a waiter even if the download never settles', async () => {
  const id = uniqueThreadId('prompt-ready-evict');
  registerPendingUserInput(id, 'buf_slow', new Promise<void>(() => {}));
  let released = false;
  const waiting = waitForPendingUserInputs(id, ['buf_slow'])
    .then(() => { released = true; });

  await Promise.resolve();
  assert.equal(released, false);
  evictPendingUserInput(id, 'buf_slow');
  await waiting;
  assert.equal(released, true);
});
