// input:  temp auth files, saved expiry, logout adapters
// output: logout ownership, state, privacy regressions
// pos:    Backend account logout regression tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import type { GetAuthStatusOptions } from '../../src/domain/auth/auth-status.js';
import type {
  PiModelRuntime,
  PiProviderAuthStatus,
  PiRuntimeLoadResult,
} from '../../src/domain/auth/pi-runtime.js';

const API_KEY = '\uE401\uE402-api-key';
const OAUTH_TOKEN = '\uE403\uE404-oauth-token';
const OAUTH_EXPIRES_AT = '2999-01-01T00:00:00.000Z';
const EXTERNAL_ACCESS = '\uE405\uE406-access';
const EXTERNAL_REFRESH = '\uE407\uE408-refresh';
const TEST_HOME = process.env.CORTEX_HOME!;
const ENV_FILE = path.join(TEST_HOME, 'config', '.env');
const REAL_ENV_FILE = path.join(os.homedir(), '.cortex', 'config', '.env');
const REAL_PI_AUTH = path.join(os.homedir(), '.pi', 'agent', 'auth.json');
let consoleCalls: unknown[][] = [];

type LogoutModule = typeof import('../../src/domain/auth/logout.js');
type ConfigModule = typeof import('../../src/domain/agents/config.js');
type StatusModule = typeof import('../../src/domain/auth/auth-status.js');

interface FileStamp {
  exists: boolean;
  mtimeMs: number | null;
}

interface PiFixture {
  root: string;
  authPath: string;
  runtime: PiModelRuntime;
  loader: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  statusOptions: GetAuthStatusOptions;
}

function fileStamp(filePath: string): FileStamp {
  try {
    return { exists: true, mtimeMs: fs.statSync(filePath).mtimeMs };
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
    return { exists: false, mtimeMs: null };
  }
}

function liveFileStamps(): Record<string, FileStamp> {
  return {
    [REAL_ENV_FILE]: fileStamp(REAL_ENV_FILE),
    [REAL_PI_AUTH]: fileStamp(REAL_PI_AUTH),
  };
}

function assertLiveFilesUnchanged(before: Record<string, FileStamp>): void {
  for (const [filePath, stamp] of Object.entries(before)) {
    assert.deepEqual(fileStamp(filePath), stamp, `${filePath} mtime changed`);
  }
}

function writeFile(filePath: string, contents: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode });
}

function unavailablePi(): PiRuntimeLoadResult {
  return {
    available: false, version: null, entry: null, error: 'fixture unavailable',
    runtime: null, readStoredCredential: null,
  };
}

function claudeStatusOptions(root: string, mode: 'api' | 'plan'): GetAuthStatusOptions {
  return {
    claudeCredentialsPath: path.join(root, '.claude', '.credentials.json'),
    piAuthPath: path.join(root, '.pi', 'agent', 'auth.json'),
    loadPiRuntime: async () => unavailablePi(),
    getClaudeMode: () => mode,
    getActiveBackend: () => 'claude',
    listProfiles: () => [],
  };
}

async function resetSavedEnv(): Promise<ConfigModule> {
  const config = await import('../../src/domain/agents/config.js');
  await config.removeAnthropicApiKey();
  await config.removeClaudeCodeOAuthToken();
  writeFile(ENV_FILE, '', 0o600);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT;
  return config;
}

async function accountStatus(options: GetAuthStatusOptions) {
  const status = await import('../../src/domain/auth/auth-status.js') as StatusModule;
  const snapshot = await status.getAuthStatus(options);
  const account = snapshot.accounts.find(item => item.backend === options.getActiveBackend?.());
  assert.ok(account);
  return account;
}

function expectSecretFree(value: unknown, secrets: string[]): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    for (const fragment of [...secret.slice(0, 2)]) assert.equal(serialized.includes(fragment), false);
  }
}

function createPiFixture(source: NonNullable<PiProviderAuthStatus['source']>): PiFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-logout-pi-'));
  const authPath = path.join(root, 'auth.json');
  writeFile(authPath, '{"owner":"pi-runtime"}\n');
  let configured = true;
  const logout = vi.fn(async () => { configured = false; });
  const runtime = {
    getProviders: () => [{ id: 'deepseek', name: 'DeepSeek', auth: { apiKey: { login: async () => ({ type: 'api_key' }) } } }],
    getProviderAuthStatus: () => configured
      ? { configured: true, source }
      : { configured: false },
    login: async () => ({ type: 'api_key' as const }),
    logout,
  } as PiModelRuntime;
  const loader = vi.fn(async (_options?: { authPath?: string }): Promise<PiRuntimeLoadResult> => ({
    available: true, version: 'fixture', entry: '/fixture/pi.js', error: null, runtime,
    readStoredCredential: () => configured && source === 'stored'
      ? { type: 'api_key', key: API_KEY }
      : undefined,
  }));
  const refresh = vi.fn();
  return { root, authPath, runtime, loader, logout, refresh,
    statusOptions: piStatusOptions(authPath, loader) };
}

function piStatusOptions(
  authPath: string,
  loader: PiFixture['loader'],
): GetAuthStatusOptions {
  return {
    claudeCredentialsPath: path.join(path.dirname(authPath), 'missing-claude.json'),
    piAuthPath: authPath,
    loadPiRuntime: loader,
    getSavedApiEnv: () => ({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
    }),
    getClaudeMode: () => 'plan',
    getActiveBackend: () => 'pi',
    listProfiles: () => [],
    getActiveProfileConfig: () => ({ backend: 'pi', provider: 'deepseek' }),
  };
}

function disposePiFixture(fixture: PiFixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

beforeEach(async () => {
  consoleCalls = [];
  for (const method of ['debug', 'log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args) => { consoleCalls.push(args); });
  }
  assert.notEqual(path.resolve(TEST_HOME), path.join(os.homedir(), '.cortex'));
  await resetSavedEnv();
});

test('PI stored logout delegates to runtime without Cortex writing auth.json', async () => {
  const liveBefore = liveFileStamps();
  const fixture = createPiFixture('stored');
  const authBefore = fs.readFileSync(fixture.authPath, 'utf8');
  const authStamp = fileStamp(fixture.authPath);
  const { logoutAccount } = await import('../../src/domain/auth/logout.js') as LogoutModule;
  try {
    assert.equal((await accountStatus(fixture.statusOptions)).state, 'logged-in');
    const result = await logoutAccount(
      { backend: 'pi', provider: 'deepseek', authType: 'api_key' },
      { piAuthPath: fixture.authPath, getAuthStatusOptions: fixture.statusOptions,
        loadPiRuntime: fixture.loader, refreshProviders: fixture.refresh },
    );
    assert.deepEqual(result, {
      ok: true, backend: 'pi', provider: 'deepseek', authType: 'api_key',
    });
    assert.deepEqual(fixture.logout.mock.calls, [['deepseek']]);
    assert.equal(fixture.loader.mock.calls.every(([options]) => (
      options?.authPath === fixture.authPath
    )), true);
    assert.equal(fixture.refresh.mock.calls.length, 1);
    assert.equal(fs.readFileSync(fixture.authPath, 'utf8'), authBefore);
    assert.deepEqual(fileStamp(fixture.authPath), authStamp, 'Cortex must not write PI auth.json');
    assert.equal((await accountStatus(fixture.statusOptions)).state, 'logged-out');
    expectSecretFree([result, consoleCalls], [API_KEY]);
  } finally {
    disposePiFixture(fixture);
    assertLiveFilesUnchanged(liveBefore);
  }
});

async function assertAmbientPiNotManageable(source: NonNullable<PiProviderAuthStatus['source']>) {
  const fixture = createPiFixture(source);
  const authBefore = fs.readFileSync(fixture.authPath, 'utf8');
  const { logoutAccount } = await import('../../src/domain/auth/logout.js') as LogoutModule;
  try {
    const result = await logoutAccount(
      { backend: 'pi', provider: 'deepseek', authType: 'api_key' },
      { piAuthPath: fixture.authPath, getAuthStatusOptions: fixture.statusOptions,
        loadPiRuntime: fixture.loader, refreshProviders: fixture.refresh },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'not_manageable');
    assert.equal(fixture.logout.mock.calls.length, 0);
    assert.equal(fixture.refresh.mock.calls.length, 0);
    assert.equal(fs.readFileSync(fixture.authPath, 'utf8'), authBefore);
  } finally {
    disposePiFixture(fixture);
  }
}

test('PI ambient credential sources return not_manageable without deletion attempts', async () => {
  const liveBefore = liveFileStamps();
  for (const source of [
    'runtime', 'environment', 'fallback', 'models_json_key', 'models_json_command',
  ] as const) await assertAmbientPiNotManageable(source);
  assertLiveFilesUnchanged(liveBefore);
});

async function assertGatewayPlaceholderIgnored(
  logoutAccount: LogoutModule['logoutAccount'],
  options: GetAuthStatusOptions,
): Promise<unknown> {
  writeFile(ENV_FILE, 'ANTHROPIC_API_KEY=cortex-gateway-managed\n');
  process.env.ANTHROPIC_API_KEY = 'cortex-gateway-managed';
  const before = fs.readFileSync(ENV_FILE, 'utf8');
  const result = await logoutAccount(
    { backend: 'claude', provider: 'anthropic', authType: 'api_key' },
    { getAuthStatusOptions: options },
  );
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(ENV_FILE, 'utf8'), before);
  return result;
}

async function assertOAuthLogoutEffects(
  options: GetAuthStatusOptions,
  credentialsPath: string,
  credentialsBefore: string,
  credentialsStamp: FileStamp,
  result: unknown,
): Promise<void> {
  assert.equal((result as { ok: boolean }).ok, true);
  assert.equal((await accountStatus(options)).state, 'logged-out');
  const persisted = fs.readFileSync(ENV_FILE, 'utf8');
  assert.match(persisted, /^OTHER_SETTING=keep$/m);
  assert.doesNotMatch(persisted, /^CLAUDE_CODE_OAUTH_TOKEN=/m);
  assert.doesNotMatch(persisted, /^CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT=/m);
  assert.equal(fs.statSync(ENV_FILE).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(credentialsPath, 'utf8'), credentialsBefore);
  assert.deepEqual(fileStamp(credentialsPath), credentialsStamp);
  expectSecretFree([result, consoleCalls], [OAUTH_TOKEN]);
}

test('Claude API-key logout removes only the saved key and ignores the gateway placeholder', async () => {
  const liveBefore = liveFileStamps();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-logout-cc-key-'));
  const config = await resetSavedEnv();
  writeFile(ENV_FILE, 'OTHER_SETTING=keep\n');
  await config.saveAnthropicApiKey(API_KEY);
  const options = claudeStatusOptions(root, 'api');
  const { logoutAccount } = await import('../../src/domain/auth/logout.js') as LogoutModule;
  try {
    const result = await logoutAccount(
      { backend: 'claude', provider: 'anthropic', authType: 'api_key' },
      { getAuthStatusOptions: options },
    );
    assert.equal(result.ok, true);
    assert.equal((await accountStatus(options)).state, 'logged-out');
    assert.match(fs.readFileSync(ENV_FILE, 'utf8'), /^OTHER_SETTING=keep$/m);
    assert.doesNotMatch(fs.readFileSync(ENV_FILE, 'utf8'), /ANTHROPIC_API_KEY/);
    assert.equal(fs.statSync(ENV_FILE).mode & 0o777, 0o600);
    const placeholder = await assertGatewayPlaceholderIgnored(logoutAccount, options);
    expectSecretFree([result, placeholder, consoleCalls], [API_KEY]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    assertLiveFilesUnchanged(liveBefore);
  }
});

test('Claude OAuth logout removes only saved env and leaves credentials.json untouched', async () => {
  const liveBefore = liveFileStamps();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-logout-cc-oauth-'));
  const options = claudeStatusOptions(root, 'plan');
  const credentialsPath = options.claudeCredentialsPath!;
  writeFile(credentialsPath, '{"owner":"anthropic"}\n');
  const credentialsBefore = fs.readFileSync(credentialsPath, 'utf8');
  const credentialsStamp = fileStamp(credentialsPath);
  const config = await resetSavedEnv();
  writeFile(ENV_FILE, [
    'OTHER_SETTING=keep',
    `CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT=${OAUTH_EXPIRES_AT}`,
    '',
  ].join('\n'));
  await config.saveClaudeCodeOAuthToken(OAUTH_TOKEN, OAUTH_EXPIRES_AT);
  const { logoutAccount } = await import('../../src/domain/auth/logout.js') as LogoutModule;
  try {
    const before = await accountStatus(options);
    assert.equal(before.source, 'env');
    const result = await logoutAccount(
      { backend: 'claude', provider: 'anthropic', authType: 'oauth' },
      { getAuthStatusOptions: options },
    );
    await assertOAuthLogoutEffects(
      options, credentialsPath, credentialsBefore, credentialsStamp, result,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    assertLiveFilesUnchanged(liveBefore);
  }
});

test('Claude credentials.json-only OAuth returns external_credential with terminal guidance', async () => {
  const liveBefore = liveFileStamps();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-logout-external-'));
  const options = claudeStatusOptions(root, 'plan');
  const credentialsPath = options.claudeCredentialsPath!;
  writeFile(credentialsPath, JSON.stringify({ claudeAiOauth: {
    accessToken: EXTERNAL_ACCESS, refreshToken: EXTERNAL_REFRESH,
  } }));
  const credentialsBefore = fs.readFileSync(credentialsPath, 'utf8');
  const credentialsStamp = fileStamp(credentialsPath);
  const { logoutAccount } = await import('../../src/domain/auth/logout.js') as LogoutModule;
  try {
    const result = await logoutAccount(
      { backend: 'claude', provider: 'anthropic', authType: 'oauth' },
      { getAuthStatusOptions: options },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'external_credential');
    assert.match(result.error.message, /claude \/logout/);
    assert.equal(fs.readFileSync(credentialsPath, 'utf8'), credentialsBefore);
    assert.deepEqual(fileStamp(credentialsPath), credentialsStamp);
    assert.equal((await accountStatus(options)).state, 'logged-in');
    expectSecretFree([result, consoleCalls], [EXTERNAL_ACCESS, EXTERNAL_REFRESH]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    assertLiveFilesUnchanged(liveBefore);
  }
});
