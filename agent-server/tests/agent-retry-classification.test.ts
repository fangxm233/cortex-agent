// input:  retry config, auth events, a scripted Claude child + fake PI runtime, throttle
// output: retry, auth lifecycle, outage, cancellation, and notice tests through the run seam
// pos:    Provider retry and terminal authentication tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// This file used to spy on `getRunAdapter(backend).spawn` (now dead) to script failures per run.
// It now drives the front door production uses — `AgentRunImpl` over the engine seam — with a
// scripted Claude CLI child (`request.isolation.spawner`) and `pi-fake-runtime` for PI. The pool is
// the daemon singleton, replaced here by a `SessionEngines` over a real `ClaudeAdapter` and a
// fake-runtime `PIAdapter`. The classification matrix itself (retryable / auth / outage /
// cancelled / rate-limited) is unchanged; only the way a backend outcome is staged has changed.

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFileSync } from 'node:fs';

import { isRetryableError, allConfigsRateLimited } from '../src/domain/runs/fallback.js';
import { AgentRunImpl } from '../src/domain/runs/run.js';
import type { RunRequest, RunObserver, RunResult } from '../src/domain/runs/request.js';
import type { RunEvent } from '../src/agent-adapter/run-events.js';
import type { RunAttemptConfig } from '../src/domain/agents/profile-manager.js';
import { EventBus } from '../src/events/event-bus.js';
import type { AuthErrorKind, CortexEvent } from '../src/events/index.js';
import { classifyAuthError, initAuthEvents } from '../src/domain/auth/auth-events.js';
import { profileRepo, PROFILES_FILE } from '../src/store/profile-repo.js';
import {
  activateOutageWindow,
  handleRateLimitEvent,
  initRateLimitThrottle,
  _testReset as throttleReset,
} from '../src/domain/costs/rate-limit-throttle.js';
import { MockAdapter } from '../src/platform/testing.js';
import { RunRegistry } from '../src/core/run-registry.js';
import { runRequestFixture, attemptFromFixture, attemptFixture, type RunRequestFixtureInput } from './run-request-fixture.js';
import { makeFakeRuntimeFactory } from './agent-adapter/pi-fake-runtime.js';

type FakeRuntimeFactory = ReturnType<typeof makeFakeRuntimeFactory>;

const PI: Partial<RunAttemptConfig> = { backend: 'pi', mode: 'deepseek' };
const CLAUDE: Partial<RunAttemptConfig> = { backend: 'claude', mode: 'plan' };

const fixtures = vi.hoisted(() => ({
  current: null as unknown as FakeRuntimeFactory,
  engines: null as unknown as import('../src/domain/runs/engines.js').SessionEngines,
}));

vi.mock('../src/domain/runs/engines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/domain/runs/engines.js')>();
  const { tmpdir: dir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdirSync } = await import('node:fs');
  const { PIAdapter } = await import('../src/agent-adapter/pi/adapter.js');
  const { ClaudeAdapter } = await import('../src/agent-adapter/claude/adapter.js');
  const { makeFakeRuntimeFactory: makeFake } = await import('./agent-adapter/pi-fake-runtime.js');
  const sessionDir = join(dir(), `agent-retry-classification-sessions-${process.pid}`);
  mkdirSync(sessionDir, { recursive: true });
  const delegating = (request: unknown, callbacks: unknown) =>
    fixtures.current.factory(request as never, callbacks as never);
  fixtures.engines = new actual.SessionEngines({
    pi: new PIAdapter(delegating as never, sessionDir),
    claude: new ClaudeAdapter(),
  });
  return { ...actual, engines: fixtures.engines };
});

// --- scripted backends -------------------------------------------------------------------------

const spawnedChildren: any[] = [];

function scriptedChild(scripts: unknown[][] = []) {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.emitLines = (lines: unknown[]) => {
    for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
  };
  const queue = [...scripts];
  child.stdin.on('data', () => {
    const next = queue.shift();
    if (next) setImmediate(() => child.emitLines(next));
  });
  spawnedChildren.push(child);
  return child;
}

const textLine = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const resultLine = (overrides: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false,
  num_turns: 1, total_cost_usd: 0, session_id: 'fixture-session', result: 'fallback-ok', ...overrides,
});
const errorScript = (message: string) => [
  resultLine({ subtype: 'error', is_error: true, result: message }),
];
const rateLimitScript = [
  resultLine({ subtype: 'error', is_error: true, result: 'rate limit exceeded' }),
];

// --- run helpers -------------------------------------------------------------------------------

function openRun(request: RunRequest, observers: RunObserver[]): AgentRunImpl {
  const run = new AgentRunImpl({
    request, observers, executionId: 'exec-fixture',
    registry: new RunRegistry(), onTerminal: () => {}, startedAt: Date.now(),
  });
  run.start();
  return run;
}

interface Collected {
  observer: RunObserver;
  events: RunEvent[];
  closes(): number;
}

function collector(required = false): Collected {
  const events: RunEvent[] = [];
  let closed = 0;
  return {
    observer: { required, onEvent: (event) => { events.push(event); }, onClose: () => { closed += 1; } },
    events,
    closes: () => closed,
  };
}

function notices(events: RunEvent[]): Array<{ text: string; level?: string }> {
  return events
    .filter((event): event is Extract<RunEvent, { type: 'assistant_text' }> => event.type === 'assistant_text')
    .map((event) => ({ text: event.text, level: event.noticeLevel }));
}

function claudeRequestWithScript(
  partial: RunRequestFixtureInput,
  line: unknown | unknown[],
  override: Partial<RunAttemptConfig> = CLAUDE,
): RunRequest {
  // A single line is the common case; an array stages a whole turn. A successful Claude turn's
  // `finalOutput` is its assistant prose, not the `result` line's `result` field, so a turn whose
  // output is asserted must carry the assistant text too.
  const turn = Array.isArray(line) ? line : [line];
  const request = runRequestFixture({
    ...partial,
    processSpawner: (() => ({ process: scriptedChild([turn]) })) as never,
  }, override);
  return request;
}

/** Fill the request's profile fallback chain (the flat fixture only produces a one-attempt head). */
function withFallback(request: RunRequest, fallback: RunAttemptConfig): RunRequest {
  request.profile = { ...request.profile, fallback: [fallback] };
  return request;
}

// --- profile fixtures (only used by allConfigsRateLimited) -------------------------------------

function installSingleProfile(): void {
  writeFileSync(PROFILES_FILE, JSON.stringify({
    defaultProfile: 'single-test',
    profiles: {
      'single-test': {
        model: 'deepseek-v4-pro', backend: 'pi', provider: 'deepseek', mode: 'deepseek',
      },
    },
  }));
  profileRepo.invalidate();
}

// --- throttle fixtures -------------------------------------------------------------------------

async function initProviderThrottle(): Promise<void> {
  throttleReset();
  await initRateLimitThrottle(new MockAdapter({ adminChannel: 'admin' }) as any, {
    save: async () => {},
    load: async () => null,
  });
}

async function activateProviderThrottle(provider = 'deepseek'): Promise<void> {
  await initProviderThrottle();
  await handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: Math.floor(Date.now() / 1000) + 300 },
    { provider, displayName: provider, mode: 'deepseek' },
  );
}

async function activateProviderOutage(provider = 'deepseek'): Promise<void> {
  await initProviderThrottle();
  await activateOutageWindow(provider, 5 * 60_000);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The classification matrix — pure functions (unchanged subject, now imported from fallback.ts)
// ════════════════════════════════════════════════════════════════════════════════════════════════

for (const message of [
  '502: {"message":"Upstream connection error: TypeError: fetch failed"}',
  'HTTP 408 Request Timeout',
  'status code 500: internal server error',
  'HTTP 503 Service Unavailable',
  'HTTP 504 Gateway Timeout',
  'read ECONNRESET',
  'connect ECONNREFUSED 127.0.0.1:443',
  'getaddrinfo EAI_AGAIN api.deepseek.com',
  'network request timed out',
  'Codex error: An error occurred while processing your request. You can retry your request. Request ID: req_123',
  // PI's own wording for a failed provider round trip. It matched nothing before, so a paid
  // benchmark trial recorded seven of these as ordinary failures and retried none of them.
  'Connection error.',
]) {
  test(`isRetryableError accepts transient failure: ${message}`, () => {
    assert.equal(isRetryableError(new Error(message)), true);
  });
}

for (const message of [
  'Please run /login',
  'OAuth token has expired',
  'authentication_error',
  'invalid x-api-key',
  'HTTP 401: token rejected. You can retry your request.',
  'invalid_grant',
]) {
  test(`isRetryableError keeps authentication failure non-retryable: ${message}`, () => {
    assert.equal(isRetryableError(new Error(message)), false);
  });
}

const PRE_SPLIT_PERMANENT_CASES: Array<{
  message: string;
  authKind: AuthErrorKind | null;
}> = [
  { message: 'invalid_request', authKind: null },
  { message: 'unauthorized upstream connection error', authKind: 'unauthorized' },
  { message: 'connection timed out during authentication', authKind: 'invalid_api_key' },
  { message: 'authentication service upstream connection error', authKind: 'invalid_api_key' },
  { message: 'authentication failed', authKind: 'invalid_api_key' },
  { message: 'Authentication error: token expired', authKind: 'invalid_api_key' },
  { message: 'forbidden', authKind: null },
  { message: 'model not found', authKind: null },
  { message: 'request body too large', authKind: null },
  { message: 'context window exceeded', authKind: null },
  { message: 'insufficient_balance', authKind: null },
  { message: 'billing unavailable', authKind: null },
  { message: 'quota exhausted', authKind: null },
];

for (const { message, authKind } of PRE_SPLIT_PERMANENT_CASES) {
  test(`preserves pre-split permanent handling: ${message}`, () => {
    const classified = classifyAuthError(message);
    const retryable = isRetryableError(new Error(message));
    assert.equal(!retryable || classified !== null, true);
    if (authKind) {
      assert.equal(classified, authKind);
      assert.equal(retryable, false);
    }
  });
}

for (const message of [
  'HTTP 400 invalid request',
  'HTTP 403 forbidden',
  'HTTP 404 model not found',
  'request body too large',
  'context window exceeded',
  'insufficient balance: billing quota exhausted',
  'processed 500 input tokens successfully',
]) {
  test(`isRetryableError rejects deterministic failure: ${message}`, () => {
    assert.equal(isRetryableError(new Error(message)), false);
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Auth lifecycle through a real run
// ════════════════════════════════════════════════════════════════════════════════════════════════

interface AuthBackendCase {
  backend: 'claude' | 'pi';
  provider?: string;
  expectedProvider: string;
  message: string;
  kind: AuthErrorKind;
}

type RequiredEvent = Extract<CortexEvent, { type: 'auth.required' }>;
type RecoveredEvent = Extract<CortexEvent, { type: 'auth.recovered' }>;

interface AuthRunHarness {
  authError: Error;
  nonAuthError: Error;
  required: RequiredEvent[];
  recovered: RecoveredEvent[];
  spawnCount(): number;
  runNext(): Promise<RunResult>;
}

afterEach(async () => {
  for (const key of fixtures.engines.listKeys()) await fixtures.engines.close(key);
  for (const child of spawnedChildren.splice(0)) child.emit('close', 0);
});

afterEach(() => initAuthEvents(null));

const AUTH_BACKEND_CASES: AuthBackendCase[] = [
  {
    backend: 'claude', expectedProvider: 'anthropic',
    message: 'Please run /login: credential-fragment-claude', kind: 'login_required',
  },
  {
    backend: 'pi', provider: 'deepseek', expectedProvider: 'deepseek',
    message: 'authentication failed: credential-fragment-pi', kind: 'invalid_api_key',
  },
];

type AuthOutcome =
  | { kind: 'error'; message: string }
  | { kind: 'rate-limit-result' }
  | { kind: 'success' };

function piRuntimeOutcome(runtime: import('./agent-adapter/pi-fake-runtime.js').FakeRuntime, outcome: AuthOutcome): void {
  runtime.emitAgentStart();
  if (outcome.kind === 'error') {
    runtime.emitAgentEnd({ stopReason: 'error', errorMessage: outcome.message });
  } else {
    runtime.emitAgentEnd();
  }
}

function createAuthRunHarness(authCase: AuthBackendCase): AuthRunHarness {
  fixtures.current = makeFakeRuntimeFactory({ sessionId: `pi-auth-${authCase.backend}` });
  const bus = new EventBus();
  const required: RequiredEvent[] = [];
  const recovered: RecoveredEvent[] = [];
  bus.subscribe('auth.required', (event) => { required.push(event); });
  bus.subscribe('auth.recovered', (event) => { recovered.push(event); });
  initAuthEvents(bus);

  const authError = new Error(authCase.message);
  const nonAuthError = new Error('context window exceeded');
  const outcomes: AuthOutcome[] = [
    { kind: 'error', message: authCase.message },
    { kind: 'error', message: nonAuthError.message },
    // Claude can resolve a rate-limited RESULT; PI has no such result, so it stages the same
    // "retryable, not a recovery" outcome as a thrown 429.
    authCase.backend === 'claude' ? { kind: 'rate-limit-result' } : { kind: 'error', message: 'rate limit exceeded' },
    { kind: 'success' },
    { kind: 'success' },
  ];
  const children: any[] = [];
  let index = 0;

  return {
    authError, nonAuthError, required, recovered,
    spawnCount: () => (authCase.backend === 'claude' ? children.length : fixtures.current.runtimes.length),
    async runNext(): Promise<RunResult> {
      const outcome = outcomes[index];
      const sessionKey = `auth-${authCase.backend}-${index}`;
      const partial: RunRequestFixtureInput = {
        channel: `web:auth-${authCase.backend}`,
        trackSessionId: `track-${authCase.backend}`,
        sessionKey,
        ...(authCase.backend === 'pi' ? { piProvider: authCase.provider } : {}),
      };
      const request = authCase.backend === 'claude'
        ? claudeRequestWithScript(partial, outcome.kind === 'error'
          ? errorScript(outcome.message)[0]
          : outcome.kind === 'rate-limit-result' ? rateLimitScript[0] : resultLine())
        : runRequestFixture(partial, PI);
      const run = openRun(request, [collector().observer]);
      if (authCase.backend === 'claude') {
        children.push(spawnedChildren[spawnedChildren.length - 1]);
      } else {
        const runtime = await fixtures.current.runtime(index);
        await runtime.nextCall('prompt');
        piRuntimeOutcome(runtime, outcome);
      }
      index += 1;
      return run.settled;
    },
  };
}

async function assertInitialAuthFailure(h: AuthRunHarness, authCase: AuthBackendCase): Promise<void> {
  await assert.rejects(h.runNext(), (caught: Error) => caught.message === h.authError.message);
  assert.equal(h.spawnCount(), 1);
  assert.equal(h.required.length, 1);
  const { ts: _requiredTs, ...payload } = h.required[0];
  assert.deepEqual(payload, {
    type: 'auth.required', backend: authCase.backend, provider: authCase.expectedProvider,
    authType: null, kind: authCase.kind, channel: `web:auth-${authCase.backend}`,
    sessionId: `track-${authCase.backend}`,
  });
  assert.equal(JSON.stringify(h.required[0]).includes('credential-fragment'), false);
}

async function assertPendingAcrossOtherFailures(h: AuthRunHarness): Promise<void> {
  await assert.rejects(h.runNext(), (caught: Error) => caught.message === h.nonAuthError.message);
  assert.equal(h.required.length, 1);
  assert.deepEqual(h.recovered, []);
  // Whatever the retryable outcome resolves or rejects with, it is not a recovery.
  await h.runNext().catch(() => undefined);
  assert.deepEqual(h.recovered, []);
}

async function assertSingleRecovery(h: AuthRunHarness, authCase: AuthBackendCase): Promise<void> {
  await h.runNext();
  assert.equal(h.recovered.length, 1);
  const { ts: _recoveredTs, ...payload } = h.recovered[0];
  assert.deepEqual(payload, {
    type: 'auth.recovered', backend: authCase.backend, provider: authCase.expectedProvider,
  });
  await h.runNext();
  assert.equal(h.recovered.length, 1);
  assert.equal(h.spawnCount(), 5);
}

for (const authCase of AUTH_BACKEND_CASES) {
  test(`run publishes auth required and recovered through the ${authCase.backend} engine path`, async () => {
    const harness = createAuthRunHarness(authCase);
    await assertInitialAuthFailure(harness, authCase);
    await assertPendingAcrossOtherFailures(harness);
    await assertSingleRecovery(harness, authCase);
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Fallback, notices, outage and cancellation
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('run falls back after PI exhausts a generic provider-retry error', async () => {
  fixtures.current = (await import('./agent-adapter/pi-fake-runtime.js')).makeFakeRuntimeFactory({ sessionId: 'pi-primary' });
  const fallbackAttempt = attemptFixture({ model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' });
  const request = withFallback(
    claudeRequestWithScript(
      { channel: 'web:retry', sessionKey: 'fallback-chain', piProvider: 'deepseek' },
      [textLine('fallback-ok'), resultLine({ result: 'fallback-ok', session_id: 'claude-fallback' })],
    ),
    fallbackAttempt,
  );
  // The request carries the PI head; the profile is the PI profile with a Claude fallback.
  request.profile = {
    ...request.profile,
    model: 'deepseek-v4-pro', backend: 'pi', provider: 'deepseek', mode: 'deepseek',
    fallback: [fallbackAttempt],
  };
  const seen = collector();
  const run = openRun(request, [seen.observer]);

  const runtime = await fixtures.current.runtime(0);
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  runtime.emitAgentEnd({
    stopReason: 'error',
    errorMessage: 'Codex error: An error occurred while processing your request. You can retry your request. Request ID: req_123',
  });

  const result = await run.settled;

  assert.equal(result.finalOutput, 'fallback-ok');
  assert.equal(fixtures.current.runtimes.length, 1, 'one PI attempt');
  assert.equal(spawnedChildren.length, 1, 'one Claude fallback attempt');
  assert.deepEqual(
    seen.events.filter((event) => event.type === 'run_fallback').map((event) => (event as Extract<RunEvent, { type: 'run_fallback' }>)),
    [{ type: 'run_fallback', from: 'deepseek-v4-pro/deepseek', to: 'claude-sonnet-4-6/plan', reason: 'rate-limited' }],
  );
  assert.deepEqual(notices(seen.events), [{
    text: 'Model fallback: deepseek-v4-pro/deepseek → claude-sonnet-4-6/plan.',
    level: 'warning',
  }, {
    // The fallback attempt's own assistant prose is a notice too; the real backend streams it
    // (its `finalOutput` is that prose, not the result line's `result` field).
    text: 'fallback-ok',
    level: undefined,
  }]);
});

test('run emits one terminal error notice for a deterministic authentication failure', async () => {
  fixtures.current = (await import('./agent-adapter/pi-fake-runtime.js')).makeFakeRuntimeFactory({ sessionId: 'pi-auth-terminal' });
  const request = runRequestFixture({ channel: 'web:retry', sessionKey: 'auth-terminal', piProvider: 'deepseek' }, PI);
  withFallback(request, attemptFixture({ model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' }));
  const seen = collector();
  const run = openRun(request, [seen.observer]);

  const runtime = await fixtures.current.runtime(0);
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  runtime.emitAgentEnd({ stopReason: 'error', errorMessage: 'HTTP 401 unauthorized' });

  await assert.rejects(run.settled, /401 unauthorized/);
  assert.equal(spawnedChildren.length, 0, 'a deterministic failure does not touch the fallback');
  assert.deepEqual(notices(seen.events), [{ text: 'Error: HTTP 401 unauthorized', level: 'error' }]);
});

test('provider outage gates automated configs but not direct interactive sessions', async (t) => {
  installSingleProfile();
  await activateProviderOutage();
  t.onTestFinished(() => throttleReset());

  assert.equal(allConfigsRateLimited('single-test'), true);
  fixtures.current = (await import('./agent-adapter/pi-fake-runtime.js')).makeFakeRuntimeFactory({ sessionId: 'pi-outage' });
  const request = runRequestFixture({
    channel: 'web:retry', sessionKey: 'outage-interactive', piProvider: 'deepseek', isUserInitiated: true,
  }, PI);
  const run = openRun(request, [collector().observer]);
  const runtime = await fixtures.current.runtime(0);
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  runtime.emitAgentEnd();

  const result = await run.settled;
  assert.equal(fixtures.current.runtimes.length, 1, 'a user-initiated run spawns despite the outage');
  assert.equal(result.sessionId, 'pi-outage');
});

test('run shows a warning when a user chat rate-limit result will auto-resume', async (t) => {
  installSingleProfile();
  await activateProviderThrottle('anthropic');
  t.onTestFinished(() => throttleReset());
  const request = claudeRequestWithScript(
    { channel: 'web:retry', sessionKey: 'rl-result', isUserInitiated: true }, rateLimitScript[0],
  );
  const seen = collector();
  const run = openRun(request, [seen.observer]);

  const result = await run.settled;
  assert.equal(result.rateLimited, true);
  assert.deepEqual(notices(seen.events), [{
    text: 'Rate limited — this chat will resume automatically when the limit resets.',
    level: 'warning',
  }]);
});

test('run shows the auto-resume warning for a thrown user-chat rate-limit error', async (t) => {
  fixtures.current = (await import('./agent-adapter/pi-fake-runtime.js')).makeFakeRuntimeFactory({ sessionId: 'pi-rl-throw' });
  await activateProviderThrottle('deepseek');
  t.onTestFinished(() => throttleReset());
  const request = runRequestFixture({
    channel: 'web:retry', sessionKey: 'rl-throw', piProvider: 'deepseek', isUserInitiated: true,
  }, PI);
  const seen = collector();
  const run = openRun(request, [seen.observer]);

  const runtime = await fixtures.current.runtime(0);
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  runtime.emitAgentEnd({ stopReason: 'error', errorMessage: 'HTTP 429 rate limit exceeded' });

  await assert.rejects(run.settled, /rate limit exceeded/);
  assert.deepEqual(notices(seen.events), [{
    text: 'Rate limited — this chat will resume automatically when the limit resets.',
    level: 'warning',
  }]);
});

test('run keeps a non-resumable rate-limit result as an error notice', async (t) => {
  throttleReset();
  t.onTestFinished(() => throttleReset());
  const request = claudeRequestWithScript(
    { channel: 'web:retry', sessionKey: 'rl-no-throttle' }, rateLimitScript[0],
  );
  const seen = collector();
  const run = openRun(request, [seen.observer]);
  await run.settled;

  assert.deepEqual(notices(seen.events), [{ text: 'Rate limited', level: 'error' }]);
});

test('run does not duplicate an API Error event when the attempt terminates with the same error', async () => {
  fixtures.current = (await import('./agent-adapter/pi-fake-runtime.js')).makeFakeRuntimeFactory({ sessionId: 'pi-api-error' });
  const message = 'API Error: 400 invalid_request';
  const request = runRequestFixture({ channel: 'web:retry', sessionKey: 'api-error-dedupe', piProvider: 'deepseek' }, PI);
  const seen = collector();
  const run = openRun(request, [seen.observer]);

  const runtime = await fixtures.current.runtime(0);
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  runtime.emitAssistantText(message);
  runtime.emitAgentEnd({ stopReason: 'error', errorMessage: message });

  await assert.rejects(run.settled, /invalid_request/);
  assert.equal(spawnedChildren.length, 0, 'the non-retryable error does not reach the fallback');
  assert.deepEqual(notices(seen.events), [{ text: message, level: 'error' }]);
});

test('run resets terminal-error deduplication when moving to a fallback attempt', async () => {
  fixtures.current = (await import('./agent-adapter/pi-fake-runtime.js')).makeFakeRuntimeFactory({ sessionId: 'pi-dedupe' });
  const firstError = 'API Error: Unable to connect to API (ECONNRESET)';
  const fallbackAttempt = attemptFixture({ model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' });
  const request = claudeRequestWithScript(
    { channel: 'web:retry', sessionKey: 'dedupe-reset' }, errorScript('HTTP 401 unauthorized')[0],
  );
  request.profile = {
    ...request.profile, model: 'deepseek-v4-pro', backend: 'pi', provider: 'deepseek', mode: 'deepseek',
    fallback: [fallbackAttempt],
  };
  const seen = collector();
  const run = openRun(request, [seen.observer]);

  const runtime = await fixtures.current.runtime(0);
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  runtime.emitAssistantText(firstError);
  runtime.emitAgentEnd({ stopReason: 'error', errorMessage: firstError });

  await assert.rejects(run.settled, /401 unauthorized/);
  assert.deepEqual(notices(seen.events), [
    { text: firstError, level: 'error' },
    { text: 'Model fallback: deepseek-v4-pro/deepseek → claude-sonnet-4-6/plan.', level: 'warning' },
    { text: 'Error: HTTP 401 unauthorized', level: 'error' },
  ]);
});

test('run single-config kill suppresses a generic process-exit error notice', async () => {
  fixtures.current = (await import('./agent-adapter/pi-fake-runtime.js')).makeFakeRuntimeFactory({ sessionId: 'pi-kill' });
  const request = runRequestFixture({ channel: 'web:retry', sessionKey: 'kill-suppress', piProvider: 'deepseek' }, PI);
  const seen = collector();
  const run = openRun(request, [seen.observer]);
  run.cancel('user');

  await assert.rejects(run.settled);
  assert.deepEqual(notices(seen.events), []);
});

test('run does not synthesize terminal chat notices for non-Web channels', async () => {
  fixtures.current = (await import('./agent-adapter/pi-fake-runtime.js')).makeFakeRuntimeFactory({ sessionId: 'pi-slack' });
  const request = runRequestFixture({ channel: 'slack:C1', sessionKey: 'slack-terminal', piProvider: 'deepseek' }, PI);
  const seen = collector();
  const run = openRun(request, [seen.observer]);

  const runtime = await fixtures.current.runtime(0);
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  runtime.emitAgentEnd({ stopReason: 'error', errorMessage: 'HTTP 401 unauthorized' });

  await assert.rejects(run.settled, /401 unauthorized/);
  assert.deepEqual(notices(seen.events), []);
});

test('run does not turn user cancellation into an error notice', async () => {
  fixtures.current = (await import('./agent-adapter/pi-fake-runtime.js')).makeFakeRuntimeFactory({ sessionId: 'pi-cancel' });
  const request = runRequestFixture({ channel: 'web:retry', sessionKey: 'cancel-notice', piProvider: 'deepseek' }, PI);
  const seen = collector();
  const run = openRun(request, [seen.observer]);
  run.cancel('user');

  await assert.rejects(run.settled, /cancelled/i);
  assert.deepEqual(notices(seen.events), []);
});
