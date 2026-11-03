// A PI account signs in, out and reports status against its own agent dir's auth.json; the
// provider's default login keeps PI's own store. Adding one picks how it signs in, and never takes
// a provider's name as its id.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeConnections } from '../../../src/core/connections-file.js';
import { PI_ACCOUNTS_HOME } from '../../../src/core/paths.js';
import { addAccount, removeAccount } from '../../../src/domain/auth/accounts.js';
import { getAuthStatus, preferredAuthType } from '../../../src/domain/auth/auth-status.js';
import type { LoginFlowState, StartLoginFlowInput } from '../../../src/domain/auth/login-flow.js';
import { createAuthLoginService, type AuthLoginService, type LoginFlowHooks } from '../../../src/domain/auth/login-service.js';
import { logoutAccount } from '../../../src/domain/auth/logout.js';
import { loginPiApiKey } from '../../../src/domain/auth/pi-login.js';
import type { LoadPiRuntimeOptions, PiCredential, PiModelRuntime, PiRuntimeLoadResult } from '../../../src/domain/auth/pi-runtime.js';
import { findAccount } from '../../../src/domain/connections/accounts.js';

const PROVIDERS = [
  { id: 'openai-codex', capabilities: ['oauth' as const] },
  { id: 'deepseek', capabilities: ['api_key' as const] },
  { id: 'openai', capabilities: ['api_key' as const, 'oauth' as const] },
];
const piProviders = async () => PROVIDERS;
/** The default login's store, inside the test home: never the user's own `~/.pi`. */
const DEFAULT_AUTH = path.join(process.env.CORTEX_HOME!, 'pi-default', 'auth.json');

beforeEach(() => {
  writeConnections([]);
  fs.rmSync(PI_ACCOUNTS_HOME, { recursive: true, force: true });
});

function fakeLogin() {
  const calls: Array<{ input: StartLoginFlowInput; hooks?: LoginFlowHooks }> = [];
  const service: AuthLoginService = {
    start: async (input, hooks) => {
      calls.push({ input, hooks });
      return { flowId: 'flow', connection: input.connection ?? null } as LoginFlowState;
    },
    getState: () => null,
    respond: async () => { throw new Error('unused'); },
    cancel: async () => { throw new Error('unused'); },
  };
  return { service, calls };
}

function signIn(id: string, provider: string, credential: PiCredential): void {
  const dir = path.join(PI_ACCOUNTS_HOME, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ [provider]: credential }));
}

/** A ChatGPT-shaped token: only its payload is ever read. */
function fakeToken(claims: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
}

/** A PI runtime whose stored credentials are the auth.json files on disk. */
function fakeRuntime(seen: Array<LoadPiRuntimeOptions | undefined>, logout = vi.fn(async () => {})) {
  const runtime = {
    getProviders: () => PROVIDERS.map((provider) => ({
      id: provider.id, name: provider.id,
      auth: Object.fromEntries(provider.capabilities.map((type) => [type === 'oauth' ? 'oauth' : 'apiKey', { login: async () => ({}) }])),
    })),
    getProviderAuthStatus: () => ({ configured: false }),
    login: vi.fn(async () => ({ type: 'api_key', key: 'fake-key' })),
    logout,
  } as unknown as PiModelRuntime;
  // Only ever the test home's files: the default path would be the real user's PI store.
  const readStoredCredential = (provider: string, authPath?: string): PiCredential | undefined => {
    if (!authPath?.startsWith(PI_ACCOUNTS_HOME)) return undefined;
    try { return JSON.parse(fs.readFileSync(authPath, 'utf8'))[provider]; } catch { return undefined; }
  };
  const load = async (options?: LoadPiRuntimeOptions): Promise<PiRuntimeLoadResult> => {
    seen.push(options);
    return { available: true, version: 'test', entry: 'test', error: null, runtime, readStoredCredential };
  };
  return { load, runtime, logout };
}

describe('adding a PI account', () => {
  it('signs in with OAuth where the provider offers it, in the account\'s own dir', async () => {
    const { service, calls } = fakeLogin();
    const result = await addAccount({ backend: 'pi', label: 'Lab', provider: 'openai-codex' }, { login: service, piProviders });
    expect(result).toMatchObject({ ok: true, account: { id: 'lab', backend: 'pi', provider: 'openai-codex', label: 'Lab' } });
    expect(calls[0]?.input).toMatchObject({ backend: 'pi', provider: 'openai-codex', connection: 'lab', authType: 'oauth' });
    expect(JSON.parse(fs.readFileSync(path.join(PI_ACCOUNTS_HOME, 'lab', 'settings.json'), 'utf8')).transport).toBe('sse');
    await calls[0]?.hooks?.onSuccess?.();
    expect(findAccount({ backend: 'pi', id: 'lab' })?.pending).toBeUndefined();
  });

  it('signs in with an API key where that is all the provider offers, or where it is asked for', async () => {
    const { service, calls } = fakeLogin();
    await addAccount({ backend: 'pi', label: 'Work', provider: 'deepseek' }, { login: service, piProviders });
    await addAccount({ backend: 'pi', label: 'Key', provider: 'openai', authType: 'api_key' }, { login: service, piProviders });
    expect(calls.map((call) => call.input.authType)).toEqual(['api_key', 'api_key']);
  });

  it('never takes a provider\'s name as its id', async () => {
    const { service } = fakeLogin();
    const result = await addAccount({ backend: 'pi', label: 'DeepSeek', provider: 'deepseek' }, { login: service, piProviders });
    expect(result).toMatchObject({ ok: true, account: { id: 'deepseek-2' } });
  });

  it('refuses a way of signing in the provider does not offer, and a missing provider', async () => {
    const { service, calls } = fakeLogin();
    expect(await addAccount({ backend: 'pi', label: 'X', provider: 'deepseek', authType: 'oauth' }, { login: service, piProviders }))
      .toEqual({ ok: false, errors: ['not-supported'] });
    expect(await addAccount({ backend: 'pi', label: 'X' }, { login: service, piProviders }))
      .toEqual({ ok: false, errors: ['provider-required'] });
    expect(calls).toHaveLength(0);
  });

  it('drops the account and its dir when the first login fails', async () => {
    const { service, calls } = fakeLogin();
    await addAccount({ backend: 'pi', label: 'Lab', provider: 'openai-codex' }, { login: service, piProviders });
    await calls[0]?.hooks?.onFailure?.();
    expect(findAccount({ backend: 'pi', id: 'lab' })).toBeNull();
    expect(fs.existsSync(path.join(PI_ACCOUNTS_HOME, 'lab'))).toBe(false);
  });
});

describe('removing a PI account', () => {
  it('signs out the way it signed in, then deletes its dir and entry', async () => {
    writeConnections([{ id: 'work', backend: 'pi', type: 'account', provider: 'deepseek', label: 'Work' }]);
    signIn('work', 'deepseek', { type: 'api_key', key: 'fake-key' });
    const logout = vi.fn(async (input: Parameters<typeof logoutAccount>[0]) => ({ ok: true as const, ...input }));
    const result = await removeAccount({ backend: 'pi', id: 'work' }, { logout });
    expect(result).toMatchObject({ ok: true, loggedOut: true, account: { id: 'work', provider: 'deepseek' } });
    expect(logout).toHaveBeenCalledWith({ backend: 'pi', provider: 'deepseek', connection: 'work', authType: 'api_key' });
    expect(fs.existsSync(path.join(PI_ACCOUNTS_HOME, 'work'))).toBe(false);
    expect(findAccount({ backend: 'pi', id: 'work' })).toBeNull();
  });
});

describe('the login of a PI account', () => {
  it('starts the account consumer only for a stored account of the same provider', async () => {
    writeConnections([{ id: 'lab', backend: 'pi', type: 'account', provider: 'openai-codex', label: 'Lab' }]);
    const factory = vi.fn((_provider: string, _connection: string, _authType: string) => async () => (
      { provider: 'openai-codex', authType: 'oauth' as const, expiresAt: null }));
    const service = createAuthLoginService({ piAccountConsumerFactory: factory });
    const base = { backend: 'pi' as const, provider: 'openai-codex', authType: 'oauth' as const, channel: null, sessionId: null };
    expect((await service.start({ ...base, connection: 'lab' })).connection).toBe('lab');
    expect(factory).toHaveBeenCalledWith('openai-codex', 'lab', 'oauth');
    await expect(service.start({ ...base, provider: 'deepseek', connection: 'lab' })).rejects.toMatchObject({ code: 'account_not_found' });
  });

  it('stores the key through a runtime over the account\'s auth.json and recovers the account', async () => {
    const seen: Array<LoadPiRuntimeOptions | undefined> = [];
    const { load } = fakeRuntime(seen);
    const authPath = path.join(PI_ACCOUNTS_HOME, 'work', 'auth.json');
    const recovered = await loginPiApiKey('deepseek', { prompt: async () => 'k', notify: () => {} } as never, {
      loadRuntime: load, refreshProviders: () => {}, authPath, connection: 'work',
    });
    expect(recovered.ok).toBe(true);
    expect(seen).toEqual([{ authPath }]);
  });
});

describe('a PI account in the auth status', () => {
  it('has a row of its own, from its own auth.json, with the ChatGPT identity', async () => {
    writeConnections([
      { id: 'lab', backend: 'pi', type: 'account', provider: 'openai-codex', label: 'Lab' },
      { id: 'gone', backend: 'pi', type: 'account', provider: 'deepseek', label: 'Gone' },
    ]);
    const access = fakeToken({ 'https://api.openai.com/profile': { email: 'lab@example.edu' },
      'https://api.openai.com/auth': { chatgpt_plan_type: 'team' } });
    signIn('lab', 'openai-codex', { type: 'oauth', access, refresh: 'fake', expires: Date.now() + 30 * 86_400_000 });
    const { load } = fakeRuntime([]);
    const snapshot = await getAuthStatus({
      loadPiRuntime: load, piAuthPath: DEFAULT_AUTH, listFavorites: () => [], getActiveBackend: () => 'claude',
    });
    const lab = snapshot.accounts.find((row) => row.connection === 'lab');
    expect(lab).toMatchObject({
      backend: 'pi', provider: 'openai-codex', isDefault: false, label: 'Lab', authType: 'oauth', state: 'logged-in',
      identity: { email: 'lab@example.edu', organization: null, plan: 'team' }, capabilities: ['oauth'],
    });
    expect(snapshot.accounts.find((row) => row.connection === 'gone')).toMatchObject({ state: 'logged-out', inUse: false, credentials: [] });
    expect(snapshot.accounts.find((row) => row.backend === 'pi' && row.provider === 'openai-codex' && row.isDefault)?.connection).toBeNull();
  });

  it('signs in again the way the account signed in first', () => {
    const row = { backend: 'pi', provider: 'openai', connection: 'key', authType: 'api_key', capabilities: ['api_key', 'oauth'] };
    expect(preferredAuthType({ accounts: [row] } as never, 'pi', 'openai', 'key')).toBe('api_key');
  });
});

describe('logging a PI account out', () => {
  it('removes the credential from the account\'s auth.json, not the default login\'s', async () => {
    writeConnections([{ id: 'work', backend: 'pi', type: 'account', provider: 'deepseek', label: 'Work' }]);
    signIn('work', 'deepseek', { type: 'api_key', key: 'fake-key' });
    const seen: Array<LoadPiRuntimeOptions | undefined> = [];
    const { load, logout } = fakeRuntime(seen);
    const result = await logoutAccount(
      { backend: 'pi', provider: 'deepseek', connection: 'work', authType: 'api_key' },
      {
        loadPiRuntime: load, refreshProviders: () => {}, piAuthPath: DEFAULT_AUTH,
        getAuthStatusOptions: { loadPiRuntime: load, listFavorites: () => [], getActiveBackend: () => 'claude' },
      },
    );
    expect(result.ok).toBe(true);
    expect(logout).toHaveBeenCalledWith('deepseek');
    expect(seen.at(-1)).toEqual({ authPath: path.join(PI_ACCOUNTS_HOME, 'work', 'auth.json') });
  });
});
