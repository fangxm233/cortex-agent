// input:  node:test + runner recordStepOutcome chokepoint + state-machine + thread-repo recovery
// output: rate-limit thread pause/record contract (the integration gap the unit tests missed)
// pos:    asserts the REAL interruption point records a resume + leaves the thread resumable
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import '../_test-home.js'; // MUST be first — isolates store singletons to a temp CORTEX_HOME
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { threadStore } from '../../src/store/thread-repo.js';
import { recordStepOutcome, buildThreadSummary, resumeRateLimitedThread } from '../../src/domain/threads/runner.js';
import { markThreadRateLimited } from '../../src/domain/threads/state-machine.js';
import * as throttle from '../../src/domain/costs/rate-limit-throttle.js';
import * as resumeRegistry from '../../src/domain/costs/resume-registry.js';
import { MockAdapter } from '../../src/platform/testing.js';
import type { ThreadRecord } from '../../src/core/types/thread-types.js';

function makeThread(id: string, over: Partial<ThreadRecord> = {}): ThreadRecord {
  const now = new Date().toISOString();
  return {
    id, templateName: null, status: 'running', channel: 'C1', projectId: 'proj',
    platformThreadId: null, userMessage: 'do the task', userMessageTs: '1.0',
    workspacePath: '', artifactPath: '',
    agents: { main: { slotId: 'main', profile: '__active__', sessionId: null, sessionName: null, status: 'idle', lastOutput: null, persistSession: false } },
    activeAgent: 'main', activeStage: null, currentStepIndex: 0, steps: [], iterationCounts: {},
    totalCostUsd: 0, createdAt: now, updatedAt: now, endedAt: null, error: null, abortReason: null,
    metadata: null, ...over,
  } as ThreadRecord;
}

const stepCtx = () => ({ agentSlotId: 'main', prompt: 'p', sessionName: 's', execution: { id: null }, stepStartTime: new Date().toISOString(), stage: null }) as any;
const makeCtx = (thread: ThreadRecord) => ({ thread, template: null, meta: thread.metadata, stream: { emitText() {}, flush: async () => {} }, lastAgentResult: null, totalNumTurns: 0 }) as any;
const makeOpts = (thread: ThreadRecord) => ({ channel: thread.channel }) as any;

async function activateThrottle() {
  await throttle.initRateLimitThrottle(new MockAdapter({ adminChannel: 'admin' }) as any, { save: async () => {}, load: async () => null } as any);
  await throttle.handleRateLimitEvent({ rateLimitType: 'five_hour', utilization: 0.99, resetsAt: Math.floor(Date.now() / 1000) + 3000 }, 'plan');
}

function cleanup(t: { onTestFinished: (fn: () => unknown) => void }) {
  t.onTestFinished(() => { throttle._testReset(); resumeRegistry._testReset(); });
}

test('markThreadRateLimited pauses without terminalizing (idempotent)', async (t) => {
  cleanup(t);
  const thr = makeThread('thr_mark');
  await threadStore.set(thr);

  assert.equal(await markThreadRateLimited('thr_mark'), true);
  let r = threadStore.get('thr_mark')!;
  assert.equal(r.status, 'rate_limited');
  assert.equal(r.metadata?.interruptedByRateLimit, true);
  assert.equal(r.endedAt, null);
  assert.ok(r.error);

  // idempotent
  assert.equal(await markThreadRateLimited('thr_mark'), true);
  r = threadStore.get('thr_mark')!;
  assert.equal(r.status, 'rate_limited');

  await threadStore.delete('thr_mark');
});

test('recordStepOutcome: rate-limited while throttled pauses + records resume + does NOT advance step', async (t) => {
  cleanup(t);
  await activateThrottle();
  assert.equal(throttle.isThrottled(), true);

  const thr = makeThread('thr_grace');
  await threadStore.set(thr);
  const ctx = makeCtx(thr);

  await recordStepOutcome('thr_grace', stepCtx(), { rateLimited: true }, ctx, makeOpts(thr));

  const r = threadStore.get('thr_grace')!;
  assert.equal(r.status, 'rate_limited', 'thread paused');
  assert.equal(r.metadata?.interruptedByRateLimit, true);
  assert.equal(r.endedAt, null, 'not terminal');
  assert.equal(r.currentStepIndex, 0, 'step index NOT advanced');
  assert.equal(r.steps.length, 0, 'no bogus step recorded');
  assert.equal(ctx.rateLimited, true, 'ctx flagged so the loop breaks');

  const entries = resumeRegistry.takeAllResumes();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'thread');
  assert.equal((entries[0] as any).threadId, 'thr_grace');

  await threadStore.delete('thr_grace');
});

test('recordStepOutcome: rate-limited but NOT throttled falls through to terminal path (no resume)', async (t) => {
  cleanup(t);
  // No activateThrottle() → isThrottled() false.
  assert.equal(throttle.isThrottled(), false);

  const thr = makeThread('thr_nothrottle');
  await threadStore.set(thr);
  const ctx = makeCtx(thr);

  await recordStepOutcome('thr_nothrottle', stepCtx(), { rateLimited: true }, ctx, makeOpts(thr));

  const r = threadStore.get('thr_nothrottle')!;
  assert.equal(r.status, 'running', 'not paused — caller terminalizes as before');
  assert.equal(r.currentStepIndex, 1, 'step recorded/advanced (normal path)');
  assert.notEqual(ctx.rateLimited, true);
  assert.equal(resumeRegistry.getResumeCount(), 0, 'nothing recorded for resume');

  await threadStore.delete('thr_nothrottle');
});

test('buildThreadSummary shows a paused headline for rate_limited', () => {
  const thr = makeThread('thr_sum', { status: 'rate_limited' });
  const summary = buildThreadSummary({ thread: thr, finalOutput: null, totalCostUsd: 0, totalNumTurns: 0, lastAgentResult: null, executionId: null });
  assert.match(summary, /paused/i);
  assert.match(summary, /rate limited/i);
});

test('resumeRateLimitedThread refuses a thread that is not rate_limited', async () => {
  const thr = makeThread('thr_guard', { status: 'completed' });
  await threadStore.set(thr);
  await assert.rejects(() => resumeRateLimitedThread('thr_guard', makeOpts(thr)), /cannot resume/);
  await threadStore.delete('thr_guard');
});

test('markRunningAsFailedOnStartup exempts rate_limited; cleanup fails only stale rate_limited', async () => {
  const running = makeThread('thr_run');
  const pausedRecent = makeThread('thr_paused_recent', { status: 'rate_limited' });
  const pausedStale = makeThread('thr_paused_stale', { status: 'rate_limited' });
  await threadStore.set(running);
  await threadStore.set(pausedRecent);
  await threadStore.set(pausedStale);
  // Make the stale one's updatedAt 8 days old (same object reference is held by the map).
  pausedStale.updatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  await threadStore.markRunningAsFailedOnStartup();
  assert.equal(threadStore.get('thr_run')!.status, 'failed', 'plain running is failed on restart');
  assert.equal(threadStore.get('thr_paused_recent')!.status, 'rate_limited', 'paused survives restart');
  assert.equal(threadStore.get('thr_paused_stale')!.status, 'rate_limited', 'paused survives restart');

  await threadStore.cleanup(); // default 7-day maxAge
  assert.equal(threadStore.get('thr_paused_recent')!.status, 'rate_limited', 'recent paused kept');
  assert.equal(threadStore.get('thr_paused_stale')!.status, 'failed', 'stale paused failed (limbo safety net)');

  for (const id of ['thr_run', 'thr_paused_recent', 'thr_paused_stale']) await threadStore.delete(id);
});
