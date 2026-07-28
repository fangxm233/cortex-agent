// input:  agents/config, facade, stub AgentProcess events
// output: retry classification and auto-resume notice regressions
// pos:    Agent fallback and terminal notice policy tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { isRetryableError } from '../src/domain/agents/config.js';
import { runAgent } from '../src/domain/agents/facade.js';
import { getAdapter } from '../src/agent-adapter/index.js';
import type { AgentProcess } from '../src/agent-adapter/types.js';
import type { AgentResult } from '../src/core/types/agent-types.js';
import { profileRepo, PROFILES_FILE } from '../src/store/profile-repo.js';
import {
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

async function activateProviderThrottle(provider = 'deepseek'): Promise<void> {
  throttleReset();
  await initRateLimitThrottle(new MockAdapter({ adminChannel: 'admin' }) as any, {
    save: async () => {},
    load: async () => null,
  });
  await handleRateLimitEvent(
    { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: Math.floor(Date.now() / 1000) + 300 },
    { provider, displayName: provider, mode: 'deepseek' },
  );
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
  'HTTP 400 invalid request',
  'HTTP 401 unauthorized',
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
