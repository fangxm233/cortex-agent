import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeConnections, type StoredConnection } from '../../../src/core/connections-file.js';
import { createCredentialInventory } from '../../../src/domain/connections/inventory.js';

const KEYS = ['fake-relay-key-0001', 'fake-ds-key-000002', 'fake-local-key-0003'];
const CONNECTIONS: StoredConnection[] = [
  { id: 'relay', backend: 'claude', label: 'Relay', baseUrl: 'https://relay.example.com', authStyle: 'bearer',
    key: KEYS[0], billing: 'metered', models: ['claude-sonnet-x'] },
  { id: 'deepseek', backend: 'pi', provider: 'deepseek', baseUrl: 'https://deepseek-relay.example.com', key: KEYS[1] },
  { id: 'openai', backend: 'pi', provider: 'openai', baseUrl: 'https://proxy.example.com/v1' },
  { id: 'local', backend: 'pi', provider: 'local', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8000/v1',
    key: KEYS[2], models: [{ id: 'm1' }] },
];
let dir: string;

function claudeDeps(login: boolean, env: NodeJS.ProcessEnv = {}) {
  const claudeConfigDir = path.join(dir, login ? 'claude-login' : 'claude-empty');
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  if (login) {
    fs.writeFileSync(path.join(claudeConfigDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
      accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3_600_000 } }));
  }
  return { claudeConfigDir, env, platform: 'linux' as const };
}

function inventory(login: boolean, env: NodeJS.ProcessEnv = {}) {
  return createCredentialInventory({
    file: path.join(dir, 'connections.json'), claude: claudeDeps(login, env), piAuthPath: path.join(dir, 'auth.json'),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-'));
  writeConnections(CONNECTIONS, path.join(dir, 'connections.json'));
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    'openai-codex': { type: 'oauth', access: 'fake' }, deepseek: { type: 'api_key', key: 'fake' },
  }));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('credential inventory', () => {
  it('lists the Claude subscription first when Claude holds a login, then the file in order', () => {
    const views = inventory(true).list();
    expect(views.map((view) => `${view.backend}:${view.id}:${view.kind}`)).toEqual([
      'claude:subscription:subscription', 'claude:relay:key', 'pi:deepseek:override', 'pi:openai:override', 'pi:local:custom',
    ]);
    expect(inventory(true).defaultClaudeConnection()).toBe('subscription');
  });

  it('has no subscription without a login, so the first stored Claude connection is the default', () => {
    const subject = inventory(false);
    expect(subject.findClaude('subscription')).toBeNull();
    expect(subject.defaultClaudeConnection()).toBe('relay');
    expect(subject.hasClaude()).toBe(true);
  });

  it('counts a legacy static token as the subscription only while Claude\'s store is empty', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'fake-static-token' };
    expect(inventory(false, env).defaultClaudeConnection()).toBe('subscription');
    expect(inventory(false, env).claudeSubscriptionSource()).toBe('env-oauth-token');
    expect(inventory(true, env).claudeSubscriptionSource()).toBe('claude-store');
    expect(inventory(false).claudeSubscriptionSource()).toBeNull();
  });

  it('describes each connection without ever exposing its key', () => {
    const views = inventory(true).list();
    const serialized = JSON.stringify(views);
    for (const key of KEYS) expect(serialized).not.toContain(key);
    expect(views.find((view) => view.id === 'relay')).toMatchObject({
      baseUrl: 'https://relay.example.com', authStyle: 'bearer', keyHint: 'fak…0001', models: ['claude-sonnet-x'],
    });
    expect(inventory(true).findPi('local')).toMatchObject({ api: 'openai-completions', models: ['m1'], authenticated: true });
  });

  it('marks a base-URL override authenticated only when it carries its key', () => {
    expect(inventory(true).findPi('deepseek')?.authenticated).toBe(true);
    expect(inventory(true).findPi('openai')?.authenticated).toBe(false);
  });

  it('bills the subscription and PI OAuth logins as subscriptions, everything else as metered', () => {
    const subject = inventory(true);
    expect(subject.billingOf({ backend: 'claude', provider: null, connection: null })).toBe('subscription');
    expect(subject.billingOf({ backend: 'claude', provider: null, connection: 'relay' })).toBe('metered');
    expect(subject.billingOf({ backend: 'pi', provider: 'openai-codex', connection: null })).toBe('subscription');
    expect(subject.billingOf({ backend: 'pi', provider: 'deepseek', connection: null })).toBe('metered');
    expect(inventory(false).billingOf({ backend: 'claude', provider: null, connection: null })).toBe('metered');
  });

  it('bills a subscription-only PI provider as a subscription without a live login', () => {
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ openai: { type: 'oauth', access: 'fake' } }));
    const subject = inventory(true);
    for (const provider of ['openai-codex', 'google-gemini-cli', 'google-antigravity']) {
      expect(subject.billingOf({ backend: 'pi', provider, connection: null })).toBe('subscription');
    }
    expect(subject.billingOf({ backend: 'pi', provider: 'openai', connection: null }),
      'a key-less override keeps the billing of the login underneath').toBe('subscription');
    expect(subject.billingOf({ backend: 'pi', provider: 'github-copilot', connection: null })).toBe('metered');
  });

  it('bills a PI provider as metered when its connection carries a key, whatever the login underneath', () => {
    writeConnections([
      { id: 'openai-codex', backend: 'pi', provider: 'openai-codex', baseUrl: 'http://proxy.invalid:1' },
      { id: 'deepseek', backend: 'pi', provider: 'deepseek', baseUrl: 'https://relay.example.com', key: KEYS[1] },
      { id: 'local', backend: 'pi', provider: 'local', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8000/v1',
        models: [{ id: 'm1' }] },
    ], path.join(dir, 'connections.json'));
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ deepseek: { type: 'oauth', access: 'fake' } }));
    const subject = inventory(true);
    expect(subject.billingOf({ backend: 'pi', provider: 'openai-codex', connection: null })).toBe('subscription');
    expect(subject.billingOf({ backend: 'pi', provider: 'deepseek', connection: null })).toBe('metered');
    expect(subject.billingOf({ backend: 'pi', provider: 'local', connection: null })).toBe('metered');
  });
});
