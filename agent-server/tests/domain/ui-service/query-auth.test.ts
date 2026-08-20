// input:  auth flow-state getter and Web-owned login fixtures
// output: Web flow ownership and metadata-isolation assertions
// pos:    UI-service authentication flow-state regression
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { handleAuthFlowState } from '../../../src/domain/ui-service/query/auth.js';
import type { LoginFlowState } from '../../../src/domain/auth/login-flow.js';

const FLOW_STATE: LoginFlowState = {
  flowId: 'flow-web', backend: 'claude', provider: 'anthropic', authType: 'api_key',
  step: 'prompt', pendingPrompt: { kind: 'secret', message: 'Enter key' }, notice: null,
  channel: null, sessionId: null,
  createdAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:30:00.000Z',
  outcome: null, error: null, errorCode: null,
};

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
