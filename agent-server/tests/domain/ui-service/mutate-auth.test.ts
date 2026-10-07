import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  handleAuthCancelFlow,
  handleAuthRespondPrompt,
  handleAuthStartLogin,
  handleAuthSyncGateway,
} from '../../../src/domain/ui-service/mutate/auth.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import { EventBus } from '../../../src/events/event-bus.js';
import { createAppRouter } from '../../../src/domain/ui-service/app-router.js';
import type { AuthLoginService } from '../../../src/domain/auth/login-service.js';
import type { LoginFlowState } from '../../../src/domain/auth/login-flow.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const STATE: LoginFlowState = {
  flowId: 'flow-web',
  revision: 1,
  backend: 'pi',
  provider: 'deepseek',
  authType: 'api_key',
  step: 'prompt',
  pendingPrompt: { id: 1, kind: 'secret', message: 'Enter key' },
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

function makeNoticeService() {
  const states = new Map<string, LoginFlowState | null>();
  let starts = 0;
  const service: AuthLoginService = {
    start: async input => {
      starts += 1;
      const state = { ...STATE, flowId: `flow-notice-${starts}`, provider: input.provider };
      states.set(state.flowId, state);
      return state;
    },
    getState: flowId => states.get(flowId) ?? null,
    respond: async () => STATE,
    cancel: async () => STATE,
  };
  return { service, states, starts: () => starts };
}

const NOTICE_ARGS = {
  backend: 'pi' as const, provider: 'deepseek', authType: 'api_key' as const,
  noticeId: 'notice-across-clients',
};

test('Web notice resumes its running flow and replays a success', async () => {
  const fixture = makeNoticeService();
  const deps = { authLogin: fixture.service } as UiServiceDeps;

  const first = await handleAuthStartLogin(deps, NOTICE_ARGS);
  const resumed = await handleAuthStartLogin(deps, NOTICE_ARGS);
  assert.equal(resumed.ok && resumed.data.flowId, first.ok && first.data.flowId);
  fixture.states.set('flow-notice-1', {
    ...STATE, flowId: 'flow-notice-1', step: 'done', pendingPrompt: null,
    outcome: { provider: 'deepseek', authType: 'api_key', expiresAt: null },
  });
  const replayed = await handleAuthStartLogin(deps, NOTICE_ARGS);

  assert.equal(replayed.ok && replayed.data.step, 'done');
  assert.equal(fixture.starts(), 1);
});

test.each([
  ['failed', { step: 'failed' as const, error: 'Login failed.' }],
  ['cancelled', { step: 'cancelled' as const }],
  ['expired', null],
  ['owned by a chat channel', { channel: 'slack:C1' }],
])('Web notice whose flow is %s starts a fresh login and rebinds to it', async (_name, change) => {
  const fixture = makeNoticeService();
  const deps = { authLogin: fixture.service } as UiServiceDeps;
  await handleAuthStartLogin(deps, NOTICE_ARGS);
  fixture.states.set('flow-notice-1', change && {
    ...STATE, flowId: 'flow-notice-1', pendingPrompt: null, ...change,
  });

  const retried = await handleAuthStartLogin(deps, NOTICE_ARGS);
  const resumed = await handleAuthStartLogin(deps, NOTICE_ARGS);

  assert.equal(retried.ok && retried.data.flowId, 'flow-notice-2');
  assert.equal(resumed.ok && resumed.data.flowId, 'flow-notice-2');
  assert.equal(fixture.starts(), 2);
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
    bus: Object.assign(new EventBus(), { publish: (event: unknown) => events.push(event) }),
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

const LOGOUT_INPUT = {
  backend: 'pi' as const, provider: 'deepseek', authType: 'api_key' as const,
};

function logoutDeps(result: unknown, calls: unknown[]): UiServiceDeps {
  return {
    logoutAccount: async (input: unknown) => {
      calls.push(input);
      return result;
    },
    bus: new EventBus(),
  } as unknown as UiServiceDeps;
}

test('auth.logout tRPC maps an unmanageable credential to a client error with guidance', async () => {
  const failure = {
    ok: false as const, ...LOGOUT_INPUT,
    error: {
      code: 'not_manageable' as const,
      message: 'Run `claude /logout` in a terminal.',
    },
  };
  const caller = createAppRouter(createUiService(logoutDeps(failure, []))).createCaller({});

  await assert.rejects(
    () => caller.auth.logout(LOGOUT_INPUT),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'BAD_REQUEST');
      assert.equal((error as Error).message, failure.error.message);
      return true;
    },
  );
});

test('auth.syncGateway rebuilds model routing and reports what it produced', async () => {
  const calls: unknown[] = [];
  const deps = {
    syncGateway: async (options: unknown) => {
      calls.push(options);
      return { configured: true, endpoints: 2, profiles: ['plan', 'execute'] };
    },
  } as unknown as UiServiceDeps;

  const result = await handleAuthSyncGateway(deps, {});

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.data, {
    configured: true, endpoints: 2, profiles: ['plan', 'execute'],
  });
  assert.equal(calls.length, 1);
});
