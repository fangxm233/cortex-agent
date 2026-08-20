// input:  login flow coordinator and its success listener registry
// output: verification that completed logins notify observers exactly once
// pos:    Login success notification tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  onLoginSuccess,
  startFlow,
  type LoginFlowConsumer,
  type LoginSuccessEvent,
} from '../../src/domain/auth/login-flow.js';

/** Wait for the consumer promise chain to settle the flow. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function succeedingConsumer(provider: string): LoginFlowConsumer {
  return async () => ({ provider, authType: 'oauth' as const, expiresAt: null });
}

test('a completed login notifies registered listeners with the backend pair', async () => {
  const seen: LoginSuccessEvent[] = [];
  const unsubscribe = onLoginSuccess((event) => { seen.push(event); });

  await startFlow(
    { backend: 'pi', provider: 'acme', authType: 'oauth', channel: null, sessionId: null },
    succeedingConsumer('acme'),
  );
  await settle();
  unsubscribe();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].backend, 'pi');
  assert.equal(seen[0].provider, 'acme');
});

test('a failed login notifies nobody', async () => {
  const seen: LoginSuccessEvent[] = [];
  const unsubscribe = onLoginSuccess((event) => { seen.push(event); });

  await startFlow(
    { backend: 'pi', provider: 'broken', authType: 'oauth', channel: null, sessionId: null },
    async () => { throw new Error('nope'); },
  );
  await settle();
  unsubscribe();

  assert.deepEqual(seen, []);
});

test('unsubscribing stops delivery', async () => {
  const seen: LoginSuccessEvent[] = [];
  onLoginSuccess((event) => { seen.push(event); })();

  await startFlow(
    { backend: 'pi', provider: 'quiet', authType: 'oauth', channel: null, sessionId: null },
    succeedingConsumer('quiet'),
  );
  await settle();

  assert.deepEqual(seen, []);
});

test('a listener that throws does not break the login it observed', async () => {
  const unsubscribeBad = onLoginSuccess(() => { throw new Error('listener exploded'); });
  const seen: LoginSuccessEvent[] = [];
  const unsubscribeGood = onLoginSuccess((event) => { seen.push(event); });

  const state = await startFlow(
    { backend: 'claude', provider: 'anthropic', authType: 'oauth', channel: null, sessionId: null },
    succeedingConsumer('anthropic'),
  );
  await settle();
  unsubscribeBad();
  unsubscribeGood();

  assert.equal(seen.length, 1, 'a throwing listener must not stop the next one');
  assert.notEqual(state.flowId, '');
});
