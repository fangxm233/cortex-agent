// input:  !login command registry, CommandActionRouter, and stub auth service
// output: staged chat validation, expiry, and secret regressions
// pos:    Tests chat API-key login entry and callback delivery
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import type { AuthLoginService } from '../src/domain/auth/login-service.js';
import type { LoginFlowState, StartLoginFlowInput } from '../src/domain/auth/login-flow.js';
import { CommandActionRouter } from '../src/orchestration/interactions/command-action-router.js';
import { registerCommands } from '../src/orchestration/routing/commands/index.js';
import { MockAdapter } from '../src/platform/testing.js';

const flush = () => setImmediate();

function flowState(
  input: StartLoginFlowInput,
  step: LoginFlowState['step'] = 'prompt',
  expiresAt = '2030-01-01T00:30:00.000Z',
): LoginFlowState {
  return {
    flowId: `flow-${input.backend}-${input.provider}`,
    backend: input.backend,
    provider: input.provider,
    authType: input.authType,
    step,
    pendingPrompt: step === 'prompt' ? { kind: 'secret', message: 'Enter key' } : null,
    notice: null,
    channel: input.channel,
    sessionId: input.sessionId,
    createdAt: '2030-01-01T00:00:00.000Z',
    expiresAt,
    outcome: step === 'done'
      ? { provider: input.provider, authType: 'api_key', expiresAt: null }
      : null,
    error: null,
    errorCode: null,
  };
}

function makeAuthService(
  startStep: LoginFlowState['step'] = 'prompt',
  expiresAt = '2030-01-01T00:30:00.000Z',
) {
  const starts: StartLoginFlowInput[] = [];
  const responses: Array<{ flowId: string; value: string }> = [];
  const states = new Map<string, LoginFlowState>();
  const service: AuthLoginService = {
    start: async input => {
      starts.push(input);
      const state = flowState(input, startStep, expiresAt);
      states.set(state.flowId, state);
      return state;
    },
    getState: flowId => states.get(flowId) ?? null,
    respond: async (flowId, value) => {
      responses.push({ flowId, value });
      const current = states.get(flowId)!;
      const done = flowState({
        backend: current.backend,
        provider: current.provider!,
        authType: 'api_key',
        channel: current.channel,
        sessionId: current.sessionId,
      }, 'done');
      states.set(flowId, { ...done, flowId });
      return { ...done, flowId };
    },
    cancel: async flowId => {
      const current = states.get(flowId)!;
      const cancelled = { ...current, step: 'cancelled' as const, pendingPrompt: null };
      states.set(flowId, cancelled);
      return cancelled;
    },
  };
  return { service, starts, responses, states };
}

function authSnapshot() {
  return {
    generatedAt: '2030-01-01T00:00:00.000Z',
    accounts: [
      {
        backend: 'claude', provider: 'anthropic', label: 'Anthropic', capabilities: ['api_key'],
        authType: null, state: 'logged-out', source: null, expiresAt: null,
        refreshExpiresAt: null, inUse: true, credentials: [],
      },
      {
        backend: 'pi', provider: 'deepseek', label: 'DeepSeek', capabilities: ['api_key'],
        authType: null, state: 'logged-out', source: null, expiresAt: null,
        refreshExpiresAt: null, inUse: true, credentials: [],
      },
      {
        backend: 'pi', provider: 'oauth-only', label: 'OAuth only', capabilities: ['oauth'],
        authType: null, state: 'logged-out', source: null, expiresAt: null,
        refreshExpiresAt: null, inUse: false, credentials: [],
      },
    ],
    piRuntime: { available: true, version: 'test', entry: '/test/pi', error: null },
  } as any;
}

function setup(
  startStep: LoginFlowState['step'] = 'prompt',
  expiresAt = '2030-01-01T00:30:00.000Z',
  readStatus = async () => authSnapshot(),
) {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const auth = makeAuthService(startStep, expiresAt);
  const dispatch = registerCommands({
    scheduler: null as any,
    commandRouter: router,
    getAuthStatus: readStatus,
    authLogin: auth.service,
  });
  router.bindToAdapter(adapter);
  return { adapter, auth, dispatch };
}

function actionButton(adapter: MockAdapter) {
  const blocks = adapter.posted.at(-1)?.content.richBlocks ?? [];
  const actions = blocks.find(block => block.type === 'actions');
  assert.ok(actions && actions.type === 'actions');
  return actions.elements[0];
}

test('!login cc starts a flow and submits a Slack modal secret without posting it', async () => {
  const fixture = setup();
  const secret = 'sentinel-slack-secret';

  assert.equal(fixture.dispatch('!login cc', 'slack:C1', fixture.adapter), true);
  await flush();
  assert.equal(fixture.auth.starts.length, 1);
  assert.deepEqual(fixture.auth.starts[0], {
    backend: 'claude', provider: 'anthropic', authType: 'api_key',
    channel: 'slack:C1', sessionId: null,
  });

  const button = actionButton(fixture.adapter);
  assert.equal(button.actionId, 'cmd:login:open');
  await fixture.adapter.simulateAction(button.actionId, button.value, {
    channelId: 'slack:C2', triggerId: 'slack:forged',
  });
  assert.equal(fixture.adapter.modals.length, 0);
  await fixture.adapter.simulateAction(button.actionId, button.value, {
    channelId: 'slack:C1', triggerId: 'slack:trigger',
  });
  const opened = fixture.adapter.modals.at(-1)!;
  assert.equal(opened.triggerId, 'slack:trigger');
  assert.deepEqual(opened.modal.fields.map(field => field.type), ['text_input']);
  assert.ok(!opened.modal.privateMetadata?.includes(secret));

  await fixture.adapter.simulateModalSubmit('cmd_login_submit', {
    login_secret: { value: { value: secret } },
  }, { privateMetadata: opened.modal.privateMetadata });
  await flush();
  assert.deepEqual(fixture.auth.responses, [{
    flowId: 'flow-claude-anthropic', value: secret,
  }]);
  assert.ok(!JSON.stringify(fixture.adapter.posted).includes(secret));
  assert.ok(fixture.adapter.posted.at(-1)?.content.text.includes('anthropic'));
});

test('a running explicit flow does not expose the secret form before its prompt is ready', async () => {
  const fixture = setup('running');
  assert.equal(fixture.dispatch('!login cc', 'slack:C1', fixture.adapter), true);
  await flush();
  assert.equal(fixture.adapter.posted.at(-1)?.content.richBlocks, undefined);

  const running = fixture.auth.states.get('flow-claude-anthropic')!;
  fixture.auth.states.set(running.flowId, {
    ...running,
    step: 'prompt',
    pendingPrompt: { kind: 'secret', message: 'Enter key' },
  });
  await delay(150);

  assert.equal(actionButton(fixture.adapter).actionId, 'cmd:login:open');
});

test('a pre-prompt flow disappearance posts a localized expiry failure', async () => {
  const fixture = setup('running', new Date(Date.now() + 50).toISOString());
  fixture.dispatch('!login cc', 'slack:C1', fixture.adapter);
  await flush();
  fixture.auth.states.delete('flow-claude-anthropic');
  await delay(150);

  assert.match(fixture.adapter.posted.at(-1)?.content.text ?? '', /expired/i);
});

test('a post-response flow disappearance posts a localized expiry failure', async () => {
  const fixture = setup();
  fixture.dispatch('!login cc', 'slack:C1', fixture.adapter);
  await flush();
  const button = actionButton(fixture.adapter);
  await fixture.adapter.simulateAction(button.actionId, button.value, {
    channelId: 'slack:C1', triggerId: 'slack:trigger',
  });
  const opened = fixture.adapter.modals.at(-1)!;
  fixture.auth.service.respond = async (flowId, value) => {
    fixture.auth.responses.push({ flowId, value });
    const current = fixture.auth.states.get(flowId)!;
    fixture.auth.states.delete(flowId);
    return {
      ...current, step: 'running', pendingPrompt: null,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    };
  };
  await fixture.adapter.simulateModalSubmit('cmd_login_submit', {
    login_secret: { value: { value: 'sentinel-expired-secret' } },
  }, { privateMetadata: opened.modal.privateMetadata });
  await flush();
  await flush();

  assert.match(fixture.adapter.posted.at(-1)?.content.text ?? '', /expired/i);
  assert.ok(!JSON.stringify(fixture.adapter.posted).includes('sentinel-expired-secret'));
});

test('!login pi collects provider before opening the secret form', async () => {
  const fixture = setup();
  const secret = 'sentinel-feishu-secret';

  fixture.dispatch('!login pi', 'feishu:oc_1', fixture.adapter);
  await flush();
  assert.equal(fixture.auth.starts.length, 0);

  const button = actionButton(fixture.adapter);
  await fixture.adapter.simulateAction(button.actionId, button.value, {
    channelId: 'feishu:oc_1', triggerId: 'feishu:oc_1:om_1',
  });
  const providerModal = fixture.adapter.modals.at(-1)!;
  assert.deepEqual(providerModal.modal.fields.map(field => field.type), ['select']);
  const providerField = providerModal.modal.fields[0];
  assert.equal(providerField.type, 'select');
  assert.deepEqual(providerField.options.map(option => option.value), ['deepseek']);

  await fixture.adapter.simulateModalSubmit('cmd_login_submit', {
    login_provider: { selection: { selectedOption: { value: 'forged-provider' } } },
  }, { privateMetadata: providerModal.modal.privateMetadata });
  await flush();
  assert.equal(fixture.auth.starts.length, 0);

  await fixture.adapter.simulateModalSubmit('cmd_login_submit', {
    login_provider: { selection: { selectedOption: { value: 'deepseek' } } },
  }, { privateMetadata: providerModal.modal.privateMetadata });
  await flush();
  assert.equal(fixture.auth.starts[0].provider, 'deepseek');
  const secretButton = actionButton(fixture.adapter);
  await fixture.adapter.simulateAction(secretButton.actionId, secretButton.value, {
    channelId: 'feishu:oc_1', triggerId: 'feishu:oc_1:om_2',
  });
  const secretModal = fixture.adapter.modals.at(-1)!;
  assert.deepEqual(secretModal.modal.fields.map(field => field.type), ['text_input']);
  await fixture.adapter.simulateModalSubmit('cmd_login_submit', {
    login_secret: { value: { value: secret } },
  }, { privateMetadata: secretModal.modal.privateMetadata });
  await flush();

  assert.deepEqual(fixture.auth.responses, [{ flowId: 'flow-pi-deepseek', value: secret }]);
  assert.ok(!JSON.stringify(fixture.adapter.posted).includes(secret));
  assert.ok(!JSON.stringify(secretModal.modal).includes(secret));
});

test('!login pi validates an explicit provider and starts that flow immediately', async () => {
  const fixture = setup();

  fixture.dispatch('!login pi deepseek', 'slack:C2', fixture.adapter);
  await flush();
  assert.equal(fixture.auth.starts[0].provider, 'deepseek');

  fixture.dispatch('!login pi oauth-only', 'slack:C2', fixture.adapter);
  await flush();
  assert.equal(fixture.auth.starts.length, 1);
  assert.ok(fixture.adapter.posted.at(-1)?.content.text.includes('oauth-only'));
});

test('Feishu provider action returns before status discovery settles', async () => {
  let statusCalls = 0;
  const pendingStatus = new Promise<ReturnType<typeof authSnapshot>>(() => {});
  const fixture = setup('prompt', undefined, async () => {
    statusCalls += 1;
    return statusCalls === 1 ? authSnapshot() : pendingStatus;
  });
  fixture.dispatch('!login pi', 'feishu:oc_fast', fixture.adapter);
  await flush();
  const button = actionButton(fixture.adapter);
  const action = fixture.adapter.simulateAction(button.actionId, button.value, {
    channelId: 'feishu:oc_fast', triggerId: 'feishu:oc_fast:om_1',
  });

  const result = await Promise.race([
    action.then(() => 'returned'),
    delay(100).then(() => 'timeout'),
  ]);
  assert.equal(result, 'returned');
});

test('Feishu form callback returns before backend login settlement', async () => {
  const fixture = setup();
  fixture.auth.service.respond = async () => new Promise<LoginFlowState>(() => {});
  fixture.dispatch('!login cc', 'feishu:oc_fast', fixture.adapter);
  await flush();
  const button = actionButton(fixture.adapter);
  await fixture.adapter.simulateAction(button.actionId, button.value, {
    channelId: 'feishu:oc_fast', triggerId: 'feishu:oc_fast:om_1',
  });
  const opened = fixture.adapter.modals.at(-1)!;
  const submission = fixture.adapter.simulateModalSubmit('cmd_login_submit', {
    login_secret: { value: { value: 'sentinel-fast-secret' } },
  }, { privateMetadata: opened.modal.privateMetadata });

  const result = await Promise.race([
    submission.then(() => 'returned'),
    delay(100).then(() => 'timeout'),
  ]);
  assert.equal(result, 'returned');
});
