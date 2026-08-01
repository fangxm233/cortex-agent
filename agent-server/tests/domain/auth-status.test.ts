// input:  temporary auth files and installed PI fixtures
// output: authentication snapshot behavior contracts
// pos:    Backend authentication status regression tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { getSavedApiEnv } from '../../src/domain/agents/config.js';
import {
  getAuthStatus,
  type AuthStatusSnapshot,
} from '../../src/domain/auth/auth-status.js';
import { loadPiRuntime, type PiRuntimeLoadResult } from '../../src/domain/auth/pi-runtime.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse('2030-01-01T00:00:00.000Z');

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
  { id: 'models-key', name: 'Models Key', auth: { apiKey: {} } },
  { id: 'runtime-plus-stored', name: 'Runtime Override', auth: { apiKey: {}, oauth: {} } },
];

const RUNTIME_FIXTURE_SOURCE = `
import { readFileSync } from 'node:fs';
const providers = ${JSON.stringify(providers)};
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
    if (providerId === 'models-key') return { configured: true, source: 'models_json_key' };
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
  assert.deepEqual(override.credentials.map(item => item.authType), ['api_key', 'oauth']);
  assert.equal(override.credentials[0]?.manageable, false);
  assert.equal(override.credentials[1]?.source, 'stored');
  assert.equal(override.credentials[1]?.manageable, true);
}

function writeStateCredentials(fixture: PiFixture, secrets: string[]): void {
  writeJson(fixture.authPath, {
    fresh: { type: 'oauth', access: secrets[3], refresh: secrets[4], expires: NOW_MS + 7 * DAY_MS },
    soon: { type: 'oauth', access: secrets[4], refresh: secrets[5], expires: NOW_MS + 7 * DAY_MS - 1 },
    expired: { type: 'oauth', access: secrets[5], refresh: secrets[3], expires: NOW_MS - 1 },
    'runtime-plus-stored': {
      type: 'oauth', access: secrets[6], refresh: secrets[7], expires: NOW_MS + 30 * DAY_MS,
    },
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
    '\uE112\uE113', '\uE114\uE115', '\uE116\uE117', '\uE118\uE119',
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
    assert.equal(oauthAccount.refreshExpiresAt, new Date(NOW_MS + DAY_MS).toISOString());
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
