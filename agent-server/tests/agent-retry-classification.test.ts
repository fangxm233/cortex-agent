// input:  agents/config, facade fallback, stub AgentProcess
// output: transient-error classification and provider fallback regressions
// pos:    Agent fallback policy tests for transport and HTTP failures
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

function makeProcess(outcome: AgentResult | Error): AgentProcess {
  return {
    sessionKey: 'retry-test',
    sessionId: null,
    send: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    events: (async function* () {})(),
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

test('runAgent switches once to the configured fallback after the observed gateway 502', async () => {
  installFallbackProfile();
  const primary = vi.spyOn(getAdapter('pi'), 'spawn')
    .mockReturnValue(makeProcess(new Error('502: Upstream connection error: TypeError: fetch failed')));
  const fallback = vi.spyOn(getAdapter('claude'), 'spawn')
    .mockReturnValue(makeProcess(SUCCESS_RESULT));
  const transitions: string[] = [];

  const result = await runAgent('test', {
    profileName: 'retry-test',
    onFallback: async (_current, next) => { transitions.push(next.model); },
  }).promise;

  assert.equal(result.finalOutput, 'fallback-ok');
  assert.equal(primary.mock.calls.length, 1);
  assert.equal(fallback.mock.calls.length, 1);
  assert.deepEqual(transitions, ['claude-sonnet-4-6']);
});

test('runAgent does not fallback after a deterministic authentication failure', async () => {
  installFallbackProfile();
  vi.spyOn(getAdapter('pi'), 'spawn')
    .mockReturnValue(makeProcess(new Error('HTTP 401 unauthorized')));
  const fallback = vi.spyOn(getAdapter('claude'), 'spawn')
    .mockReturnValue(makeProcess(SUCCESS_RESULT));

  await assert.rejects(
    runAgent('test', { profileName: 'retry-test' }).promise,
    /401 unauthorized/,
  );
  assert.equal(fallback.mock.calls.length, 0);
});
