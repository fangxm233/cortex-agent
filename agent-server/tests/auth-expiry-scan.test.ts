// input:  fake auth snapshots, auth-watch clock, scheduling runner
// output: expiry scan filtering, actions, privacy, and debounce regressions
// pos:    Covers the daily in-use authentication warning job
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { setLocale } from '../src/core/i18n.js';
import type {
  AuthAccountState,
  AuthAccountStatus,
  AuthStatusSnapshot,
} from '../src/domain/auth/auth-status.js';
import {
  registerAuthWatch,
  wasAuthRecentlyNotified,
} from '../src/domain/auth/auth-watch.js';
import { createAuthLoginService } from '../src/domain/auth/login-service.js';
import { runAuthExpiryScan } from '../src/domain/scheduling/jobs/auth-expiry-scan.js';
import { createScheduler } from '../src/domain/scheduling/runner.js';
import { ctx as jobCtx } from '../src/domain/scheduling/job-registry.js';
import { EventBus } from '../src/events/event-bus.js';
import { CommandActionRouter } from '../src/orchestration/interactions/command-action-router.js';
import { registerCommands } from '../src/orchestration/routing/commands/index.js';
import { buildAuthRequiredLoginAction } from '../src/orchestration/routing/commands/login-notice.js';
import { MockAdapter, type PostedMessage } from '../src/platform/testing.js';

const NOW_MS = Date.parse('2030-01-01T08:30:00.000Z');
const EXPIRY = '2030-01-03T08:30:00.000Z';
const CREDENTIAL_SENTINEL = 'sk-private-scan-sentinel';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function account(
  state: AuthAccountState,
  inUse: boolean,
  overrides: Partial<AuthAccountStatus> = {},
): AuthAccountStatus {
  return {
    backend: 'pi', provider: 'openai-codex', label: 'OpenAI Codex',
    capabilities: ['oauth'], authType: 'oauth', state, source: 'stored',
    expiresAt: state === 'logged-out' ? null : EXPIRY, refreshExpiresAt: null,
    inUse, credentials: [{
      authType: 'oauth', state, source: 'stored', expiresAt: EXPIRY,
      refreshExpiresAt: null, manageable: true, detail: CREDENTIAL_SENTINEL,
    }],
    detail: CREDENTIAL_SENTINEL,
    ...overrides,
  };
}

function snapshot(accounts: AuthAccountStatus[]): AuthStatusSnapshot {
  return {
    generatedAt: new Date(NOW_MS).toISOString(), accounts,
    piRuntime: { available: true, version: 'test', entry: null, error: null },
  };
}

async function scan(
  accounts: AuthAccountStatus[],
  wasRecentlyNotified = () => false,
): Promise<MockAdapter> {
  const adapter = new MockAdapter({ adminChannel: 'slack:admin' });
  await runAuthExpiryScan(adapter, {
    now: () => NOW_MS,
    readStatus: async () => snapshot(accounts),
    wasRecentlyNotified,
    buildPlatformAction: buildAuthRequiredLoginAction,
  });
  return adapter;
}

function buttonMetadata(post: PostedMessage): Record<string, unknown> {
  const actions = post.content.richBlocks?.find(block => block.type === 'actions');
  assert.ok(actions?.type === 'actions');
  return JSON.parse(actions.elements[0].value) as Record<string, unknown>;
}

afterEach(() => {
  jobCtx.bus = null;
  setLocale('en');
});

test('all healthy in-use accounts produce no auth expiry notice', async () => {
  const adapter = await scan([
    account('logged-in', true),
    account('unknown', true, { provider: 'deepseek', capabilities: ['api_key'] }),
  ]);

  assert.equal(adapter.posted.length, 0);
});

test('an in-use expiring account produces an actionable secret-free warning', async () => {
  const adapter = await scan([account('expiring', true)]);

  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].destination.type, 'system-notice');
  assert.match(adapter.posted[0].content.text, /openai-codex/);
  assert.match(adapter.posted[0].content.text, /expiring/);
  assert.match(adapter.posted[0].content.text, new RegExp(EXPIRY));
  const metadata = buttonMetadata(adapter.posted[0]);
  assert.equal(metadata.backend, 'pi');
  assert.equal(metadata.provider, 'openai-codex');
  assert.equal(metadata.authType, 'oauth');
  assert.equal(JSON.stringify(adapter.posted).includes(CREDENTIAL_SENTINEL), false);
});

test('an in-use expired account produces an expiry warning', async () => {
  const adapter = await scan([account('expired', true)]);

  assert.equal(adapter.posted.length, 1);
  assert.match(adapter.posted[0].content.text, /expired/);
  assert.match(adapter.posted[0].content.text, new RegExp(EXPIRY));
});

test('an in-use logged-out account produces a login warning', async () => {
  const adapter = await scan([account('logged-out', true)]);

  assert.equal(adapter.posted.length, 1);
  assert.match(adapter.posted[0].content.text, /logged out/);
  assert.equal(adapter.posted[0].content.text.includes(EXPIRY), false);
});

test('a logged-out account that is not in use produces no warning', async () => {
  const adapter = await scan([account('logged-out', false)]);

  assert.equal(adapter.posted.length, 0);
});

test('a system notice action opens login in the actual admin channel', async () => {
  const adapter = await scan([account('expiring', true)]);
  const router = new CommandActionRouter();
  const authLogin = createAuthLoginService({
    piOAuthConsumerFactory: () => async interaction => {
      await interaction.prompt({ type: 'manual_code', message: 'Enter code' });
      return { provider: 'openai-codex', authType: 'oauth', expiresAt: null };
    },
  });
  registerCommands({
    scheduler: null, commandRouter: router, authLogin,
    getAuthStatus: async () => snapshot([account('expiring', true)]),
  });
  router.bindToAdapter(adapter);
  const actions = adapter.posted[0].content.richBlocks?.find(block => block.type === 'actions');
  assert.ok(actions?.type === 'actions');

  await adapter.simulateAction(actions.elements[0].actionId, actions.elements[0].value, {
    channelId: 'slack:admin', triggerId: 'scan-trigger',
  });

  assert.equal(adapter.modals.length, 1);
  assert.match(adapter.modals[0].modal.privateMetadata ?? '', /slack:admin/);
});

test('the scan skips a pair that auth-watch just reminded', async () => {
  const bus = new EventBus();
  const adapter = new MockAdapter({ adminChannel: 'slack:admin' });
  jobCtx.bus = bus;
  registerAuthWatch(bus, adapter, {
    now: () => NOW_MS,
    readStatus: async () => snapshot([account('expired', true)]),
    buildPlatformAction: buildAuthRequiredLoginAction,
  });
  bus.publish({
    type: 'auth.required', backend: 'pi', provider: 'openai-codex',
    authType: 'oauth', kind: 'oauth_expired', channel: 'slack:C1', sessionId: null,
  });
  await flush();

  assert.equal(wasAuthRecentlyNotified('pi', 'openai-codex'), true);
  await runAuthExpiryScan(adapter, {
    now: () => NOW_MS,
    readStatus: async () => snapshot([account('expired', true)]),
    wasRecentlyNotified: wasAuthRecentlyNotified,
    buildPlatformAction: buildAuthRequiredLoginAction,
  });
  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].destination.type, 'interactive-reply');
});

test('scheduled runner wires the self-registering auth expiry job', () => {
  const scheduler = createScheduler();

  assert.equal(typeof scheduler.programmaticHandlers['auth-expiry-scan'], 'function');
  scheduler.stop();
});
