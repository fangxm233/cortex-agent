// input:  EventBus, MockAdapter, auth-watch registration, locale state
// output: routing, debounce, recovery, fallback, and isolation regressions
// pos:    Covers user-visible authentication-required notifications
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { setLocale } from '../src/core/i18n.js';
import { ctx as jobCtx } from '../src/domain/scheduling/job-registry.js';
import { registerAuthWatch } from '../src/domain/auth/auth-watch.js';
import { EventBus } from '../src/events/event-bus.js';
import type { CortexEvent } from '../src/events/event-types.js';
import { MockAdapter, type PostedMessage } from '../src/platform/testing.js';

const HOUR_MS = 60 * 60 * 1000;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(initialNow = 0) {
  const bus = new EventBus();
  const adapter = new MockAdapter({ adminChannel: 'slack:admin' });
  const clock = { now: initialNow };
  jobCtx.bus = bus;
  registerAuthWatch(bus, adapter, () => clock.now);
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
  assert.match(messages[0].text, /claude \/login/);
  assert.equal(messages[0].text.includes('backend-session-456'), false);
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
  assert.match(feishuText, /运行 `pi`，然后输入 `\/login`/);
  assert.match(posts[1].content.text, /openrouter/);
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

test('an unresolved pair is delivered again after 24 hours', async () => {
  const { bus, adapter, clock } = setup();

  publishRequired(bus);
  await flush();
  clock.now = 24 * HOUR_MS + 1;
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

test('an adapter failure is contained and does not block other subscribers', async () => {
  const { bus, adapter } = setup();
  adapter.failPostMessageCount = 1;
  let observed = 0;
  bus.subscribe('auth.required', () => { observed += 1; });

  publishRequired(bus);
  await flush();
  publishRequired(bus, { provider: 'openrouter' });
  await flush();

  assert.equal(observed, 2);
  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].destination.type, 'interactive-reply');
});
