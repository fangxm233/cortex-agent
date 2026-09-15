import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'vitest';

import {
  claudeKeychainService,
  claudeOwnsOAuthCredential,
  resolveClaudeCredential,
} from '../../src/core/claude-credentials.js';
import { CONFIG_DIR } from '../../src/core/utils.js';

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

test('the keychain item name carries a config-dir digest only when one was configured', () => {
  assert.equal(claudeKeychainService({ env: {} }), 'Claude Code-credentials');
  assert.match(claudeKeychainService({ env: { CLAUDE_CONFIG_DIR: '/a' } }),
    /^Claude Code-credentials-[0-9a-f]{8}$/);
});
