import '../_test-home.js'; // MUST be first — isolates store singletons to a temp CORTEX_HOME
import { afterEach, beforeAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const attempt = vi.hoisted(() => ({ startAttempt: vi.fn() }));

// The run layer is the spawn seam now: intercept startAttempt, not the retired agent facade.
vi.mock('@domain/runs/attempt.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, startAttempt: attempt.startAttempt };
});

vi.mock('@domain/agents/index.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getActiveBackend: () => 'pi',
    getActiveProfile: () => 'outage-profile',
    getClaudeMode: () => 'api',
  };
});

import { CONFIG_DIR, STORE_DIR } from '../../src/core/paths.js';
import { profileRepo, PROFILES_FILE } from '../../src/store/profile-repo.js';
import { threadStore } from '../../src/store/thread-repo.js';
import { initHookBus } from '../../src/core/hook-bus.js';
import { buildStepPrompt, cleanupWorkspace, createThread, loadConfig, resolveAgentSlotConfig } from '../../src/domain/threads/index.js';
import { continueThread, resumeRateLimitedThread, runThread } from '../../src/domain/threads/runner.js';
import * as throttle from '../../src/domain/costs/rate-limit-throttle.js';
import * as resumeRegistry from '../../src/domain/costs/resume-registry.js';
import { dispatchPendingResumes } from '../../src/orchestration/resume-dispatcher.js';
import { MockAdapter } from '../../src/platform/testing.js';
import type { RunThreadOptions, ThreadRecord } from '../../src/core/types/thread-types.js';

const createdThreadIds = new Set<string>();
const adapter = new MockAdapter({ adminChannel: 'admin' });

function writeThreadFixture(): void {
  const configRoot = path.join(CONFIG_DIR, 'thread-templates');
  const agentsDir = path.join(configRoot, 'agents');
  const templatesDir = path.join(configRoot, 'templates');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'outage-worker.json'), JSON.stringify({
    name: 'outage-worker', profile: 'outage-profile',
    persistSession: true, promptTemplate: '{{input}}',
  }));
  fs.writeFileSync(path.join(templatesDir, 'provider-outage.json'), JSON.stringify({
    name: 'provider-outage', description: 'provider outage regression fixture',
    agents: ['outage-worker'], transitions: [], entryAgent: 'outage-worker', maxTotalSteps: 3,
  }));
  fs.writeFileSync(path.join(agentsDir, 'outage-fresh-worker.json'), JSON.stringify({
    name: 'outage-fresh-worker', profile: 'outage-profile',
    persistSession: false, promptTemplate: '{{input}}',
  }));
  fs.writeFileSync(path.join(templatesDir, 'provider-outage-fresh.json'), JSON.stringify({
    name: 'provider-outage-fresh', description: 'non-persist provider outage fixture',
    agents: ['outage-fresh-worker'], transitions: [], entryAgent: 'outage-fresh-worker', maxTotalSteps: 3,
  }));
  // A slot pointing at a profile that does not exist. The step still runs (the execution record is
  // opened with a borrowed backend and the run is what rejects the name), but nothing about it
  // names a provider.
  fs.writeFileSync(path.join(agentsDir, 'outage-unknown-profile-worker.json'), JSON.stringify({
    name: 'outage-unknown-profile-worker', profile: 'missing-profile',
    persistSession: true, promptTemplate: '{{input}}',
  }));
  fs.writeFileSync(path.join(templatesDir, 'provider-outage-unknown-profile.json'), JSON.stringify({
    name: 'provider-outage-unknown-profile', description: 'unresolvable profile fixture',
    agents: ['outage-unknown-profile-worker'], transitions: [],
    entryAgent: 'outage-unknown-profile-worker', maxTotalSteps: 3,
  }));
}

function writeProfileFixture(): void {
  fs.mkdirSync(path.dirname(PROFILES_FILE), { recursive: true });
  fs.writeFileSync(PROFILES_FILE, JSON.stringify({
    defaultProfile: 'outage-profile',
    profiles: {
      'outage-profile': {
        model: 'test-model', backend: 'pi', provider: 'provider-a', mode: 'api',
      },
    },
  }));
  profileRepo.invalidate();
}

function writeFixtureConfig(): void {
  writeThreadFixture();
  writeProfileFixture();
  loadConfig();
}

beforeAll(() => {
  writeFixtureConfig();
  initHookBus({ entries: [], hooksDir: CONFIG_DIR });
});

afterEach(async () => {
  attempt.startAttempt.mockReset();
  throttle._testReset();
  resumeRegistry._testReset();
  vi.useRealTimers();
  for (const id of createdThreadIds) {
    const thread = threadStore.get(id);
    if (thread?.workspacePath) cleanupWorkspace(id);
    await threadStore.delete(id);
  }
  createdThreadIds.clear();
  await threadStore.flush();
});

function createOutageThread(outageResumeCount = 0): ThreadRecord {
  const thread = createThread('C-provider-outage', {
    templateName: 'provider-outage',
    userMessage: 'continue durable work',
    userMessageTs: String(Date.now()),
    projectId: 'atlas',
    metadata: { outageResumeCount },
  });
  createdThreadIds.add(thread.id);
  return thread;
}

/** A thread whose only slot names a profile that does not exist — neither the step's own
 *  resolution nor the pause path can name a provider for it. */
function createUnknownProfileThread(): ThreadRecord {
  const thread = createThread('C-provider-outage-unknown', {
    templateName: 'provider-outage-unknown-profile',
    userMessage: 'continue durable work',
    userMessageTs: String(Date.now()),
    projectId: 'atlas',
    metadata: { outageResumeCount: 0 },
  });
  createdThreadIds.add(thread.id);
  return thread;
}

function createFreshOutageThread(): ThreadRecord {
  const thread = createThread('C-provider-outage-fresh', {
    templateName: 'provider-outage-fresh',
    userMessage: 'continue durable work',
    userMessageTs: String(Date.now()),
    projectId: 'atlas',
    metadata: { outageResumeCount: 0 },
  });
  createdThreadIds.add(thread.id);
  return thread;
}

function makeOptions(thread: ThreadRecord): RunThreadOptions {
  return {
    channel: thread.channel,
    startTime: Date.now(),
    stream: adapter.openOutputStream({ type: 'interactive-reply', conduit: thread.channel, sessionId: '' }),
    surface: { onStepStarted() {}, onStepProgress() {} },
  };
}

/** Synthetic `RunAttempt` for the orchestration seam. `startAttempt` now takes a `RunRequest`
 *  plus attempt config; the old handle's `sessionId` is the attempt's `backendSessionId` (which
 *  the run records as its resume target) and the request's `session.backendSessionId`. */
function attemptShell(input: any, backendSessionId: string | null, foreground: Promise<any>) {
  return {
    engine: {
      backend: input?.request?.profile?.backend ?? 'pi',
      identity: 'test-engine',
      capabilities: new Set<string>(),
      backendSessionId,
      run: () => ({}),
      steer: () => ({ accepted: false }),
      ingestExternal: () => false,
      respondToDialog: () => false,
      compact: async () => ({}),
      close: async () => {},
      kill: () => true,
    },
    engineRun: {},
    spec: input?.request?.spec,
    backend: input?.request?.profile?.backend ?? 'pi',
    identity: null,
    foreground,
    settled: foreground,
    backendSessionId,
    kill: () => true,
  };
}

function queueError(failure: string | Error): void {
  const error = typeof failure === 'string' ? new Error(failure) : failure;
  attempt.startAttempt.mockImplementationOnce((input: any) =>
    attemptShell(input, null, Promise.reject(error)));
}

function queueSynchronizedErrors(failures: Error[]): Promise<void> {
  let started = 0;
  let resolveStarted!: () => void;
  const allStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const rejects: Array<(error: Error) => void> = [];
  attempt.startAttempt.mockImplementation((input: any) => attemptShell(
    input, null, new Promise((_, reject) => {
      rejects.push(reject);
      started++;
      if (started === failures.length) resolveStarted();
    }),
  ));
  return allStarted.then(() => {
    rejects.forEach((reject, index) => reject(failures[index]));
  });
}

function queueControlledErrors(count: number): {
  started: Promise<void>;
  reject: (index: number, error: Error) => void;
} {
  let startedCount = 0;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const rejects: Array<(error: Error) => void> = [];
  attempt.startAttempt.mockImplementation((input: any) => attemptShell(
    input, null, new Promise((_, reject) => {
      rejects.push(reject);
      startedCount++;
      if (startedCount === count) resolveStarted();
    }),
  ));
  return { started, reject: (index, error) => rejects[index](error) };
}

/** Interrupted attempt that streamed real activity before failing: the backend session id is
 *  known (pre-minted) and the step produced partial work worth resuming. The old stub called the
 *  facade's `onAssistantMessage` callback; activity now travels the run's event stream, so the
 *  stub feeds a foreground `assistant_text` event into the `onEvent` observer before it rejects. */
function queueActivityError(message: string, sessionId: string): void {
  attempt.startAttempt.mockImplementationOnce((input: any) => {
    input.onEvent({ type: 'assistant_text', text: 'partial work before the outage', phase: 'foreground' });
    return attemptShell(input, sessionId, Promise.reject(new Error(message)));
  });
}

function queueSuccess(output = 'done'): void {
  attempt.startAttempt.mockImplementationOnce((input: any) => attemptShell(
    input, 'provider-session', Promise.resolve({
      sessionId: 'provider-session',
      finalOutput: output,
      total_cost_usd: 0,
      num_turns: 1,
    }),
  ));
}

async function initThrottle(onResume?: (providers: string[]) => void): Promise<void> {
  await throttle.initRateLimitThrottle(adapter, {
    save: async () => {},
    load: async () => null,
  }, onResume);
}

async function initResumeDrain(opts: RunThreadOptions): Promise<{ finished: Promise<void> }> {
  let resolveRerun!: () => void;
  let rejectRerun!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveRerun = resolve;
    rejectRerun = reject;
  });
  await initThrottle(() => {
    void dispatchPendingResumes(adapter, {
      buildResumeOptions: () => opts,
      resumeThread: async (id, resumeOpts) => {
        try {
          await resumeRateLimitedThread(id, resumeOpts);
          resolveRerun();
        } catch (error) {
          rejectRerun(error);
          throw error;
        }
      },
      settleResumedThread: async () => {}, directSessionBusy: () => false,
      track: () => {}, delay: async () => {},
    });
  });
  return { finished };
}

test.each([
  [0, 1, 5],
  [1, 2, 15],
  [2, 3, 45],
])('retryable outage count %i pauses with count %i and %i-minute backoff', async (prior, next, minutes) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));
  await initThrottle();
  const thread = createOutageThread(prior);
  queueError('HTTP 503 Service Unavailable');

  const result = await runThread(thread.id, makeOptions(thread));

  assert.equal(result.thread.status, 'rate_limited');
  assert.equal(result.thread.metadata?.outageResumeCount, next);
  assert.equal(result.thread.metadata?.rateLimitProvider, 'provider-a');
  const persisted = JSON.parse(fs.readFileSync(path.join(STORE_DIR, 'threads.json'), 'utf8'));
  assert.equal(persisted[thread.id].metadata.outageResumeCount, next);
  assert.equal(result.thread.currentStepIndex, 0);
  assert.equal(result.thread.steps.length, 0);
  const state = throttle.getThrottleState();
  const outage = state.providers[0]?.windows.find((window) => window.type === 'outage');
  assert.ok(outage);
  assert.equal(outage.resetsAt * 1000, Date.now() + minutes * 60_000);
  const entries = resumeRegistry.takeAllResumes();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].provider, 'provider-a');
});

test('outage expiry drains the resume queue and reruns the interrupted step', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-07-29T13:00:00.000Z'));
  const thread = createOutageThread();
  const opts = makeOptions(thread);
  const { finished: rerunFinished } = await initResumeDrain(opts);
  queueError('Codex error: You can retry your request.');
  queueSuccess('finished after resume');

  const paused = await runThread(thread.id, opts);
  assert.equal(paused.thread.status, 'rate_limited');
  assert.equal(paused.thread.currentStepIndex, 0);
  assert.equal(resumeRegistry.getResumeCount(), 1);

  await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
  await rerunFinished;

  const completed = threadStore.get(thread.id)!;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.metadata?.outageResumeCount, 1);
  assert.equal(completed.currentStepIndex, 1);
  assert.equal(completed.steps.length, 1);
  assert.equal(completed.steps[0].stepIndex, 0);
  assert.equal(completed.steps[0].output, 'finished after resume');
  assert.equal(resumeRegistry.getResumeCount(), 0);
  assert.equal(attempt.startAttempt.mock.calls.length, 2);
  assert.equal(
    attempt.startAttempt.mock.calls[0][0].request.prompt.text,
    attempt.startAttempt.mock.calls[1][0].request.prompt.text,
  );
});

test('outage rerun resumes the interrupted backend session with a continuation reminder', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-07-30T09:00:00.000Z'));
  const thread = createFreshOutageThread();
  const opts = makeOptions(thread);
  const { finished: rerunFinished } = await initResumeDrain(opts);
  queueActivityError('HTTP 503 Service Unavailable', 'sess-interrupted');
  queueSuccess('finished after resume');

  const paused = await runThread(thread.id, opts);
  assert.equal(paused.thread.status, 'rate_limited');
  const pausedSlot = threadStore.get(thread.id)!.agents['outage-fresh-worker'];
  assert.equal(pausedSlot.interruptedBackendSessionId, 'sess-interrupted', 'interrupted backend session captured for reuse');
  const persisted = JSON.parse(fs.readFileSync(path.join(STORE_DIR, 'threads.json'), 'utf8'));
  assert.equal(persisted[thread.id].agents['outage-fresh-worker'].interruptedBackendSessionId, 'sess-interrupted', 'survives a restart');

  await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
  await rerunFinished;

  const completed = threadStore.get(thread.id)!;
  assert.equal(completed.status, 'completed');
  const [firstCall, secondCall] = attempt.startAttempt.mock.calls;
  assert.equal(secondCall[0].request.session.backendSessionId, 'sess-interrupted', 'rerun resumes the interrupted backend session');
  assert.notEqual(secondCall[0].request.prompt.text, firstCall[0].request.prompt.text, 'rerun does not restart from the original step prompt');
  assert.match(secondCall[0].request.prompt.text, /interrupted by an API error/, 'rerun sends the continuation reminder');
  assert.equal(secondCall[0].request.session.sessionId, firstCall[0].request.session.sessionId, 'UI transcript continues under the same track id');
  assert.equal(completed.agents['outage-fresh-worker'].interruptedBackendSessionId ?? null, null, 'one-shot: consumed by the rerun');
});

test('outage rerun without streamed activity restarts the full step prompt fresh', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-07-30T10:00:00.000Z'));
  const thread = createFreshOutageThread();
  const opts = makeOptions(thread);
  const { finished: rerunFinished } = await initResumeDrain(opts);
  // Backend session id known but the attempt died before ANY streamed activity: nothing worth
  // resuming (and the backend session file may not even exist) — keep the full-rerun path.
  attempt.startAttempt.mockImplementationOnce((input: any) => attemptShell(
    input, 'sess-dead-on-arrival', Promise.reject(new Error('HTTP 503 Service Unavailable'))));
  queueSuccess('finished after fresh rerun');

  const paused = await runThread(thread.id, opts);
  assert.equal(paused.thread.status, 'rate_limited');
  assert.equal(threadStore.get(thread.id)!.agents['outage-fresh-worker'].interruptedBackendSessionId ?? null, null);

  await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
  await rerunFinished;

  assert.equal(threadStore.get(thread.id)!.status, 'completed');
  const [firstCall, secondCall] = attempt.startAttempt.mock.calls;
  assert.equal(secondCall[0].request.prompt.text, firstCall[0].request.prompt.text, 'rerun repeats the original step prompt');
  assert.equal(secondCall[0].request.session.backendSessionId, null, 'non-persist slot starts a fresh backend session');
});

test('continueThread on an interrupted pause delivers the new user message with the reminder', async () => {
  await initThrottle();
  const thread = createFreshOutageThread();
  const opts = makeOptions(thread);
  queueActivityError('HTTP 503 Service Unavailable', 'sess-interrupted-2');
  queueSuccess('done after user nudge');

  const paused = await runThread(thread.id, opts);
  assert.equal(paused.thread.status, 'rate_limited');

  // The pause opened an outage window on this step's provider, and a thread step is never
  // user-initiated — so the run's pre-flight would skip the continue without ever reaching a
  // backend (the same gate the old facade applied, one layer further in). Clear the window: this
  // case is about the PROMPT a manual continue builds, not about the gate.
  await throttle.clearThrottle('provider-a');

  await continueThread(thread.id, 'also handle the edge case', opts);

  const secondCall = attempt.startAttempt.mock.calls[1];
  assert.equal(secondCall[0].request.session.backendSessionId, 'sess-interrupted-2', 'manual continue also resumes the interrupted session');
  assert.match(secondCall[0].request.prompt.text, /interrupted by an API error/, 'continuation reminder kept');
  assert.match(secondCall[0].request.prompt.text, /also handle the edge case/, 'new user input delivered alongside the reminder');
});

test('buildStepPrompt interrupted resume sends the reminder plus buffered replies, not the step prompt', async () => {
  const thread = createOutageThread();
  await threadStore.mutate(thread.id, (record) => {
    record.metadata!.pendingMessages = ['buffered reply while paused'];
  });
  const agentConfig = resolveAgentSlotConfig('outage-worker')!;

  const prompt = buildStepPrompt(thread.id, agentConfig, null, { interruptedResume: true });

  assert.match(prompt, /interrupted by an API error/, 'reminder body');
  assert.match(prompt, /buffered reply while paused/, 'pending user replies still appended');
  assert.doesNotMatch(prompt, /continue durable work/, 'original step input not re-sent');
});

test('unresolvable active-step profile falls back to a null provider', async () => {
  await initThrottle();
  const thread = createUnknownProfileThread();
  queueError('HTTP 503 Service Unavailable');

  const paused = await runThread(thread.id, makeOptions(thread));

  assert.equal(paused.thread.status, 'rate_limited');
  assert.equal(paused.thread.metadata?.rateLimitProvider, null);
  assert.equal(throttle.getThrottleState().providers[0].provider, 'unknown');
  const entries = resumeRegistry.takeAllResumes();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].provider, null);
});

test('outage persistence failure rolls back the claim and fails with the original error', async () => {
  const persistenceError = new Error('throttle store unavailable');
  await throttle.initRateLimitThrottle(adapter, {
    save: async (state) => {
      if (state) throw persistenceError;
    },
    load: async () => null,
  });
  const thread = createOutageThread();
  const providerError = new Error('HTTP 503 Service Unavailable');
  queueError(providerError);

  await assert.rejects(() => runThread(thread.id, makeOptions(thread)), (error: Error & { cause?: unknown }) => {
    assert.equal(error, providerError);
    assert.equal(error.cause, persistenceError);
    return true;
  });

  const failed = threadStore.get(thread.id)!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.metadata?.outageResumeCount, 0);
  assert.match(failed.error ?? '', /HTTP 503 Service Unavailable/);
  assert.match(failed.error ?? '', /throttle store unavailable/);
  assert.equal(throttle.getThrottleState().providers.length, 0);
  assert.equal(resumeRegistry.getResumeCount(), 0);
});

test('concurrent transient failures claim distinct retry counts', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-07-29T14:00:00.000Z'));
  await initThrottle();
  const thread = createOutageThread();
  const releaseErrors = queueSynchronizedErrors([
    new Error('HTTP 503 first concurrent failure'),
    new Error('HTTP 503 second concurrent failure'),
  ]);

  const runs = [
    runThread(thread.id, makeOptions(thread)),
    runThread(thread.id, makeOptions(thread)),
  ];
  await releaseErrors;
  const results = await Promise.allSettled(runs);

  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
  const paused = threadStore.get(thread.id)!;
  assert.equal(paused.status, 'rate_limited');
  assert.equal(paused.metadata?.outageResumeCount, 2);
  const outage = throttle.getThrottleState().providers[0]?.windows
    .find((window) => window.type === 'outage');
  assert.equal(outage?.resetsAt * 1000, Date.now() + 15 * 60_000);
  assert.equal(resumeRegistry.getResumeCount(), 1);
});

test('concurrent fourth failure keeps a pending third retry terminal', async () => {
  await initThrottle();
  const thread = createOutageThread(2);
  const releaseErrors = queueSynchronizedErrors([
    new Error('HTTP 503 allowed third retry'),
    new Error('HTTP 503 terminal fourth failure'),
  ]);

  const runs = [
    runThread(thread.id, makeOptions(thread)),
    runThread(thread.id, makeOptions(thread)),
  ];
  await releaseErrors;
  const results = await Promise.allSettled(runs);

  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
  const failed = threadStore.get(thread.id)!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.metadata?.outageResumeCount, 3);
  assert.equal(resumeRegistry.getResumeCount(), 0);
});

test('late concurrent fourth failure overrides an already-paused third retry', async () => {
  await initThrottle();
  const thread = createOutageThread(2);
  const controlled = queueControlledErrors(2);
  const thirdRun = runThread(thread.id, makeOptions(thread));
  const fourthRun = runThread(thread.id, makeOptions(thread));
  await controlled.started;

  controlled.reject(0, new Error('HTTP 503 allowed third retry'));
  await thirdRun;
  assert.equal(threadStore.get(thread.id)?.status, 'rate_limited');
  assert.equal(resumeRegistry.getResumeCount(), 1);

  controlled.reject(1, new Error('HTTP 503 late terminal fourth failure'));
  await assert.rejects(fourthRun, /late terminal fourth failure/);

  const failed = threadStore.get(thread.id)!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.metadata?.outageResumeCount, 3);
  assert.equal(resumeRegistry.getResumeCount(), 0);
});

test('fourth retryable outage fails the thread without another pause', async () => {
  await initThrottle();
  const thread = createOutageThread(3);
  queueError('HTTP 503 Service Unavailable');

  await assert.rejects(() => runThread(thread.id, makeOptions(thread)), /503/);

  const failed = threadStore.get(thread.id)!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.metadata?.outageResumeCount, 3);
  assert.equal(resumeRegistry.getResumeCount(), 0);
  assert.equal(throttle.getThrottleState().providers.length, 0);
});

test('permanent provider errors bypass pause even while a throttle is active', async () => {
  await initThrottle();
  // Throttled: some OTHER provider. The global throttle is what this case is about — a permanent
  // error must not be diverted into the outage machinery just because a window is open somewhere.
  // Blocking this step's own provider would be a different case entirely: the run's pre-flight
  // never spawns at all (see the test below), so no error of any kind could be raised.
  await throttle.handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.99, resetsAt: Math.floor(Date.now() / 1000) + 300 },
    { provider: 'provider-b', displayName: 'Provider B', mode: 'api' },
  );
  const thread = createOutageThread();
  queueError('insufficient balance: billing quota exhausted');

  await assert.rejects(() => runThread(thread.id, makeOptions(thread)), /billing quota exhausted/);

  const failed = threadStore.get(thread.id)!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.metadata?.outageResumeCount, 0);
  assert.equal(resumeRegistry.getResumeCount(), 0);
});

test('a step whose own provider is throttled pauses without spawning a backend', async () => {
  await initThrottle();
  await throttle.handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.99, resetsAt: Math.floor(Date.now() / 1000) + 300 },
    { provider: 'provider-a', displayName: 'Provider A', mode: 'api' },
  );
  const thread = createOutageThread();
  queueError('this attempt must never be made');

  const paused = await runThread(thread.id, makeOptions(thread));

  // The run's pre-flight refuses an attempt whose provider is already known blocked, and nothing
  // is user-initiated about a thread step. The refusal IS the step's result: the thread pauses for
  // auto-resume and the queued failure was never consumed.
  assert.equal(paused.thread.status, 'rate_limited');
  assert.equal(attempt.startAttempt.mock.calls.length, 0, 'no backend was ever opened');
  assert.equal(paused.thread.metadata?.rateLimitProvider, 'provider-a');
});
