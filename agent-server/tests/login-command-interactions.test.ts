// input:  !login command registry, CommandActionRouter, and stub auth service
// output: Chat auth notice, validation, expiry, and privacy regressions
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
  expiresAt = '2030-01-01T00:30:00.000Z',
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
    expiresAt,
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
  expiresAt = '2030-01-01T00:30:00.000Z',
) {
  const starts: StartLoginFlowInput[] = [];
  const responses: Array<{ flowId: string; value: string }> = [];
  const states = new Map<string, LoginFlowState>();
  const service: AuthLoginService = {
    start: async input => {
      starts.push(input);
      const state = flowState(input, startStep, startNotice, expiresAt);
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
      {
        backend: 'pi', provider: 'dual-auth', label: 'Dual auth', capabilities: ['api_key', 'oauth'],
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
  expiresAt = '2030-01-01T00:30:00.000Z',
  readStatus = async () => authSnapshot(),
) {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const auth = makeAuthService(startStep, startNotice, expiresAt);
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

async function chooseClaudeAuth(
  fixture: Pick<ReturnType<typeof setup>, 'adapter' | 'dispatch'>,
  authType: 'api_key' | 'oauth',
  channel = 'slack:C1',
): Promise<void> {
  fixture.dispatch('!login cc', channel, fixture.adapter);
  await flush();
  const button = actionButton(fixture.adapter);
  await fixture.adapter.simulateAction(button.actionId, button.value, {
    channelId: channel, triggerId: `${channel}:auth-type`,
  });
  await flush();
  const modal = fixture.adapter.modals.at(-1)!;
  await fixture.adapter.simulateModalSubmit('cmd_login_submit', {
    login_auth_type: { selection: { selectedOption: { value: authType } } },
  }, { privateMetadata: modal.modal.privateMetadata });
  await flush();
}

test('!login cc selects auth type before submitting a Slack secret without posting it', async () => {
  const fixture = setup();
  const secret = 'sentinel-slack-secret';

  assert.equal(fixture.dispatch('!login cc', 'slack:C1', fixture.adapter), true);
  await flush();
  assert.equal(fixture.auth.starts.length, 0);

  const selectorButton = actionButton(fixture.adapter);
  assert.equal(selectorButton.actionId, 'cmd:login:open');
  await fixture.adapter.simulateAction(selectorButton.actionId, selectorButton.value, {
    channelId: 'slack:C2', triggerId: 'slack:forged',
  });
  assert.equal(fixture.adapter.modals.length, 0);
  await fixture.adapter.simulateAction(selectorButton.actionId, selectorButton.value, {
    channelId: 'slack:C1', triggerId: 'slack:auth-type',
  });
  const selector = fixture.adapter.modals.at(-1)!;
  assert.deepEqual(selector.modal.fields.map(field => field.type), ['select']);
  const authField = selector.modal.fields[0];
  assert.equal(authField.type, 'select');
  assert.deepEqual(authField.options.map(option => option.value), ['api_key', 'oauth']);
  await fixture.adapter.simulateModalSubmit('cmd_login_submit', {
    login_auth_type: { selection: { selectedOption: { value: 'forged-auth' } } },
  }, { privateMetadata: selector.modal.privateMetadata });
  assert.equal(fixture.auth.starts.length, 0);
  await fixture.adapter.simulateModalSubmit('cmd_login_submit', {
    login_auth_type: { selection: { selectedOption: { value: 'api_key' } } },
  }, { privateMetadata: selector.modal.privateMetadata });
  await flush();
  assert.deepEqual(fixture.auth.starts[0], {
    backend: 'claude', provider: 'anthropic', authType: 'api_key',
    channel: 'slack:C1', sessionId: null,
  });

  const promptButton = actionButton(fixture.adapter);
  await fixture.adapter.simulateAction(promptButton.actionId, promptButton.value, {
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
  await chooseClaudeAuth(fixture, 'api_key');
  const postsBeforePrompt = fixture.adapter.posted.length;
  assert.deepEqual(fixture.adapter.modals.at(-1)?.modal.fields.map(field => field.type), ['select']);

  const running = fixture.auth.states.get('flow-claude-anthropic')!;
  fixture.auth.states.set(running.flowId, {
    ...running,
    step: 'prompt',
    pendingPrompt: { kind: 'secret', message: 'Enter key' },
  });
  await delay(150);

  assert.equal(fixture.adapter.posted.length, postsBeforePrompt + 1);
  assert.equal(actionButton(fixture.adapter).actionId, 'cmd:login:open');
});

test('a pre-prompt flow disappearance posts a localized expiry failure', async () => {
  const fixture = setup('running', null, new Date(Date.now() + 50).toISOString());
  await chooseClaudeAuth(fixture, 'api_key');
  fixture.auth.states.delete('flow-claude-anthropic');
  await delay(150);

  assert.match(fixture.adapter.posted.at(-1)?.content.text ?? '', /expired/i);
});

test('a post-response flow disappearance posts a localized expiry failure', async () => {
  const fixture = setup();
  await chooseClaudeAuth(fixture, 'api_key');
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
  assert.deepEqual(providerField.options.map(option => option.value), [
    'deepseek', 'oauth-only', 'dual-auth',
  ]);

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

test('!login pi skips auth selection for a single-capability explicit provider', async () => {
  const fixture = setup();

  fixture.dispatch('!login pi deepseek', 'slack:C2', fixture.adapter);
  await flush();
  fixture.dispatch('!login pi oauth-only', 'slack:C3', fixture.adapter);
  await flush();

  assert.deepEqual(fixture.auth.starts.map(start => ({
    provider: start.provider, authType: start.authType,
  })), [
    { provider: 'deepseek', authType: 'api_key' },
    { provider: 'oauth-only', authType: 'oauth' },
  ]);
});

test('Feishu provider action returns before status discovery settles', async () => {
  let statusCalls = 0;
  const pendingStatus = new Promise<ReturnType<typeof authSnapshot>>(() => {});
  const fixture = setup('prompt', null, undefined, async () => {
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

test('!login pi selects auth type only for a dual-capability provider', async () => {
  const fixture = setup();

  fixture.dispatch('!login pi dual-auth', 'slack:C-dual', fixture.adapter);
  await flush();
  assert.equal(fixture.auth.starts.length, 0);
  const button = actionButton(fixture.adapter);
  await fixture.adapter.simulateAction(button.actionId, button.value, {
    channelId: 'slack:C-dual', triggerId: 'slack:dual-trigger',
  });
  const authModal = fixture.adapter.modals.at(-1)!;
  const authField = authModal.modal.fields[0];
  assert.equal(authField.type, 'select');
  assert.deepEqual(authField.options.map(option => option.value), ['api_key', 'oauth']);

  await fixture.adapter.simulateModalSubmit('cmd_login_submit', {
    login_auth_type: { selection: { selectedOption: { value: 'oauth' } } },
  }, { privateMetadata: authModal.modal.privateMetadata });
  await flush();
  assert.equal(fixture.auth.starts[0].authType, 'oauth');
  assert.equal(fixture.auth.starts[0].provider, 'dual-auth');
});

test('!login does not add explicit OAuth command arguments', async () => {
  const fixture = setup();

  fixture.dispatch('!login cc oauth', 'slack:C-usage', fixture.adapter);
  await flush();

  assert.equal(fixture.auth.starts.length, 0);
  assert.match(fixture.adapter.posted.at(-1)?.content.text ?? '', /!login \[status\|cc\|pi \[provider\]\]/);
});

test('Feishu form callback returns before backend login settlement', async () => {
  const fixture = setup();
  fixture.auth.service.respond = async () => new Promise<LoginFlowState>(() => {});
  await chooseClaudeAuth(fixture, 'api_key', 'feishu:oc_fast');
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
  const modalsBefore = fixture.adapter.modals.length;
  await showNotice(fixture, { kind: 'progress', message: 'Waiting for authorization' });
  assert.equal(fixture.adapter.posted.length, postedBefore + 1);
  await showNotice(fixture, { kind: 'progress', message: 'Authorization received' });
  assert.equal(fixture.adapter.posted.length, postedBefore + 1);
  assert.equal(fixture.adapter.updated.length, 1);
  assert.equal(fixture.adapter.updated[0].ref.messageId, String(postedBefore + 1000));
  assert.equal(fixture.adapter.modals.length, modalsBefore);
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
  await chooseClaudeAuth(fixture, 'oauth', channel);
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
  await chooseClaudeAuth(fixture, 'oauth', 'slack:C-oauth');
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
  fixture.dispatch('!login pi oauth-only', 'feishu:oc_oauth', fixture.adapter);
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
