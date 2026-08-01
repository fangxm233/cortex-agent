// input:  retry config, auth events, facade, stub processes
// output: retry, auth lifecycle, outage, and notice tests
// pos:    Provider retry and terminal authentication tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { isRetryableError } from '../src/domain/agents/config.js';
import { allConfigsRateLimited, runAgent } from '../src/domain/agents/facade.js';
import { getAdapter } from '../src/agent-adapter/index.js';
import type { AgentProcess, Backend } from '../src/agent-adapter/types.js';
import type { AgentResult } from '../src/core/types/agent-types.js';
import { EventBus } from '../src/events/event-bus.js';
import type { AuthErrorKind, CortexEvent } from '../src/events/index.js';
import { initAuthEvents } from '../src/domain/auth/auth-events.js';
import { profileRepo, PROFILES_FILE } from '../src/store/profile-repo.js';
import {
  activateOutageWindow,
  handleRateLimitEvent,
  initRateLimitThrottle,
  _testReset as throttleReset,
} from '../src/domain/costs/rate-limit-throttle.js';
import { MockAdapter } from '../src/platform/testing.js';

const SUCCESS_RESULT: AgentResult = {
  sessionId: 'fallback-session',
  total_cost_usd: 0,
  num_turns: 1,
  rateLimited: false,
  rateLimitMessage: null,
  planFilePath: null,
  enteredPlanMode: false,
  exitedPlanMode: false,
  finalOutput: 'fallback-ok',
};

const RATE_LIMIT_RESULT: AgentResult = {
  ...SUCCESS_RESULT,
  rateLimited: true,
  rateLimitMessage: 'rate limit exceeded',
  finalOutput: null,
};

function makeProcess(
  outcome: AgentResult | (Error & { cancelled?: boolean }),
  events: Array<{ type: 'assistant_text'; text: string }> = [],
  eventTiming: 'before-result' | 'after-result' = 'before-result',
): AgentProcess {
  return {
    sessionKey: 'retry-test',
    sessionId: null,
    send: async () => {
      if (outcome instanceof Error) {
        if (eventTiming === 'before-result') await new Promise((resolve) => setTimeout(resolve, 0));
        throw outcome;
      }
      return outcome;
    },
    events: (async function* () {
      if (eventTiming === 'after-result') await new Promise((resolve) => setTimeout(resolve, 0));
      yield* events;
    })(),
    close: async () => {},
    kill: () => true,
  };
}

function installFallbackProfile(): void {
  writeFileSync(PROFILES_FILE, JSON.stringify({
    defaultProfile: 'retry-test',
    profiles: {
      'retry-test': {
        model: 'deepseek-v4-pro',
        backend: 'pi',
        provider: 'deepseek',
        mode: 'deepseek',
        fallback: [{ model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' }],
      },
    },
  }));
  profileRepo.invalidate();
}

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

function installAuthProfile(backend: Backend, provider?: string): void {
  writeFileSync(PROFILES_FILE, JSON.stringify({
    defaultProfile: 'auth-test',
    profiles: {
      'auth-test': {
        model: backend === 'claude' ? 'claude-sonnet-4-6' : 'deepseek-v4-pro',
        backend,
        mode: backend === 'claude' ? 'plan' : 'deepseek',
        ...(provider ? { provider } : {}),
      },
    },
  }));
  profileRepo.invalidate();
}

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

interface AuthBackendCase {
  backend: Backend;
  provider?: string;
  expectedProvider: string;
  message: string;
  kind: AuthErrorKind;
}

type RequiredEvent = Extract<CortexEvent, { type: 'auth.required' }>;
type RecoveredEvent = Extract<CortexEvent, { type: 'auth.recovered' }>;

interface AuthRunHarness {
  options: { profileName: string; channel: string; trackSessionId: string };
  authError: Error;
  nonAuthError: Error;
  required: RequiredEvent[];
  recovered: RecoveredEvent[];
  spawnCount(): number;
}

afterEach(() => initAuthEvents(null));

const AUTH_BACKEND_CASES: AuthBackendCase[] = [
  {
    backend: 'claude', expectedProvider: 'anthropic',
    message: 'Please run /login: credential-fragment-claude', kind: 'login_required',
  },
  {
    backend: 'pi', provider: 'deepseek', expectedProvider: 'deepseek',
    message: 'authentication_error: credential-fragment-pi', kind: 'invalid_api_key',
  },
];

function createAuthRunHarness(authCase: AuthBackendCase): AuthRunHarness {
  installAuthProfile(authCase.backend, authCase.provider);
  const bus = new EventBus();
  const required: RequiredEvent[] = [];
  const recovered: RecoveredEvent[] = [];
  bus.subscribe('auth.required', (event) => { required.push(event); });
  bus.subscribe('auth.recovered', (event) => { recovered.push(event); });
  initAuthEvents(bus);
  const authError = new Error(authCase.message);
  const nonAuthError = new Error('context window exceeded');
  const spawn = vi.spyOn(getAdapter(authCase.backend), 'spawn')
    .mockReturnValueOnce(makeProcess(authError))
    .mockReturnValueOnce(makeProcess(nonAuthError))
    .mockReturnValueOnce(makeProcess(RATE_LIMIT_RESULT))
    .mockReturnValueOnce(makeProcess(SUCCESS_RESULT))
    .mockReturnValueOnce(makeProcess(SUCCESS_RESULT));
  const options = {
    profileName: 'auth-test', channel: `web:auth-${authCase.backend}`,
    trackSessionId: `track-${authCase.backend}`,
  };
  return { options, authError, nonAuthError, required, recovered, spawnCount: () => spawn.mock.calls.length };
}

async function assertInitialAuthFailure(h: AuthRunHarness, authCase: AuthBackendCase): Promise<void> {
  await assert.rejects(runAgent('test', h.options).promise, (caught) => caught === h.authError);
  assert.equal(h.spawnCount(), 1);
  assert.equal(h.required.length, 1);
  const { ts: _requiredTs, ...payload } = h.required[0];
  assert.deepEqual(payload, {
    type: 'auth.required', backend: authCase.backend, provider: authCase.expectedProvider,
    authType: null, kind: authCase.kind, channel: h.options.channel,
    sessionId: h.options.trackSessionId,
  });
  assert.equal(JSON.stringify(h.required[0]).includes('credential-fragment'), false);
}

async function assertPendingAcrossOtherFailures(h: AuthRunHarness): Promise<void> {
  await assert.rejects(runAgent('test', h.options).promise, (caught) => caught === h.nonAuthError);
  assert.equal(h.required.length, 1);
  assert.deepEqual(h.recovered, []);
  const rateLimited = await runAgent('test', h.options).promise;
  assert.equal(rateLimited.rateLimited, true);
  assert.deepEqual(h.recovered, []);
}

async function assertSingleRecovery(h: AuthRunHarness, authCase: AuthBackendCase): Promise<void> {
  await runAgent('test', h.options).promise;
  assert.equal(h.recovered.length, 1);
  const { ts: _recoveredTs, ...payload } = h.recovered[0];
  assert.deepEqual(payload, {
    type: 'auth.recovered', backend: authCase.backend, provider: authCase.expectedProvider,
  });
  await runAgent('test', h.options).promise;
  assert.equal(h.recovered.length, 1);
  assert.equal(h.spawnCount(), 5);
}

for (const authCase of AUTH_BACKEND_CASES) {
  test(`runAgent publishes required and recovered through the ${authCase.backend} facade path`, async () => {
    const harness = createAuthRunHarness(authCase);
    await assertInitialAuthFailure(harness, authCase);
    await assertPendingAcrossOtherFailures(harness);
    await assertSingleRecovery(harness, authCase);
  });
}

test('runAgent falls back after PI exhausts a generic provider-retry error', async () => {
  installFallbackProfile();
  const primary = vi.spyOn(getAdapter('pi'), 'spawn')
    .mockReturnValue(makeProcess(new Error(
      'Codex error: An error occurred while processing your request. You can retry your request. Request ID: req_123',
    )));
  const fallback = vi.spyOn(getAdapter('claude'), 'spawn')
    .mockReturnValue(makeProcess(SUCCESS_RESULT));
  const transitions: string[] = [];
  const notices: Array<{ text: string; level?: string }> = [];

  const result = await runAgent('test', {
    profileName: 'retry-test',
    channel: 'web:retry',
    onFallback: async (_current, next) => { transitions.push(next.model); },
    onAssistantMessage: (text, _blockId, level) => notices.push({ text, level }),
  }).promise;

  assert.equal(result.finalOutput, 'fallback-ok');
  assert.equal(primary.mock.calls.length, 1);
  assert.equal(fallback.mock.calls.length, 1);
  assert.deepEqual(transitions, ['claude-sonnet-4-6']);
  assert.deepEqual(notices, [{
    text: 'Model fallback: deepseek-v4-pro/deepseek → claude-sonnet-4-6/plan.',
    level: 'warning',
  }]);
});

test('runAgent emits one terminal error notice for a deterministic authentication failure', async () => {
  installFallbackProfile();
  vi.spyOn(getAdapter('pi'), 'spawn')
    .mockReturnValue(makeProcess(new Error('HTTP 401 unauthorized')));
  const fallback = vi.spyOn(getAdapter('claude'), 'spawn')
    .mockReturnValue(makeProcess(SUCCESS_RESULT));
  const notices: Array<{ text: string; level?: string }> = [];

  await assert.rejects(
    runAgent('test', {
      profileName: 'retry-test',
      channel: 'web:retry',
      onAssistantMessage: (text, _blockId, level) => notices.push({ text, level }),
    }).promise,
    /401 unauthorized/,
  );
  assert.equal(fallback.mock.calls.length, 0);
  assert.deepEqual(notices, [{ text: 'Error: HTTP 401 unauthorized', level: 'error' }]);
});

test('provider outage gates automated configs but not direct interactive sessions', async (t) => {
  installSingleProfile();
  await activateProviderOutage();
  t.onTestFinished(() => throttleReset());
  const spawn = vi.spyOn(getAdapter('pi'), 'spawn').mockReturnValue(makeProcess(SUCCESS_RESULT));

  assert.equal(allConfigsRateLimited('single-test'), true);
  const result = await runAgent('test', {
    profileName: 'single-test',
    channel: 'web:retry',
    isUserInitiated: true,
  }).promise;

  assert.equal(spawn.mock.calls.length, 1);
  assert.equal(result.finalOutput, 'fallback-ok');
});

test('runAgent shows a warning when a user chat rate-limit result will auto-resume', async (t) => {
  installSingleProfile();
  await activateProviderThrottle();
  t.onTestFinished(() => throttleReset());
  vi.spyOn(getAdapter('pi'), 'spawn').mockReturnValue(makeProcess(RATE_LIMIT_RESULT));
  const notices: Array<{ text: string; level?: string }> = [];

  const result = await runAgent('test', {
    profileName: 'single-test',
    channel: 'web:retry',
    isUserInitiated: true,
    onAssistantMessage: (text, _blockId, level) => notices.push({ text, level }),
  }).promise;

  assert.equal(result.rateLimited, true);
  assert.deepEqual(notices, [{
    text: 'Rate limited — this chat will resume automatically when the limit resets.',
    level: 'warning',
  }]);
});

test('runAgent shows the auto-resume warning for a thrown user-chat rate-limit error', async (t) => {
  installSingleProfile();
  await activateProviderThrottle();
  t.onTestFinished(() => throttleReset());
  vi.spyOn(getAdapter('pi'), 'spawn').mockReturnValue(makeProcess(new Error('HTTP 429 rate limit exceeded')));
  const notices: Array<{ text: string; level?: string }> = [];

  await assert.rejects(
    runAgent('test', {
      profileName: 'single-test',
      channel: 'web:retry',
      isUserInitiated: true,
      onAssistantMessage: (text, _blockId, level) => notices.push({ text, level }),
    }).promise,
    /rate limit exceeded/,
  );

  assert.deepEqual(notices, [{
    text: 'Rate limited — this chat will resume automatically when the limit resets.',
    level: 'warning',
  }]);
});

test('runAgent keeps a non-resumable rate-limit result as an error notice', async (t) => {
  throttleReset();
  t.onTestFinished(() => throttleReset());
  installSingleProfile();
  vi.spyOn(getAdapter('pi'), 'spawn').mockReturnValue(makeProcess(RATE_LIMIT_RESULT));
  const notices: Array<{ text: string; level?: string }> = [];

  await runAgent('test', {
    profileName: 'single-test',
    channel: 'web:retry',
    isUserInitiated: true,
    onAssistantMessage: (text, _blockId, level) => notices.push({ text, level }),
  }).promise;

  assert.deepEqual(notices, [{ text: 'Rate limited', level: 'error' }]);
});

test('runAgent does not duplicate an API Error event when the attempt terminates with the same error', async () => {
  installFallbackProfile();
  const message = 'API Error: 400 invalid_request';
  vi.spyOn(getAdapter('pi'), 'spawn')
    .mockReturnValue(makeProcess(new Error(message), [{ type: 'assistant_text', text: message }], 'after-result'));
  const fallback = vi.spyOn(getAdapter('claude'), 'spawn')
    .mockReturnValue(makeProcess(SUCCESS_RESULT));
  const notices: Array<{ text: string; level?: string }> = [];

  await assert.rejects(
    runAgent('test', {
      profileName: 'retry-test',
      channel: 'web:retry',
      onAssistantMessage: (text, _blockId, level) => notices.push({ text, level }),
    }).promise,
    /invalid_request/,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(fallback.mock.calls.length, 0);
  assert.deepEqual(notices, [{ text: message, level: 'error' }]);
});

test('runAgent resets terminal-error deduplication when moving to a fallback attempt', async () => {
  installFallbackProfile();
  const firstError = 'API Error: Unable to connect to API (ECONNRESET)';
  vi.spyOn(getAdapter('pi'), 'spawn')
    .mockReturnValue(makeProcess(new Error(firstError), [{ type: 'assistant_text', text: firstError }]));
  vi.spyOn(getAdapter('claude'), 'spawn')
    .mockReturnValue(makeProcess(new Error('HTTP 401 unauthorized')));
  const notices: Array<{ text: string; level?: string }> = [];

  await assert.rejects(
    runAgent('test', {
      profileName: 'retry-test',
      channel: 'web:retry',
      onAssistantMessage: (text, _blockId, level) => notices.push({ text, level }),
    }).promise,
    /401 unauthorized/,
  );

  assert.deepEqual(notices, [
    { text: firstError, level: 'error' },
    { text: 'Model fallback: deepseek-v4-pro/deepseek → claude-sonnet-4-6/plan.', level: 'warning' },
    { text: 'Error: HTTP 401 unauthorized', level: 'error' },
  ]);
});

test('runAgent single-config kill suppresses a generic process-exit error notice', async () => {
  installSingleProfile();
  vi.spyOn(getAdapter('pi'), 'spawn')
    .mockReturnValue(makeProcess(new Error('pi exited with code 143')));
  const notices: Array<{ text: string; level?: string }> = [];

  const handle = runAgent('test', {
    profileName: 'single-test',
    channel: 'web:retry',
    onAssistantMessage: (text, _blockId, level) => notices.push({ text, level }),
  });
  handle.kill();
  await assert.rejects(handle.promise, /code 143/);

  assert.deepEqual(notices, []);
});

test('runAgent does not synthesize terminal chat notices for non-Web channels', async () => {
  installFallbackProfile();
  vi.spyOn(getAdapter('pi'), 'spawn')
    .mockReturnValue(makeProcess(new Error('HTTP 401 unauthorized')));
  const notices: Array<{ text: string; level?: string }> = [];

  await assert.rejects(
    runAgent('test', {
      profileName: 'retry-test',
      channel: 'slack:C1',
      onAssistantMessage: (text, _blockId, level) => notices.push({ text, level }),
    }).promise,
    /401 unauthorized/,
  );

  assert.deepEqual(notices, []);
});

test('runAgent does not turn user cancellation into an error notice', async () => {
  installFallbackProfile();
  const cancelled = Object.assign(new Error('Cancelled by user'), { cancelled: true });
  vi.spyOn(getAdapter('pi'), 'spawn').mockReturnValue(makeProcess(cancelled));
  const notices: Array<{ text: string; level?: string }> = [];

  await assert.rejects(
    runAgent('test', {
      profileName: 'retry-test',
      channel: 'web:retry',
      onAssistantMessage: (text, _blockId, level) => notices.push({ text, level }),
    }).promise,
    /Cancelled by user/,
  );

  assert.deepEqual(notices, []);
});
