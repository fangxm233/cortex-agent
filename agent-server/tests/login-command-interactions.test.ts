// input:  !login command registry, CommandActionRouter, and stub auth service
// output: Slack/Feishu OAuth notices, prompts, and privacy regressions
// pos:    Tests chat backend login entry and callback delivery
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import {
  createAuthLoginService,
  type AuthLoginService,
} from '../src/domain/auth/login-service.js';
import type {
  LoginFlowConsumer,
  LoginFlowNotice,
  LoginFlowState,
  StartLoginFlowInput,
} from '../src/domain/auth/login-flow.js';
import { CommandActionRouter } from '../src/orchestration/interactions/command-action-router.js';
import { registerCommands } from '../src/orchestration/routing/commands/index.js';
import { MockAdapter } from '../src/platform/testing.js';

const flush = () => setImmediate();

function flowState(
  input: StartLoginFlowInput,
  step: LoginFlowState['step'] = 'prompt',
  notice: LoginFlowNotice | null = null,
): LoginFlowState {
  const promptKind = input.authType === 'oauth' ? 'manual_code' : 'secret';
  return {
    flowId: `flow-${input.backend}-${input.provider}`,
    backend: input.backend,
    provider: input.provider,
    authType: input.authType,
    step,
    pendingPrompt: step === 'prompt' ? { kind: promptKind, message: 'Enter credential' } : null,
    notice,
    channel: input.channel,
    sessionId: input.sessionId,
    createdAt: '2030-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T00:30:00.000Z',
    outcome: step === 'done'
      ? { provider: input.provider, authType: input.authType, expiresAt: null }
      : null,
    error: null,
    errorCode: null,
  };
}

async function respondFakeFlow(
  states: Map<string, LoginFlowState>,
  responses: Array<{ flowId: string; value: string }>,
  flowId: string,
  value: string,
): Promise<LoginFlowState> {
  responses.push({ flowId, value });
  const current = states.get(flowId)!;
  const done = flowState({
    backend: current.backend, provider: current.provider!, authType: current.authType!,
    channel: current.channel, sessionId: current.sessionId,
  }, 'done');
  states.set(flowId, { ...done, flowId });
  return { ...done, flowId };
}

async function cancelFakeFlow(
  states: Map<string, LoginFlowState>,
  flowId: string,
): Promise<LoginFlowState> {
  const current = states.get(flowId)!;
  const cancelled = { ...current, step: 'cancelled' as const, pendingPrompt: null };
  states.set(flowId, cancelled);
  return cancelled;
}

function makeAuthService(
  startStep: LoginFlowState['step'] = 'prompt',
  startNotice: LoginFlowNotice | null = null,
) {
  const starts: StartLoginFlowInput[] = [];
  const responses: Array<{ flowId: string; value: string }> = [];
  const states = new Map<string, LoginFlowState>();
  const service: AuthLoginService = {
    start: async input => {
      starts.push(input);
      const state = flowState(input, startStep, startNotice);
      states.set(state.flowId, state);
      return state;
    },
    getState: flowId => states.get(flowId) ?? null,
    respond: (flowId, value) => respondFakeFlow(states, responses, flowId, value),
    cancel: flowId => cancelFakeFlow(states, flowId),
  };
  return { service, starts, responses, states };
}

function authSnapshot() {
  return {
    generatedAt: '2030-01-01T00:00:00.000Z',
    accounts: [
      {
        backend: 'claude', provider: 'anthropic', label: 'Anthropic', capabilities: ['api_key', 'oauth'],
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
  startNotice: LoginFlowNotice | null = null,
) {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const auth = makeAuthService(startStep, startNotice);
  const dispatch = registerCommands({
    scheduler: null as any,
    commandRouter: router,
    getAuthStatus: async () => authSnapshot(),
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

test('!login pi oauth lists only OAuth-login-capable providers', async () => {
  const fixture = setup();

  fixture.dispatch('!login pi oauth', 'slack:C-oauth-list', fixture.adapter);
  await flush();
  const button = actionButton(fixture.adapter);
  await fixture.adapter.simulateAction(button.actionId, button.value, {
    channelId: 'slack:C-oauth-list', triggerId: 'slack:oauth-list-trigger',
  });
  const providerModal = fixture.adapter.modals.at(-1)!;
  const providerField = providerModal.modal.fields[0];
  assert.equal(providerField.type, 'select');
  assert.deepEqual(providerField.options.map(option => option.value), ['oauth-only']);

  await fixture.adapter.simulateModalSubmit('cmd_login_submit', {
    login_provider: { selection: { selectedOption: { value: 'oauth-only' } } },
  }, { privateMetadata: providerModal.modal.privateMetadata });
  await flush();
  assert.equal(fixture.auth.starts[0].authType, 'oauth');
  assert.equal(fixture.auth.starts[0].provider, 'oauth-only');
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

function updateFlow(
  fixture: ReturnType<typeof setup>,
  transform: (state: LoginFlowState) => LoginFlowState,
): void {
  const current = fixture.auth.states.get('flow-claude-anthropic');
  assert.ok(current);
  fixture.auth.states.set(current.flowId, transform(current));
}

function serializedMessages(adapter: MockAdapter): string {
  return JSON.stringify({ posted: adapter.posted, updated: adapter.updated, modals: adapter.modals });
}

async function showNotice(
  fixture: ReturnType<typeof setup>,
  notice: LoginFlowNotice,
): Promise<void> {
  updateFlow(fixture, state => ({ ...state, notice }));
  await delay(75);
}

async function showStaticNotices(fixture: ReturnType<typeof setup>): Promise<void> {
  await showNotice(fixture, {
    kind: 'info', message: 'Provider information',
    links: [{ label: 'Help', url: 'https://help.example.test/oauth' }],
  });
  await showNotice(fixture, {
    kind: 'auth_url', url: 'https://login.example.test/authorize?state=fixture',
    instructions: 'Open the authorization page.',
  });
  await showNotice(fixture, {
    kind: 'device_code', userCode: 'ABCD-EFGH',
    verificationUri: 'https://verify.example.test/device', expiresInSeconds: 600,
  });
}

async function assertProgressReplacement(fixture: ReturnType<typeof setup>): Promise<void> {
  const postedBefore = fixture.adapter.posted.length;
  await showNotice(fixture, { kind: 'progress', message: 'Waiting for authorization' });
  assert.equal(fixture.adapter.posted.length, postedBefore + 1);
  await showNotice(fixture, { kind: 'progress', message: 'Authorization received' });
  assert.equal(fixture.adapter.posted.length, postedBefore + 1);
  assert.equal(fixture.adapter.updated.length, 1);
  assert.equal(fixture.adapter.updated[0].ref.messageId, String(postedBefore + 1000));
  assert.equal(fixture.adapter.modals.length, 0);
}

function assertNoticeMessages(adapter: MockAdapter): void {
  const messages = serializedMessages(adapter);
  for (const expected of [
    'Provider information', 'https://help.example.test/oauth',
    'https://login.example.test/authorize?state=fixture', 'ABCD-EFGH',
    'https://verify.example.test/device', '600', 'Authorization received',
  ]) assert.ok(messages.includes(expected), `missing ${expected}`);
}

async function finishNoticeFlow(fixture: ReturnType<typeof setup>): Promise<void> {
  updateFlow(fixture, state => ({
    ...state, step: 'done', outcome: {
      provider: 'anthropic', authType: 'oauth', expiresAt: null,
    },
  }));
  await delay(75);
}

test.each([
  ['Slack', 'slack:C-notices'],
  ['Feishu', 'feishu:oc_notices'],
])('%s renders all LoginFlowNotice kinds and replaces progress', async (_name, channel) => {
  const fixture = setup('running');
  fixture.dispatch('!login cc oauth', channel, fixture.adapter);
  await delay(75);
  await showStaticNotices(fixture);
  await assertProgressReplacement(fixture);
  assertNoticeMessages(fixture.adapter);
  await finishNoticeFlow(fixture);
});

function registerConsumerFixture(service: AuthLoginService) {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const dispatch = registerCommands({
    scheduler: null as any,
    commandRouter: router,
    getAuthStatus: async () => authSnapshot(),
    authLogin: service,
  });
  router.bindToAdapter(adapter);
  return { adapter, dispatch };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function slackOAuthConsumer(
  submitted: ReturnType<typeof deferred>,
  received: { value: string },
): LoginFlowConsumer {
  return async (interaction) => {
    interaction.notify({
      type: 'auth_url', url: 'https://login.example.test/authorize?state=slack-fixture',
      instructions: 'Authorize the fixture.',
    });
    received.value = await interaction.prompt({
      type: 'manual_code', message: 'Paste authorization code',
    });
    submitted.resolve();
    interaction.notify({ type: 'progress', message: 'Completing authorization' });
    return { provider: 'anthropic', authType: 'oauth', expiresAt: null };
  };
}

async function submitSlackCode(
  fixture: ReturnType<typeof registerConsumerFixture>,
  code: string,
): Promise<void> {
  const button = actionButton(fixture.adapter);
  await fixture.adapter.simulateAction(button.actionId, button.value, {
    channelId: 'slack:C-oauth', triggerId: 'slack:oauth-trigger',
  });
  const modal = fixture.adapter.modals.at(-1)!;
  assert.ok(serializedMessages(fixture.adapter).includes('https://login.example.test/authorize'));
  assert.ok(!modal.modal.privateMetadata?.includes(code));
  await fixture.adapter.simulateModalSubmit('cmd_login_submit', {
    login_secret: { value: { value: code } },
  }, { privateMetadata: modal.modal.privateMetadata });
}

test('Slack OAuth runs a fake consumer through URL, manual code, and progress without echo', async () => {
  const submitted = deferred();
  const received = { value: '' };
  const service = createAuthLoginService({
    claudeOAuthConsumer: slackOAuthConsumer(submitted, received),
  });
  const fixture = registerConsumerFixture(service);
  const code = 'https://localhost/callback?code=sentinel-slack-code&state=secret-state';
  fixture.dispatch('!login cc oauth', 'slack:C-oauth', fixture.adapter);
  await delay(100);
  await submitSlackCode(fixture, code);
  await submitted.promise;
  await delay(100);
  assert.equal(received.value, code);
  assert.equal(serializedMessages(fixture.adapter).includes(code), false);
  assert.ok(serializedMessages(fixture.adapter).includes('Completing authorization'));
});

function feishuOAuthConsumer(
  authorize: ReturnType<typeof deferred>,
  finish: ReturnType<typeof deferred>,
): LoginFlowConsumer {
  return async (interaction) => {
    interaction.notify({
      type: 'device_code', userCode: 'WXYZ-1234',
      verificationUri: 'https://verify.example.test/feishu', expiresInSeconds: 300,
    });
    await authorize.promise;
    interaction.notify({ type: 'progress', message: 'Waiting for provider' });
    await finish.promise;
    interaction.notify({ type: 'progress', message: 'Provider approved' });
    return { provider: 'oauth-only', authType: 'oauth', expiresAt: null };
  };
}

test('Feishu OAuth runs a fake device consumer and updates one progress status', async () => {
  const authorize = deferred();
  const finish = deferred();
  const service = createAuthLoginService({
    piOAuthConsumerFactory: () => feishuOAuthConsumer(authorize, finish),
  });
  const fixture = registerConsumerFixture(service);
  fixture.dispatch('!login pi oauth oauth-only', 'feishu:oc_oauth', fixture.adapter);
  await delay(100);
  assert.ok(serializedMessages(fixture.adapter).includes('WXYZ-1234'));
  assert.ok(serializedMessages(fixture.adapter).includes('https://verify.example.test/feishu'));
  authorize.resolve();
  await delay(100);
  const postsAfterProgress = fixture.adapter.posted.length;
  finish.resolve();
  await delay(100);
  assert.equal(fixture.adapter.posted.length, postsAfterProgress + 1);
  assert.equal(fixture.adapter.updated.length, 1);
  assert.ok(serializedMessages(fixture.adapter).includes('Provider approved'));
  assert.equal(fixture.adapter.modals.length, 0);
});
