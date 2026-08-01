// input:  auth getters, UiService dispatcher, and tRPC router
// output: auth status, Web flow ownership, and registry assertions
// pos:    UI-service authentication query routing regression
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { handleAuthFlowState, handleAuthStatus } from '../../../src/domain/ui-service/query/auth.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import { createAppRouter } from '../../../src/domain/ui-service/app-router.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { AuthStatusSnapshot } from '../../../src/domain/auth/auth-status.js';
import type { LoginFlowState } from '../../../src/domain/auth/login-flow.js';

const SNAPSHOT: AuthStatusSnapshot = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [],
  piRuntime: { available: false, version: null, entry: null, error: 'pi executable not found' },
};

const FLOW_STATE: LoginFlowState = {
  flowId: 'flow-web', backend: 'claude', provider: 'anthropic', authType: 'api_key',
  step: 'prompt', pendingPrompt: { kind: 'secret', message: 'Enter key' }, notice: null,
  channel: null, sessionId: null,
  createdAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:30:00.000Z',
  outcome: null, error: null, errorCode: null,
};

test('auth.status returns the exact AuthStatusSnapshot from one getter call', async () => {
  let calls = 0;
  const result = await handleAuthStatus({}, async () => {
    calls += 1;
    return SNAPSHOT;
  });

  assert.equal(calls, 1);
  assert.equal(result, SNAPSHOT);
});

test('auth.flowState returns metadata-only state or null', async () => {
  const getState = (flowId: string) => flowId === 'flow-web' ? FLOW_STATE : null;

  assert.equal(await handleAuthFlowState({ flowId: 'flow-web' }, getState), FLOW_STATE);
  assert.equal(await handleAuthFlowState({ flowId: 'missing' }, getState), null);
  assert.equal(await handleAuthFlowState(
    { flowId: 'flow-chat' },
    () => ({ ...FLOW_STATE, flowId: 'flow-chat', channel: 'slack:C1' }),
  ), null);
  assert.ok(!JSON.stringify(await handleAuthFlowState({ flowId: 'flow-web' }, getState)).includes('submitted-key'));
});

test('typed auth queries reach the real UiService registry once', async () => {
  let statusCalls = 0;
  let stateCalls = 0;
  const deps = {
    getAuthStatus: async () => {
      statusCalls += 1;
      return SNAPSHOT;
    },
    authLogin: {
      getState: (flowId: string) => {
        stateCalls += 1;
        return flowId === 'flow-web' ? FLOW_STATE : null;
      },
    },
  } as unknown as UiServiceDeps;
  const caller = createAppRouter(createUiService(deps)).createCaller({});

  assert.equal(await caller.auth.status({}), SNAPSHOT);
  assert.equal(await caller.auth.flowState({ flowId: 'flow-web' }), FLOW_STATE);
  assert.equal(statusCalls, 1);
  assert.equal(stateCalls, 1);
});
