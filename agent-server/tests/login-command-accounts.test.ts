import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'vitest';
import type { AuthLoginService } from '../src/domain/auth/login-service.js';
import type { LoginFlowState, StartLoginFlowInput } from '../src/domain/auth/login-flow.js';
import { formatAuthStatusSummary } from '../src/domain/auth/auth-format.js';
import { CommandActionRouter } from '../src/orchestration/interactions/command-action-router.js';
import { registerCommands } from '../src/orchestration/routing/commands/index.js';
import { MockAdapter } from '../src/platform/testing.js';

const flush = () => setImmediate();

function flowState(input: StartLoginFlowInput): LoginFlowState {
  return {
    flowId: `flow-${input.backend}-${input.provider}-${input.connection ?? ''}`, revision: 1,
    connection: input.connection ?? null, backend: input.backend, provider: input.provider, authType: input.authType,
    step: 'prompt', pendingPrompt: { id: 1, kind: 'manual_code', message: 'Paste code' }, notice: null,
    channel: input.channel, sessionId: input.sessionId, createdAt: '2030-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T00:30:00.000Z', outcome: null, error: null, errorCode: null,
  };
}

function row(fields: Record<string, unknown>) {
  return {
    backend: 'claude', provider: 'anthropic', connection: null, isDefault: true, label: 'Anthropic', identity: null,
    capabilities: ['oauth'], authType: 'oauth', state: 'logged-in', source: 'credentials.json', expiresAt: null,
    refreshExpiresAt: null, inUse: true, credentials: [], ...fields,
  };
}

function snapshot() {
  return {
    generatedAt: '2030-01-01T00:00:00.000Z',
    accounts: [
      row({ capabilities: ['api_key', 'oauth'] }),
      row({ connection: 'school', isDefault: false, label: 'School', identity: { email: 'me@school.edu', organization: null, plan: null } }),
      row({ connection: 'lab', isDefault: false, label: 'Lab', state: 'logged-out', authType: null, source: null, inUse: false }),
      row({ backend: 'pi', provider: 'deepseek', label: 'DeepSeek', capabilities: ['api_key'], authType: 'api_key', inUse: false }),
      row({ backend: 'pi', provider: 'deepseek', connection: 'ds-work', isDefault: false, label: 'Work', capabilities: ['api_key'], authType: 'api_key', inUse: false }),
    ],
    piRuntime: { available: true, version: 'test', entry: '/test/pi', error: null },
  } as any;
}

function setup() {
  const adapter = new MockAdapter();
  const router = new CommandActionRouter();
  const starts: StartLoginFlowInput[] = [];
  const authLogin: AuthLoginService = {
    start: async input => { starts.push(input); return flowState(input); },
    getState: () => null,
    respond: async () => { throw new Error('not used'); },
    cancel: async () => { throw new Error('not used'); },
  };
  const dispatch = registerCommands({
    scheduler: null as any, commandRouter: router, getAuthStatus: async () => snapshot(), authLogin,
  });
  router.bindToAdapter(adapter);
  return { adapter, starts, dispatch };
}

async function run(message: string) {
  const fixture = setup();
  fixture.dispatch(message, 'slack:C-accounts', fixture.adapter);
  await flush();
  await flush();
  return fixture;
}

const lastText = (adapter: MockAdapter) => adapter.posted.at(-1)?.content.text ?? '';

test('!login cc <account> signs that Claude account in again, found by id or by label', async () => {
  for (const name of ['school', 'SCHOOL']) {
    const { starts } = await run(`!login cc ${name}`);
    assert.deepEqual(starts.map(start => [start.backend, start.provider, start.connection, start.authType]), [
      ['claude', 'anthropic', 'school', 'oauth'],
    ]);
  }
});

test('!login pi <provider> <account> signs that PI account in again', async () => {
  const { starts } = await run('!login pi deepseek work');
  assert.deepEqual(starts.map(start => [start.backend, start.provider, start.connection, start.authType]), [
    ['pi', 'deepseek', 'ds-work', 'api_key'],
  ]);
});

test('an unknown account starts nothing and names the accounts there are', async () => {
  const { starts, adapter } = await run('!login cc nope');
  assert.equal(starts.length, 0);
  assert.match(lastText(adapter), /nope/);
  assert.match(lastText(adapter), /school/);
  assert.match(lastText(adapter), /lab/);
});

test('plain !login cc and !login pi <provider> still sign the default login in', async () => {
  const pi = await run('!login pi deepseek');
  assert.deepEqual(pi.starts.map(start => [start.provider, start.connection ?? null]), [['deepseek', null]]);
  const claude = await run('!login cc');
  assert.equal(claude.starts.length, 0);
  assert.match(lastText(claude.adapter), /Anthropic|anthropic/);
});

test('!login status lists every account with the id the commands take', () => {
  const text = formatAuthStatusSummary(snapshot());
  assert.match(text, /School \(`school`\)/);
  assert.match(text, /me@school\.edu/);
  assert.match(text, /Lab \(`lab`\)/);
  assert.match(text, /Work \(`ds-work`\)/);
  const school = text.split('\n').find(line => line.includes('`school`')) ?? '';
  assert.doesNotMatch(school, /in use/i);
});
