// input:  temporary auth files, PI fixtures, locale
// output: auth states, expiry, capability, summaries
// pos:    Backend authentication status regression tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { getSavedApiEnv } from '../../src/domain/agents/config.js';
import { formatAuthStatusSummary } from '../../src/domain/auth/auth-format.js';
import {
  getAuthStatus,
  preferredAuthType,
  type AuthStatusSnapshot,
} from '../../src/domain/auth/auth-status.js';
import { getLocale, setLocale } from '../../src/core/i18n.js';
import { loadPiRuntime, type PiRuntimeLoadResult } from '../../src/domain/auth/pi-runtime.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse('2030-01-01T00:00:00.000Z');

test('preferred auth type uses probed capabilities with OAuth first', () => {
  const snapshot = {
    accounts: [
      { backend: 'pi', provider: 'dual', capabilities: ['api_key', 'oauth'] },
      { backend: 'pi', provider: 'key-only', capabilities: ['api_key'] },
    ],
  } as AuthStatusSnapshot;

  assert.equal(preferredAuthType(snapshot, 'pi', 'dual'), 'oauth');
  assert.equal(preferredAuthType(snapshot, 'pi', 'key-only'), 'api_key');
  assert.equal(preferredAuthType(snapshot, 'pi', 'missing'), null);
});

interface PiFixture {
  root: string;
  binPath: string;
  authPath: string;
  entryPath: string;
}

const providers = [
  { id: 'fresh', name: 'Fresh OAuth', auth: { oauth: {} } },
  { id: 'soon', name: 'Soon OAuth', auth: { apiKey: {}, oauth: {} } },
  { id: 'expired', name: 'Expired OAuth', auth: { oauth: {} } },
  { id: 'logged-out', name: 'Logged Out', auth: { apiKey: {} } },
  { id: 'environment', name: 'Environment Key', auth: { apiKey: {} } },
  { id: 'fallback', name: 'Fallback Key', auth: { apiKey: {} } },
  { id: 'models-key', name: 'Models Key', auth: { apiKey: {} } },
  { id: 'models-command', name: 'Models Command', auth: { apiKey: {} } },
  { id: 'runtime-plus-stored', name: 'Runtime Override', auth: { apiKey: {}, oauth: {} } },
  { id: 'api-key-metadata-only', name: 'API Key Metadata Only', auth: { apiKey: {} } },
  { id: 'oauth-metadata-only', name: 'OAuth Metadata Only', auth: { oauth: {} } },
];

const RUNTIME_FIXTURE_SOURCE = `
import { readFileSync } from 'node:fs';
const providers = ${JSON.stringify(providers)}.map(provider => {
  if (provider.auth.apiKey && provider.id !== 'api-key-metadata-only') {
    provider.auth.apiKey.login = async () => ({});
  }
  if (provider.auth.oauth && provider.id !== 'oauth-metadata-only') {
    provider.auth.oauth.login = async () => ({});
  }
  return provider;
});
export class ModelRuntime {
  static async create(options) {
    return new ModelRuntime(options);
  }
  constructor(options) {
    this.createOptions = options;
  }
  getProviders() {
    return providers;
  }
  getRegisteredProviderIds() {
    throw new Error('getRegisteredProviderIds must not be used');
  }
  getProviderAuthStatus(providerId) {
    if (providerId === 'environment') return { configured: true, source: 'environment' };
    if (providerId === 'fallback') return { configured: true, source: 'fallback' };
    if (providerId === 'models-key') return { configured: true, source: 'models_json_key' };
    if (providerId === 'models-command') return { configured: true, source: 'models_json_command' };
    if (providerId === 'runtime-plus-stored') return { configured: true, source: 'runtime' };
    const credential = readStoredCredential(providerId, this.createOptions.authPath);
    return credential ? { configured: true, source: 'stored' } : { configured: false };
  }
}
export function readStoredCredential(providerId, authPath) {
  const data = JSON.parse(readFileSync(authPath, 'utf8'));
  return data[providerId];
}
`;

function createPiFixture(entry = './dist/index.js'): PiFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-pi-'));
  const packageRoot = path.join(root, 'package');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(packageRoot, 'dist', 'index.js'), RUNTIME_FIXTURE_SOURCE);
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'fixture-pi', version: '9.8.7', type: 'module',
    exports: { '.': { import: entry } },
  }));
  const binPath = path.join(binDir, 'pi');
  fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), binPath);
  return {
    root, binPath, authPath: path.join(root, 'auth.json'),
    entryPath: path.join(packageRoot, 'dist', 'index.js'),
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

async function loadFixture(fixture: PiFixture): Promise<PiRuntimeLoadResult> {
  return loadPiRuntime({ findPi: () => fixture.binPath, authPath: fixture.authPath });
}

function requireAvailable(result: PiRuntimeLoadResult): asserts result is Extract<PiRuntimeLoadResult, { available: true }> {
  assert.equal(result.available, true, result.error ?? 'PI runtime should be available');
}

function baseStatusOptions(
  fixture: PiFixture,
  piRuntime: PiRuntimeLoadResult,
  claudeCredentialsPath: string,
) {
  return {
    now: () => new Date(NOW_MS),
    claudeCredentialsPath,
    piAuthPath: fixture.authPath,
    loadPiRuntime: async () => piRuntime,
    getSavedApiEnv: () => ({ ANTHROPIC_API_KEY: '\uE104\uE105', ANTHROPIC_BASE_URL: undefined }),
    getClaudeMode: () => 'api',
    getActiveBackend: () => 'pi' as const,
    listProfiles: () => [
      {
        name: 'primary', model: 'fixture', backend: 'pi' as const, provider: 'fresh',
        fallback: [{ model: 'fixture-fallback', backend: 'pi' as const, provider: 'soon' }],
      },
      { name: 'claude', model: 'fixture-claude' },
    ],
    getActiveProfileConfig: () => ({ backend: 'pi' as const, provider: 'expired' }),
  };
}

function account(snapshot: AuthStatusSnapshot, provider: string) {
  const result = snapshot.accounts.find(item => item.provider === provider);
  assert.ok(result, `missing account ${provider}`);
  return result;
}

async function savedClaudeOAuthAccount(expiresAt?: string) {
  const snapshot = await getAuthStatus({
    now: () => new Date(NOW_MS),
    claudeCredentialsPath: path.join(process.env.CORTEX_HOME!, 'missing-claude.json'),
    piAuthPath: path.join(process.env.CORTEX_HOME!, 'missing-pi.json'),
    loadPiRuntime: async (): Promise<PiRuntimeLoadResult> => ({
      available: false, version: null, entry: null, error: 'fixture unavailable',
      runtime: null, readStoredCredential: null,
    }),
    getSavedApiEnv: () => ({
      ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: '\uE128\uE129',
      CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: expiresAt,
    }),
    getClaudeMode: () => 'plan',
    getActiveBackend: () => 'claude',
    listProfiles: () => [],
  });
  return account(snapshot, 'anthropic');
}

function assertFreshAccount(snapshot: AuthStatusSnapshot): void {
  const expiresAt = new Date(NOW_MS + 7 * DAY_MS).toISOString();
  assert.deepEqual(account(snapshot, 'fresh'), {
    backend: 'pi', provider: 'fresh', label: 'Fresh OAuth', capabilities: ['oauth'],
    authType: 'oauth', state: 'logged-in', source: 'stored', expiresAt,
    refreshExpiresAt: null, inUse: true,
    credentials: [{
      authType: 'oauth', state: 'logged-in', source: 'stored', expiresAt,
      refreshExpiresAt: null, manageable: true,
    }],
  });
}

function assertOtherStates(snapshot: AuthStatusSnapshot): void {
  assert.equal(account(snapshot, 'soon').state, 'expiring');
  assert.equal(account(snapshot, 'soon').credentials[0]?.state, 'expiring');
  assert.equal(account(snapshot, 'soon').inUse, true);
  assert.equal(account(snapshot, 'expired').state, 'expired');
  assert.equal(account(snapshot, 'expired').credentials[0]?.state, 'expired');
  assert.equal(account(snapshot, 'expired').inUse, true);
  assert.equal(account(snapshot, 'logged-out').state, 'logged-out');
  assert.deepEqual(account(snapshot, 'logged-out').credentials, []);
}

function assertModelsJsonKey(snapshot: AuthStatusSnapshot): void {
  assert.deepEqual(account(snapshot, 'models-key'), {
    backend: 'pi', provider: 'models-key', label: 'Models Key', capabilities: ['api_key'],
    authType: 'api_key', state: 'logged-in', source: 'models_json_key',
    expiresAt: null, refreshExpiresAt: null, inUse: false, detail: 'models_json_key',
    credentials: [{
      authType: 'api_key', state: 'logged-in', source: 'models_json_key',
      expiresAt: null, refreshExpiresAt: null, manageable: false, detail: 'models_json_key',
    }],
  });
}

function assertRuntimeOverride(snapshot: AuthStatusSnapshot): void {
  const override = account(snapshot, 'runtime-plus-stored');
  assert.equal(override.authType, 'api_key');
  assert.equal(override.source, 'runtime');
  assert.deepEqual(override.credentials.map(item => ({
    authType: item.authType, source: item.source, manageable: item.manageable,
  })), [
    { authType: 'api_key', source: 'runtime', manageable: false },
    { authType: 'api_key', source: 'stored', manageable: true },
  ]);
}

function credentialManageable(
  snapshot: AuthStatusSnapshot,
  provider: string,
  source: string,
): boolean {
  const credential = account(snapshot, provider).credentials.find(item => item.source === source);
  assert.ok(credential, `missing ${provider}/${source} credential`);
  return credential.manageable;
}

function assertManageability(snapshot: AuthStatusSnapshot): void {
  assert.equal(credentialManageable(snapshot, 'anthropic', 'credentials.json'), true, 'Claude OAuth');
  assert.equal(credentialManageable(snapshot, 'anthropic', 'env'), true, 'Claude API key');
  assert.equal(credentialManageable(snapshot, 'fresh', 'stored'), true, 'PI stored');
  assert.equal(credentialManageable(snapshot, 'runtime-plus-stored', 'runtime'), false, 'PI runtime');
  assert.equal(credentialManageable(snapshot, 'environment', 'environment'), false, 'PI environment');
  assert.equal(credentialManageable(snapshot, 'fallback', 'fallback'), false, 'PI fallback');
  assert.equal(credentialManageable(snapshot, 'models-key', 'models_json_key'), false, 'PI models key');
  assert.equal(
    credentialManageable(snapshot, 'models-command', 'models_json_command'),
    false,
    'PI models command',
  );
}

function writeStateCredentials(fixture: PiFixture, secrets: string[]): void {
  writeJson(fixture.authPath, {
    fresh: { type: 'oauth', access: secrets[3], refresh: secrets[4], expires: NOW_MS + 7 * DAY_MS },
    soon: { type: 'oauth', access: secrets[4], refresh: secrets[5], expires: NOW_MS + 7 * DAY_MS - 1 },
    expired: { type: 'oauth', access: secrets[5], refresh: secrets[3], expires: NOW_MS - 1 },
    'runtime-plus-stored': { type: 'api_key', key: secrets[6] },
  });
}

test('loadPiRuntime resolves the installed package export from the real CLI target', async () => {
  const fixture = createPiFixture();
  writeJson(fixture.authPath, {});
  try {
    const result = await loadFixture(fixture);
    requireAvailable(result);
    assert.equal(result.version, '9.8.7');
    assert.equal(result.entry, fixture.entryPath);
    assert.equal(result.error, null);
    assert.deepEqual((result.runtime as unknown as { createOptions: unknown }).createOptions, {
      authPath: fixture.authPath, allowModelNetwork: false,
    });
    assert.deepEqual(result.runtime.getProviders().map(item => item.id), providers.map(item => item.id));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('getAuthStatus normalizes all states and models_json_key without secret fragments', async () => {
  const fixture = createPiFixture();
  const claudePath = path.join(fixture.root, 'claude', '.credentials.json');
  const secrets = [
    '\uE100\uE101', '\uE102\uE103', '\uE104\uE105', '\uE110\uE111',
    '\uE112\uE113', '\uE114\uE115', '\uE116\uE117',
  ];
  writeJson(claudePath, {
    claudeAiOauth: { accessToken: secrets[0], refreshToken: secrets[1], expiresAt: NOW_MS + 10 * DAY_MS },
  });
  writeStateCredentials(fixture, secrets);
  try {
    const snapshot = await getAuthStatus(baseStatusOptions(fixture, await loadFixture(fixture), claudePath));
    assertFreshAccount(snapshot);
    assertOtherStates(snapshot);
    assertModelsJsonKey(snapshot);
    assertRuntimeOverride(snapshot);
    assertManageability(snapshot);
    assert.deepEqual(account(snapshot, 'api-key-metadata-only').capabilities, []);
    assert.deepEqual(account(snapshot, 'oauth-metadata-only').capabilities, []);
    const serialized = JSON.stringify(snapshot);
    assert.equal(secrets.flatMap(secret => [...secret]).some(part => serialized.includes(part)), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('getAuthStatus exposes both Claude credentials and mirrors the mode-selected slot', async () => {
  const fixture = createPiFixture();
  const claudePath = path.join(fixture.root, 'claude', '.credentials.json');
  writeJson(fixture.authPath, {});
  writeJson(claudePath, { claudeAiOauth: {
    accessToken: '\uE120\uE121', refreshToken: '\uE122\uE123',
    expiresAt: NOW_MS + 30 * DAY_MS, refreshTokenExpiresAt: NOW_MS + DAY_MS,
    rateLimitTier: 'fixture',
  } });
  try {
    const options = baseStatusOptions(fixture, await loadFixture(fixture), claudePath);
    const apiAccount = account(await getAuthStatus(options), 'anthropic');
    assert.equal(apiAccount.authType, 'api_key');
    assert.equal(apiAccount.state, 'logged-in');
    assert.deepEqual(apiAccount.credentials.map(item => item.authType), ['api_key', 'oauth']);
    assert.equal(apiAccount.credentials[1]?.state, 'expiring');
    const oauthAccount = account(await getAuthStatus({ ...options, getClaudeMode: () => 'plan' }), 'anthropic');
    assert.equal(oauthAccount.authType, 'oauth');
    assert.equal(oauthAccount.state, 'expiring');
    assert.equal(oauthAccount.expiresAt, new Date(NOW_MS + DAY_MS).toISOString());
    assert.equal(oauthAccount.refreshExpiresAt, null);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Claude OAuth lifetime is the refresh token, not the auto-refreshed access token', async () => {
  const fixture = createPiFixture();
  const claudePath = path.join(fixture.root, 'claude', '.credentials.json');
  writeJson(fixture.authPath, {});
  const writeOAuth = (refreshTokenExpiresAt: number) => writeJson(claudePath, { claudeAiOauth: {
    accessToken: '', refreshToken: '',
    expiresAt: NOW_MS + DAY_MS, refreshTokenExpiresAt,
  } });
  try {
    const options = {
      ...baseStatusOptions(fixture, await loadFixture(fixture), claudePath),
      getClaudeMode: () => 'plan',
    };
    writeOAuth(NOW_MS + 30 * DAY_MS);
    const healthy = account(await getAuthStatus(options), 'anthropic');
    assert.equal(healthy.state, 'logged-in');
    assert.equal(healthy.expiresAt, new Date(NOW_MS + 30 * DAY_MS).toISOString());
    assert.equal(healthy.refreshExpiresAt, null);

    writeOAuth(NOW_MS - 1);
    assert.equal(account(await getAuthStatus(options), 'anthropic').state, 'expired');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('getAuthStatus projects saved Claude subscription expiry into the F2 state', async () => {
  const fixture = createPiFixture();
  const expiry = new Date(NOW_MS + DAY_MS).toISOString();
  const savedEnv = {
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: '\uE140\uE141-managed-token',
    CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: expiry,
  };
  writeJson(fixture.authPath, {});
  try {
    const options = baseStatusOptions(
      fixture,
      await loadFixture(fixture),
      path.join(fixture.root, 'missing-claude.json'),
    );
    const claude = account(await getAuthStatus({
      ...options,
      getSavedApiEnv: () => savedEnv,
      getClaudeMode: () => 'plan',
      getActiveBackend: () => 'claude',
      listProfiles: () => [],
    }), 'anthropic');

    assert.equal(claude.state, 'expiring');
    assert.equal(claude.expiresAt, expiry);
    assert.equal(JSON.stringify(claude).includes(savedEnv.CLAUDE_CODE_OAUTH_TOKEN), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('getAuthStatus never falls back across Claude auth slots', async () => {
  const fixture = createPiFixture();
  const claudePath = path.join(fixture.root, 'claude', '.credentials.json');
  writeJson(fixture.authPath, {});
  writeJson(claudePath, { claudeAiOauth: {
    accessToken: '\uE124\uE125', refreshToken: '\uE126\uE127', expiresAt: NOW_MS + 30 * DAY_MS,
  } });
  try {
    const options = baseStatusOptions(fixture, await loadFixture(fixture), claudePath);
    const apiAccount = account(await getAuthStatus({
      ...options, getSavedApiEnv: () => ({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined }),
    }), 'anthropic');
    assert.equal(apiAccount.authType, null);
    assert.equal(apiAccount.state, 'logged-out');
    assert.deepEqual(apiAccount.credentials.map(item => item.authType), ['oauth']);
    const planAccount = account(await getAuthStatus({
      ...options, claudeCredentialsPath: path.join(fixture.root, 'missing'), getClaudeMode: () => 'plan',
    }), 'anthropic');
    assert.equal(planAccount.authType, null);
    assert.deepEqual(planAccount.credentials.map(item => item.authType), ['api_key']);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('saved Claude OAuth expiry projects valid metadata and fails open otherwise', async () => {
  const validExpiry = new Date(NOW_MS + 6 * DAY_MS).toISOString();
  const validIsoVariant = '2030-01-07T00:00:00Z';
  const cases = [
    { expiry: undefined, state: 'logged-in', projected: null },
    { expiry: 'not-an-expiry', state: 'logged-in', projected: null },
    { expiry: 'January 7, 2030 00:00:00 GMT', state: 'logged-in', projected: null },
    { expiry: validExpiry, state: 'expiring', projected: validExpiry },
    { expiry: validIsoVariant, state: 'expiring', projected: validIsoVariant },
  ] as const;

  for (const expected of cases) {
    const result = await savedClaudeOAuthAccount(expected.expiry);
    assert.deepEqual(
      { state: result.state, expiresAt: result.expiresAt },
      { state: expected.state, expiresAt: expected.projected },
    );
    assert.deepEqual(
      { state: result.credentials[0]?.state, expiresAt: result.credentials[0]?.expiresAt },
      { state: expected.state, expiresAt: expected.projected },
    );
  }
});

test('getSavedApiEnv returns defensive snapshots', () => {
  const sameReference = getSavedApiEnv() === getSavedApiEnv();
  assert.equal(sameReference, false);
});

test('PI absence and import failure degrade without suppressing Claude status', async () => {
  const missing = await loadPiRuntime({ findPi: () => { throw new Error('\uE130 secret path'); } });
  assert.equal(missing.available, false);
  assert.equal(missing.error, 'pi executable not found');
  assert.equal(JSON.stringify(missing).includes('\uE130'), false);

  const fixture = createPiFixture('./dist/missing.js');
  writeJson(fixture.authPath, {});
  const claudePath = path.join(fixture.root, 'claude', '.credentials.json');
  try {
    const failedImport = await loadFixture(fixture);
    assert.equal(failedImport.available, false);
    assert.equal(failedImport.error, 'pi runtime import failed');
    const snapshot = await getAuthStatus(baseStatusOptions(fixture, failedImport, claudePath));
    assert.equal(snapshot.accounts.length, 1);
    assert.equal(account(snapshot, 'anthropic').state, 'logged-in');
    assert.equal(snapshot.piRuntime.available, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

const SUMMARY_FIXTURE: AuthStatusSnapshot = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [
    {
      backend: 'claude', provider: 'anthropic', label: 'Anthropic', capabilities: ['api_key', 'oauth'],
      authType: 'oauth', state: 'expiring', source: 'credentials.json',
      expiresAt: '2030-01-02T00:00:00.000Z', refreshExpiresAt: null, inUse: true,
      credentials: [{
        authType: 'oauth', state: 'expiring', source: 'credentials.json',
        expiresAt: '2030-01-02T00:00:00.000Z', refreshExpiresAt: null, manageable: true,
      }],
    },
    {
      backend: 'pi', provider: 'deepseek', label: 'DeepSeek', capabilities: ['api_key'],
      authType: 'api_key', state: 'logged-in', source: 'stored', expiresAt: null,
      refreshExpiresAt: null, inUse: false, credentials: [{
        authType: 'api_key', state: 'logged-in', source: 'stored', expiresAt: null,
        refreshExpiresAt: null, manageable: true,
      }],
    },
    {
      backend: 'pi', provider: 'unused', label: 'Unused Provider', capabilities: ['api_key'],
      authType: null, state: 'logged-out', source: null, expiresAt: null,
      refreshExpiresAt: null, inUse: false, credentials: [],
    },
  ],
  piRuntime: { available: true, version: '9.8.7', entry: '/fixture/pi.js', error: null },
};

test('formatAuthStatusSummary shares a concise secret-free bilingual account view', (t) => {
  const previousLocale = getLocale();
  t.onTestFinished(() => setLocale(previousLocale));

  setLocale('en');
  const english = formatAuthStatusSummary(SUMMARY_FIXTURE);
  assert.match(english, /Authentication status/);
  assert.match(english, /Anthropic.*Expiring/s);
  assert.match(english, /DeepSeek.*Logged in/s);
  assert.match(english, /1 logged-out provider hidden/);
  assert.doesNotMatch(english, /Unused Provider|fixture-secret/);

  setLocale('zh');
  const chinese = formatAuthStatusSummary(SUMMARY_FIXTURE);
  assert.match(chinese, /认证状态/);
  assert.match(chinese, /Anthropic.*即将过期/s);
  assert.match(chinese, /DeepSeek.*已登录/s);
  assert.match(chinese, /已隐藏 1 个未登录 provider/);
  assert.doesNotMatch(chinese, /Unused Provider|fixture-secret/);
});
