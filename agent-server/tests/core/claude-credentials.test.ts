import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';

import {
  claudeCredentialsPath,
  claudeKeychainCredential,
  claudeKeychainService,
  claudeSubscriptionLogin,
  officialApiKeyConnection,
  resolveAnthropicApiKey,
  resolveClaudeCredential,
} from '../../src/core/claude-credentials.js';
import { writeConnections, type StoredConnection } from '../../src/core/connections-file.js';
import { CLAUDE_CONFIG_HOME, CONFIG_DIR } from '../../src/core/paths.js';

const CLAUDE_DIR = '/fixture/.claude';
const CREDENTIALS = path.join(CLAUDE_DIR, '.credentials.json');
const DOTENV = path.join(CONFIG_DIR, '.env');

function reader(files: Record<string, string>) {
  return (filePath: string): string => {
    const content = files[filePath];
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  };
}

function connectionsFile(connections: StoredConnection[]): string {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'claude-cred-conn-')), 'connections.json');
  writeConnections(connections, file);
  return file;
}

const OFFICIAL_KEY: StoredConnection = {
  id: 'api', backend: 'claude', label: 'API', authStyle: 'x-api-key', key: 'sk-ant-fake-official', billing: 'metered',
};
const RELAY_KEY: StoredConnection = {
  id: 'relay', backend: 'claude', label: 'Relay', baseUrl: 'https://relay.example.invalid',
  authStyle: 'x-api-key', key: 'sk-fake-relay', billing: 'metered',
};

function oauthFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: 'store-token', ...overrides } });
}

test('the official-API key connection outranks every other store', () => {
  const credential = resolveClaudeCredential({
    env: { ANTHROPIC_API_KEY: 'sk-ant-fake-env', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat' },
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({ [CREDENTIALS]: oauthFile() }),
    connectionsFile: connectionsFile([RELAY_KEY, OFFICIAL_KEY]),
  });
  assert.equal(credential?.source, 'connection-api-key');
  assert.equal(credential?.headers['x-api-key'], 'sk-ant-fake-official');
  assert.equal(credential?.headers.authorization, undefined);
});

test('a relay key and an env or .env API key are not the daemon key, so the next store answers', () => {
  const deps = {
    env: { ANTHROPIC_API_KEY: 'sk-ant-fake-env' },
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({
      [DOTENV]: 'ANTHROPIC_API_KEY=sk-ant-fake-dotenv\n',
      [CREDENTIALS]: oauthFile({ expiresAt: 4_000_000_000_000 }),
    }),
    now: () => 1_000,
    connectionsFile: connectionsFile([RELAY_KEY]),
  };
  assert.equal(officialApiKeyConnection(deps), null);
  assert.equal(resolveAnthropicApiKey(deps), null);
  assert.equal(resolveClaudeCredential(deps)?.source, 'claude-credentials');
});

test('a bearer connection without a base URL is not the official-API key', () => {
  const bearer: StoredConnection = { ...OFFICIAL_KEY, id: 'bearer', authStyle: 'bearer' };
  const deps = { connectionsFile: connectionsFile([bearer, OFFICIAL_KEY]) };
  assert.equal(officialApiKeyConnection(deps)?.id, 'api');
  assert.equal(resolveAnthropicApiKey(deps), 'sk-ant-fake-official');
});

test("Claude's own store answers last, as a Bearer token with the oauth beta", () => {
  const credential = resolveClaudeCredential({
    env: {},
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({ [CREDENTIALS]: oauthFile({ expiresAt: 4_000_000_000_000 }) }),
    now: () => 1_000,
  });
  assert.equal(credential?.source, 'claude-credentials');
  assert.equal(credential?.headers.authorization, 'Bearer store-token');
  assert.equal(credential?.headers['anthropic-beta'], 'oauth-2025-04-20');
});

test("Claude's own store outranks an OAuth token from the env or .env", () => {
  const credential = resolveClaudeCredential({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token' },
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({
      [DOTENV]: 'CLAUDE_CODE_OAUTH_TOKEN=dotenv-token\n',
      [CREDENTIALS]: oauthFile({ expiresAt: 4_000_000_000_000 }),
    }),
    now: () => 1_000,
  });
  assert.equal(credential?.source, 'claude-credentials');
  assert.equal(credential?.headers.authorization, 'Bearer store-token');
});

test('a .env OAuth token answers only while Claude\'s store holds nothing', () => {
  const credential = resolveClaudeCredential({
    env: {},
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({ [DOTENV]: 'CLAUDE_CODE_OAUTH_TOKEN=dotenv-token\n' }),
  });
  assert.equal(credential?.source, 'dotenv-oauth-token');
  assert.equal(credential?.headers.authorization, 'Bearer dotenv-token');
});

test('an expired store still owns the subscription: a static token never stands in for it', () => {
  const deps = {
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token' },
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({
      [DOTENV]: 'CLAUDE_CODE_OAUTH_TOKEN=dotenv-token\n',
      [CREDENTIALS]: oauthFile({ expiresAt: 1_000 }),
    }),
    now: () => 2_000_000,
  };
  assert.deepEqual(claudeSubscriptionLogin(deps), { source: 'claude-store', token: null });
  assert.equal(resolveClaudeCredential(deps), null);
});

test('without a store, the env token outranks the .env token, and neither means signed out', () => {
  const dotenv = reader({ [DOTENV]: 'CLAUDE_CODE_OAUTH_TOKEN=dotenv-token\n' });
  assert.deepEqual(
    claudeSubscriptionLogin({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token' }, claudeConfigDir: CLAUDE_DIR, readFile: dotenv }),
    { source: 'env-oauth-token', token: 'env-token' },
  );
  assert.deepEqual(
    claudeSubscriptionLogin({ env: {}, claudeConfigDir: CLAUDE_DIR, readFile: dotenv }),
    { source: 'dotenv-oauth-token', token: 'dotenv-token' },
  );
  assert.equal(claudeSubscriptionLogin({ env: {}, claudeConfigDir: CLAUDE_DIR, readFile: reader({}), platform: 'linux' }), null);
});

test('an expired access token is not a credential — only Claude Code can refresh it', () => {
  const credential = resolveClaudeCredential({
    env: {},
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({ [CREDENTIALS]: oauthFile({ expiresAt: 1_000 }) }),
    now: () => 2_000_000,
  });
  assert.equal(credential, null);
});

test('a host with no store at all yields no credential rather than an error', () => {
  assert.equal(resolveClaudeCredential({
    env: {}, claudeConfigDir: CLAUDE_DIR, readFile: reader({}),
  }), null);
});

test('the plaintext store settles ownership without ever touching the keychain', () => {
  let probed = 0;
  const owns = claudeSubscriptionLogin({
    env: {},
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({ [CREDENTIALS]: oauthFile() }),
    platform: 'darwin',
    probeKeychain: () => { probed += 1; return false; },
  });
  assert.equal(owns?.source, 'claude-store');
  assert.equal(probed, 0);
});

test('on macOS the keychain settles ownership when there is no plaintext store', () => {
  const services: string[] = [];
  const owns = claudeSubscriptionLogin({
    env: {},
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({}),
    platform: 'darwin',
    probeKeychain: (service) => { services.push(service); return true; },
  });
  assert.equal(owns?.source, 'claude-store');
  assert.deepEqual(services, ['Claude Code-credentials-7a2726fb']);
});

test('off macOS the file is the whole answer — no keychain probe is ever spawned', () => {
  let probed = 0;
  const owns = claudeSubscriptionLogin({
    env: {},
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({}),
    platform: 'linux',
    probeKeychain: () => { probed += 1; return true; },
  });
  assert.equal(owns, null);
  assert.equal(probed, 0);
});

test('the keychain item name always carries the digest of Cortex\'s config dir, as the CLI derives it', () => {
  const digest = (dir: string) => createHash('sha256').update(dir).digest('hex').slice(0, 8);
  assert.equal(claudeKeychainService(), `Claude Code-credentials-${digest(CLAUDE_CONFIG_HOME)}`);
  assert.equal(claudeKeychainService({ env: { CLAUDE_CONFIG_DIR: '/elsewhere' } }),
    `Claude Code-credentials-${digest(CLAUDE_CONFIG_HOME)}`, 'an inherited CLAUDE_CONFIG_DIR is not ours');
  assert.equal(claudeKeychainService({ claudeConfigDir: '/a' }), `Claude Code-credentials-${digest('/a')}`);
});

test('the credential store defaults to Cortex\'s own Claude config dir, never an inherited one', () => {
  const expected = path.join(CLAUDE_CONFIG_HOME, '.credentials.json');
  assert.equal(claudeCredentialsPath(), expected);
  assert.equal(claudeCredentialsPath({ env: { CLAUDE_CONFIG_DIR: '/elsewhere' } }), expected);
});

test('the keychain credential reads the item named for Cortex\'s config dir, as a Bearer token', async () => {
  const services: string[] = [];
  const credential = await claudeKeychainCredential({
    claudeConfigDir: CLAUDE_DIR,
    platform: 'darwin',
    now: () => 1_000,
    readKeychain: async (service) => { services.push(service); return oauthFile({ expiresAt: 4_000_000_000_000 }); },
  });
  assert.deepEqual(services, ['Claude Code-credentials-7a2726fb']);
  assert.equal(credential?.source, 'claude-keychain');
  assert.equal(credential?.headers.authorization, 'Bearer store-token');
});

test('an expired, missing or corrupt keychain item is no credential', async () => {
  const base = { claudeConfigDir: CLAUDE_DIR, platform: 'darwin' as const, now: () => 5_000_000 };
  for (const raw of [oauthFile({ expiresAt: 1_000 }), null, 'not json']) {
    assert.equal(await claudeKeychainCredential({ ...base, readKeychain: async () => raw }), null);
  }
});

test('off macOS the keychain is never read', async () => {
  let reads = 0;
  const credential = await claudeKeychainCredential({
    claudeConfigDir: CLAUDE_DIR,
    platform: 'linux',
    readKeychain: async () => { reads += 1; return oauthFile(); },
  });
  assert.equal(credential, null);
  assert.equal(reads, 0);
});
