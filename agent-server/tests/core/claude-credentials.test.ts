import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { test } from 'vitest';

import {
  claudeCredentialsPath,
  claudeKeychainService,
  claudeOwnsOAuthCredential,
  hasClaudeCredential,
  resolveClaudeCredential,
} from '../../src/core/claude-credentials.js';
import { CLAUDE_CONFIG_HOME, CONFIG_DIR } from '../../src/core/paths.js';
import { GATEWAY_MANAGED_KEY_PLACEHOLDER } from '../../src/core/utils.js';

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

function oauthFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: 'store-token', ...overrides } });
}

test('a real ANTHROPIC_API_KEY outranks every other store', () => {
  const credential = resolveClaudeCredential({
    env: { ANTHROPIC_API_KEY: 'sk-ant-real', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat' },
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({ [CREDENTIALS]: oauthFile() }),
  });
  assert.equal(credential?.source, 'env-api-key');
  assert.equal(credential?.headers['x-api-key'], 'sk-ant-real');
  assert.equal(credential?.headers.authorization, undefined);
});

test('the gateway placeholder is not a key, so the next store answers', () => {
  const credential = resolveClaudeCredential({
    env: { ANTHROPIC_API_KEY: 'cortex-gateway-managed' },
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({ [DOTENV]: 'ANTHROPIC_API_KEY=sk-ant-from-dotenv\n' }),
  });
  assert.equal(credential?.source, 'dotenv-api-key');
  assert.equal(credential?.headers['x-api-key'], 'sk-ant-from-dotenv');
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

test('a .env OAuth token is the fallback when the store has no usable token', () => {
  const credential = resolveClaudeCredential({
    env: {},
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({
      [DOTENV]: 'CLAUDE_CODE_OAUTH_TOKEN=dotenv-token\n',
      [CREDENTIALS]: oauthFile({ expiresAt: 1_000 }),
    }),
    now: () => 2_000_000,
  });
  assert.equal(credential?.source, 'dotenv-oauth-token');
  assert.equal(credential?.headers.authorization, 'Bearer dotenv-token');
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
  const owns = claudeOwnsOAuthCredential({
    env: {},
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({ [CREDENTIALS]: oauthFile() }),
    platform: 'darwin',
    probeKeychain: () => { probed += 1; return false; },
  });
  assert.equal(owns, true);
  assert.equal(probed, 0);
});

test('on macOS the keychain settles ownership when there is no plaintext store', () => {
  const services: string[] = [];
  const owns = claudeOwnsOAuthCredential({
    env: {},
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({}),
    platform: 'darwin',
    probeKeychain: (service) => { services.push(service); return true; },
  });
  assert.equal(owns, true);
  assert.deepEqual(services, ['Claude Code-credentials-7a2726fb']);
});

test('off macOS the file is the whole answer — no keychain probe is ever spawned', () => {
  let probed = 0;
  const owns = claudeOwnsOAuthCredential({
    env: {},
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({}),
    platform: 'linux',
    probeKeychain: () => { probed += 1; return true; },
  });
  assert.equal(owns, false);
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

test('a host with no Claude store, key or token has no Claude credential', () => {
  assert.equal(hasClaudeCredential({
    env: { ANTHROPIC_API_KEY: GATEWAY_MANAGED_KEY_PLACEHOLDER },
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({}),
    platform: 'linux',
  }), false);
});

test('an expired login still counts as a Claude credential — Claude Code refreshes it', () => {
  assert.equal(hasClaudeCredential({
    env: {},
    claudeConfigDir: CLAUDE_DIR,
    readFile: reader({ [CREDENTIALS]: oauthFile({ expiresAt: 1_000, refreshToken: 'refresh' }) }),
    now: () => 2_000_000,
    platform: 'linux',
  }), true);
});

test('a saved API key or an ambient auth token counts as a Claude credential', () => {
  const base = { claudeConfigDir: CLAUDE_DIR, platform: 'linux' as const };
  assert.equal(hasClaudeCredential({
    ...base, env: {}, readFile: reader({ [DOTENV]: 'ANTHROPIC_API_KEY=sk-saved\n' }),
  }), true);
  assert.equal(hasClaudeCredential({
    ...base, env: { ANTHROPIC_AUTH_TOKEN: 'proxy-token' }, readFile: reader({}),
  }), true);
});
