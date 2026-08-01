// input:  auth event classifier, EventBus, lifecycle publisher state
// output: auth kind, payload privacy, repeated-required, and recovery tests
// pos:    Covers the backend authentication event contract
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventBus } from '../src/events/event-bus.js';
import type { AuthErrorKind, CortexEvent } from '../src/events/index.js';
import {
  classifyAuthError,
  initAuthEvents,
  publishAuthRecovered,
  publishAuthRequired,
} from '../src/domain/auth/auth-events.js';

const AUTH_CASES: Array<[message: string, kind: AuthErrorKind]> = [
  ['Please run /login', 'login_required'],
  ['login_required: sign in again', 'login_required'],
  ['OAuth token has expired', 'oauth_expired'],
  ['oauth_expired', 'oauth_expired'],
  ['authentication_error', 'invalid_api_key'],
  ['invalid x-api-key', 'invalid_api_key'],
  ['connection timed out during authentication', 'invalid_api_key'],
  ['authentication service upstream connection error', 'invalid_api_key'],
  ['authentication failed', 'invalid_api_key'],
  ['Authentication error: token expired', 'invalid_api_key'],
  ['HTTP 401: token rejected', 'unauthorized'],
  ['unauthorized', 'unauthorized'],
  ['invalid_grant', 'invalid_grant'],
];

for (const [message, kind] of AUTH_CASES) {
  test(`classifyAuthError maps ${message} to ${kind}`, () => {
    assert.equal(classifyAuthError(message), kind);
  });
}

for (const message of [
  'context window exceeded',
  'insufficient_balance',
  'billing account unavailable',
  'request body too large',
  'model not found',
]) {
  test(`classifyAuthError ignores non-auth permanent failure: ${message}`, () => {
    assert.equal(classifyAuthError(message), null);
  });
}

function withoutTs(event: CortexEvent): Omit<CortexEvent, 'ts'> {
  const { ts: _ts, ...payload } = event;
  return payload;
}

test('publishAuthRequired emits every hit with the frozen secret-free payload', (t) => {
  const bus = new EventBus();
  const seen: CortexEvent[] = [];
  bus.subscribe('*', (event) => { seen.push(event); });
  initAuthEvents(bus);
  t.onTestFinished(() => initAuthEvents(null));

  const raw = 'authentication_error: invalid x-api-key sk-secret-suffix';
  const kind = classifyAuthError(raw);
  assert.equal(kind, 'invalid_api_key');
  publishAuthRequired({
    backend: 'claude', provider: 'anthropic', authType: null, kind,
    channel: 'web:session-1', sessionId: 'session-1',
  });
  publishAuthRequired({
    backend: 'claude', provider: 'anthropic', authType: null, kind,
    channel: 'web:session-1', sessionId: 'session-1',
  });

  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map(withoutTs), [
    {
      type: 'auth.required', backend: 'claude', provider: 'anthropic', authType: null,
      kind: 'invalid_api_key', channel: 'web:session-1', sessionId: 'session-1',
    },
    {
      type: 'auth.required', backend: 'claude', provider: 'anthropic', authType: null,
      kind: 'invalid_api_key', channel: 'web:session-1', sessionId: 'session-1',
    },
  ]);
  const serialized = JSON.stringify(seen);
  assert.equal(serialized.includes(raw), false);
  assert.equal(serialized.includes('sk-secret-suffix'), false);
});

test('publishAuthRecovered emits once only after success for the same pending pair', (t) => {
  const bus = new EventBus();
  const recovered: CortexEvent[] = [];
  bus.subscribe('auth.recovered', (event) => { recovered.push(event); });
  initAuthEvents(bus);
  t.onTestFinished(() => initAuthEvents(null));

  publishAuthRequired({
    backend: 'pi', provider: 'openai-codex', authType: 'oauth', kind: 'oauth_expired',
    channel: null, sessionId: null,
  });
  publishAuthRecovered({ backend: 'claude', provider: 'anthropic' });
  publishAuthRecovered({ backend: 'pi', provider: 'deepseek' });
  assert.deepEqual(recovered, []);

  publishAuthRecovered({ backend: 'pi', provider: 'openai-codex' });
  publishAuthRecovered({ backend: 'pi', provider: 'openai-codex' });

  assert.equal(recovered.length, 1);
  assert.deepEqual(withoutTs(recovered[0]), {
    type: 'auth.recovered', backend: 'pi', provider: 'openai-codex',
  });
});

test('auth lifecycle observation is inert while no EventBus is configured', () => {
  initAuthEvents(null);
  publishAuthRequired({
    backend: 'pi', provider: 'deepseek', authType: 'api_key', kind: 'invalid_api_key',
    channel: 'slack:C1', sessionId: 'session-2',
  });

  const bus = new EventBus();
  const recovered: CortexEvent[] = [];
  bus.subscribe('auth.recovered', (event) => { recovered.push(event); });
  initAuthEvents(bus);
  publishAuthRecovered({ backend: 'pi', provider: 'deepseek' });

  assert.deepEqual(recovered, []);
  initAuthEvents(null);
});
