// input:  auth UI-service handlers, stub login service, and EventBus audit sink
// output: auth notice reuse, conflict, and redaction regressions
// pos:    Tests the transport-neutral Web authentication write surface
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  handleAuthCancelFlow,
  handleAuthRespondPrompt,
  handleAuthStartLogin,
} from '../../../src/domain/ui-service/mutate/auth.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import type { AuthLoginService } from '../../../src/domain/auth/login-service.js';
import type { LoginFlowState } from '../../../src/domain/auth/login-flow.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const STATE: LoginFlowState = {
  flowId: 'flow-web',
  backend: 'pi',
  provider: 'deepseek',
  authType: 'api_key',
  step: 'prompt',
  pendingPrompt: { kind: 'secret', message: 'Enter key' },
  notice: null,
  channel: null,
  sessionId: null,
  createdAt: '2030-01-01T00:00:00.000Z',
  expiresAt: '2030-01-01T00:30:00.000Z',
  outcome: null,
  error: null,
  errorCode: null,
};

interface AuthCalls {
  starts: unknown[];
  responses: Array<{ flowId: string; value: string }>;
  cancellations: string[];
}

function makeAuthService(): { service: AuthLoginService; calls: AuthCalls } {
  const calls: AuthCalls = { starts: [], responses: [], cancellations: [] };
  return {
    calls,
    service: {
      start: async input => {
        calls.starts.push(input);
        return { ...STATE, backend: input.backend, provider: input.provider };
      },
      getState: flowId => flowId === STATE.flowId ? STATE : null,
      respond: async (flowId, value) => {
        calls.responses.push({ flowId, value });
        return { ...STATE, step: 'running', pendingPrompt: null };
      },
      cancel: async flowId => {
        calls.cancellations.push(flowId);
        return { ...STATE, step: 'cancelled', pendingPrompt: null };
      },
    },
  };
}

test('auth mutation handlers start, answer, and cancel through the injected service', async () => {
  const fixture = makeAuthService();
  const deps = { authLogin: fixture.service } as UiServiceDeps;

  const started = await handleAuthStartLogin(deps, {
    backend: 'pi', provider: 'deepseek', authType: 'api_key',
  });
  assert.equal(started.ok, true);
  assert.deepEqual(fixture.calls.starts, [{
    backend: 'pi', provider: 'deepseek', authType: 'api_key', channel: null, sessionId: null,
  }]);

  const responded = await handleAuthRespondPrompt(deps, { flowId: 'flow-web', value: 'secret-value' });
  assert.equal(responded.ok, true);
  assert.deepEqual(fixture.calls.responses, [{ flowId: 'flow-web', value: 'secret-value' }]);
  assert.ok(!JSON.stringify(responded).includes('secret-value'));

  const cancelled = await handleAuthCancelFlow(deps, { flowId: 'flow-web' });
  assert.equal(cancelled.ok, true);
  assert.deepEqual(fixture.calls.cancellations, ['flow-web']);
});

test('Web notice starts once, then returns terminal or expired state across clients', async () => {
  const fixture = makeAuthService();
  let current: LoginFlowState | null = STATE;
  fixture.service.getState = () => current;
  const deps = { authLogin: fixture.service } as UiServiceDeps;
  const args = {
    backend: 'pi' as const, provider: 'deepseek', authType: 'api_key' as const,
    noticeId: 'notice-across-clients',
  };

  const first = await handleAuthStartLogin(deps, args);
  current = { ...STATE, step: 'done', pendingPrompt: null,
    outcome: { provider: 'deepseek', authType: 'api_key', expiresAt: null } };
  const terminal = await handleAuthStartLogin(deps, args);
  current = null;
  const expired = await handleAuthStartLogin(deps, args);

  assert.equal(first.ok, true);
  assert.equal(terminal.ok && terminal.data.step, 'done');
  assert.equal(fixture.calls.starts.length, 1);
  assert.deepEqual(expired, {
    ok: false, code: 'not-found', message: 'Login flow not found or expired.',
  });
});

test('auth mutations map missing and inactive flows without exposing response values', async () => {
  const fixture = makeAuthService();
  fixture.service.respond = async () => { throw new Error('Login flow not found or expired.'); };
  fixture.service.cancel = async () => { throw new Error('Login flow is not active.'); };
  const deps = { authLogin: fixture.service } as UiServiceDeps;

  const missing = await handleAuthRespondPrompt(deps, { flowId: 'missing', value: 'never-log-me' });
  assert.deepEqual(missing, {
    ok: false, code: 'not-found', message: 'Login flow not found or expired.',
  });
  const inactive = await handleAuthCancelFlow(deps, { flowId: 'flow-web' });
  assert.deepEqual(inactive, {
    ok: false, code: 'already-terminal', message: 'Login flow is not active.',
  });
  assert.ok(!JSON.stringify([missing, inactive]).includes('never-log-me'));
});

test('duplicate auth response is a client error instead of an internal failure', async () => {
  const fixture = makeAuthService();
  fixture.service.respond = async () => {
    throw new Error('Login flow is not waiting for a prompt response.');
  };
  const result = await handleAuthRespondPrompt(
    { authLogin: fixture.service } as UiServiceDeps,
    { flowId: 'flow-web', value: 'duplicate-secret' },
  );

  assert.deepEqual(result, {
    ok: false,
    code: 'invalid-args',
    message: 'Login flow is not waiting for a prompt response.',
  });
  assert.ok(!JSON.stringify(result).includes('duplicate-secret'));
});

test('Web auth mutations cannot answer or cancel a chat-owned flow', async () => {
  const fixture = makeAuthService();
  fixture.service.getState = () => ({ ...STATE, channel: 'slack:C1' });
  const deps = { authLogin: fixture.service } as UiServiceDeps;

  const responded = await handleAuthRespondPrompt(deps, { flowId: 'flow-web', value: 'secret-value' });
  const cancelled = await handleAuthCancelFlow(deps, { flowId: 'flow-web' });

  assert.equal(responded.ok, false);
  assert.equal((responded as any).code, 'not-found');
  assert.equal(cancelled.ok, false);
  assert.equal((cancelled as any).code, 'not-found');
  assert.deepEqual(fixture.calls.responses, []);
  assert.deepEqual(fixture.calls.cancellations, []);
});

test('auth.respondPrompt audit event strips the submitted value completely', async () => {
  const fixture = makeAuthService();
  const events: any[] = [];
  const deps = {
    authLogin: fixture.service,
    bus: { publish: (event: unknown) => events.push(event) },
  } as unknown as UiServiceDeps;
  const service = createUiService(deps);
  const secret = 'sentinel-secret-value';

  const result = await service.mutate('auth.respondPrompt', { flowId: 'flow-web', value: secret });

  assert.equal(result.ok, true);
  const audit = events.find(event => event.type === 'ui.mutate-invoked');
  assert.deepEqual(audit.args, { flowId: 'flow-web' });
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.ok(!JSON.stringify(result).includes(secret));
});
