// input:  EventBus, MockAdapter, auth-watch registration, locale state
// output: action, retry, debounce, recovery, and privacy regressions
// pos:    Covers user-visible authentication-required notifications
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { setLocale } from '../src/core/i18n.js';
import { ctx as jobCtx } from '../src/domain/scheduling/job-registry.js';
import {
  initAuthEvents,
  publishAuthRecovered,
  publishAuthRequired,
} from '../src/domain/auth/auth-events.js';
import { createAuthLoginService } from '../src/domain/auth/login-service.js';
import { registerAuthWatch } from '../src/domain/auth/auth-watch.js';
import { EventBus } from '../src/events/event-bus.js';
import type { CortexEvent } from '../src/events/event-types.js';
import { CommandActionRouter } from '../src/orchestration/interactions/command-action-router.js';
import {
  buildAuthRequiredLoginAction,
} from '../src/orchestration/routing/commands/login-notice.js';
import { registerCommands } from '../src/orchestration/routing/commands/index.js';
import { MockAdapter, type PostedMessage } from '../src/platform/testing.js';

const HOUR_MS = 60 * 60 * 1000;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function authSnapshot() {
  return {
    generatedAt: '2030-01-01T00:00:00.000Z',
    accounts: [
      { backend: 'claude', provider: 'anthropic', capabilities: ['api_key', 'oauth'] },
      { backend: 'pi', provider: 'deepseek', capabilities: ['api_key'] },
      { backend: 'pi', provider: 'openai-codex', capabilities: ['oauth'] },
      { backend: 'pi', provider: 'openrouter', capabilities: ['api_key'] },
    ],
    piRuntime: { available: true, version: 'test', entry: null, error: null },
  } as any;
}

function setup(initialNow = 0) {
  const bus = new EventBus();
  const adapter = new MockAdapter({ adminChannel: 'slack:admin' });
  const clock = { now: initialNow };
  jobCtx.bus = bus;
  registerAuthWatch(bus, adapter, {
    now: () => clock.now,
    readStatus: async () => authSnapshot(),
    buildPlatformAction: buildAuthRequiredLoginAction,
  });
  return { bus, adapter, clock };
}

function publishRequired(
  bus: EventBus,
  overrides: Partial<Extract<CortexEvent, { type: 'auth.required' }>> = {},
): void {
  bus.publish({
    type: 'auth.required',
    backend: 'pi',
    provider: 'deepseek',
    authType: 'api_key',
    kind: 'invalid_api_key',
    channel: 'slack:C1',
    sessionId: 'session-internal-123',
    ...overrides,
  });
}

afterEach(() => {
  initAuthEvents(null);
  jobCtx.bus = null;
  setLocale('en');
});

function assertWebDelivery(messages: Extract<CortexEvent, { type: 'session.message' }>[]): void {
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sessionId, 'web-session');
  assert.equal(messages[0].channel, 'web:web-session');
  assert.equal(messages[0].noticeLevel, 'error');
  assert.match(messages[0].text, /claude/);
  assert.match(messages[0].text, /anthropic/);
  assert.match(messages[0].text, /invalid API key/);
  assert.match(messages[0].text, /one-click login action/i);
  assert.deepEqual((messages[0] as any).authAction, {
    kind: 'auth-login',
    noticeId: (messages[0] as any).authAction.noticeId,
    backend: 'claude',
    provider: 'anthropic',
    authType: 'oauth',
  });
  assert.equal(messages[0].text.includes('backend-session-456'), false);
  assert.equal(JSON.stringify((messages[0] as any).authAction).includes('backend-session-456'), false);
}

function assertPlatformDeliveries(posts: PostedMessage[]): void {
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((post) => post.destination), [
    { type: 'interactive-reply', conduit: 'feishu:oc_chat', sessionId: 'session-internal-123' },
    { type: 'interactive-reply', conduit: 'slack:C2', sessionId: 'session-internal-123' },
  ]);
  const feishuText = posts[0].content.text;
  assert.match(feishuText, /pi/);
  assert.match(feishuText, /openai-codex/);
  assert.match(feishuText, /OAuth 登录已过期/);
  assert.match(feishuText, /下方的一键登录操作/);
  assert.match(posts[1].content.text, /openrouter/);
  const actions = posts.map(post => post.content.richBlocks?.find(block => block.type === 'actions'));
  assert.ok(actions.every(block => block?.type === 'actions'));
  const metadata = actions.map(block => JSON.parse((block as any).elements[0].value));
  assert.equal(metadata[0].authType, 'oauth');
  assert.equal(metadata[1].authType, 'api_key');
  assert.equal(JSON.stringify(metadata).includes('session-internal-123'), false);
}

test('a single auth.required routes once through Web, Feishu, and Slack with localized guidance', async () => {
  const { bus, adapter } = setup();
  const webMessages: Extract<CortexEvent, { type: 'session.message' }>[] = [];
  bus.subscribe('session.message', (event) => { webMessages.push(event); });
  setLocale('en');
  publishRequired(bus, {
    backend: 'claude', provider: 'anthropic', authType: 'api_key',
    channel: 'web:web-session', sessionId: 'backend-session-456',
  });
  setLocale('zh');
  publishRequired(bus, {
    provider: 'openai-codex', authType: 'oauth', kind: 'oauth_expired',
    channel: 'feishu:oc_chat',
  });
  setLocale('en');
  publishRequired(bus, { provider: 'openrouter', channel: 'slack:C2' });
  await flush();

  assertWebDelivery(webMessages);
  assertPlatformDeliveries(adapter.posted);
});

test('a repeated unresolved pair within 24 hours is suppressed', async () => {
  const { bus, adapter, clock } = setup();

  publishRequired(bus);
  await flush();
  clock.now = 24 * HOUR_MS - 1;
  publishRequired(bus);
  await flush();

  assert.equal(adapter.posted.length, 1);
});

test('an unresolved pair is delivered again at exactly 24 hours', async () => {
  const { bus, adapter, clock } = setup();

  publishRequired(bus);
  await flush();
  clock.now = 24 * HOUR_MS;
  publishRequired(bus);
  await flush();

  assert.equal(adapter.posted.length, 2);
});

test('auth.recovered clears the pair so the next failure delivers immediately', async () => {
  const { bus, adapter, clock } = setup();

  publishRequired(bus);
  await flush();
  clock.now = HOUR_MS;
  bus.publish({ type: 'auth.recovered', backend: 'pi', provider: 'deepseek' });
  publishRequired(bus);
  await flush();

  assert.equal(adapter.posted.length, 2);
});

function authCardCount(adapter: MockAdapter): number {
  return adapter.posted.filter(post => (
    post.content.richBlocks?.some(block => block.type === 'actions')
  )).length;
}

function recoveryLoginService(bus: EventBus) {
  return createAuthLoginService({
    claudeOAuthConsumer: async interaction => {
      await interaction.prompt({ type: 'manual_code', message: 'Enter code' });
      publishAuthRecovered({ backend: 'claude', provider: 'anthropic' });
      return { provider: 'anthropic', authType: 'oauth', expiresAt: null };
    },
  });
}

async function submitNoticeLogin(adapter: MockAdapter): Promise<void> {
  const action = adapter.posted[0].content.richBlocks?.find(block => block.type === 'actions');
  assert.ok(action?.type === 'actions');
  await adapter.simulateAction(action.elements[0].actionId, action.elements[0].value, {
    channelId: 'slack:C-recovery', messageRef: { conduit: 'slack:C-recovery', messageId: '1000' },
  });
  const modal = adapter.modals.at(-1)?.modal;
  assert.ok(modal);
  await adapter.simulateModalSubmit('cmd_login_submit', {
    login_secret: { value: { value: 'sentinel-recovery-code' } },
  }, { privateMetadata: modal.privateMetadata });
}

test('expired notice to one-click success recovers once and resets the reminder lifecycle', async () => {
  const { bus, adapter } = setup();
  const router = new CommandActionRouter();
  registerCommands({
    scheduler: null, commandRouter: router, getAuthStatus: async () => authSnapshot(),
    authLogin: recoveryLoginService(bus),
  });
  router.bindToAdapter(adapter);
  initAuthEvents(bus);
  const recovered: CortexEvent[] = [];
  bus.subscribe('auth.recovered', event => { recovered.push(event); });

  publishAuthRequired({
    backend: 'claude', provider: 'anthropic', authType: null,
    kind: 'oauth_expired', channel: 'slack:C-recovery', sessionId: 'session-private',
  });
  await flush();
  await submitNoticeLogin(adapter);
  await new Promise(resolve => setTimeout(resolve, 75));

  assert.equal(recovered.length, 1);
  assert.equal(authCardCount(adapter), 1);
  assert.equal(JSON.stringify(adapter).includes('sentinel-recovery-code'), false);
  publishRequired(bus, { backend: 'claude', provider: 'anthropic', channel: 'slack:C-recovery' });
  await flush();
  assert.equal(authCardCount(adapter), 2);
});

test('a null channel uses the system-notice path once', async () => {
  const { bus, adapter } = setup();
  const notices: Extract<CortexEvent, { type: 'system.notice' }>[] = [];
  bus.subscribe('system.notice', (event) => { notices.push(event); });

  publishRequired(bus, { channel: null, sessionId: null });
  await flush();

  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, 'error');
  assert.match(notices[0].text, /pi/);
  assert.equal(adapter.posted.length, 1);
  assert.deepEqual(adapter.posted[0].destination, { type: 'system-notice' });
});

test('a failed delivery remains retryable without blocking other subscribers', async () => {
  const { bus, adapter } = setup();
  adapter.failPostMessageCount = 1;
  let observed = 0;
  bus.subscribe('auth.required', () => { observed += 1; });

  publishRequired(bus);
  await flush();
  publishRequired(bus);
  await flush();

  assert.equal(observed, 2);
  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].destination.type, 'interactive-reply');
});
