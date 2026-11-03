// A Claude account signs in, out and reports status against its own config dir; the default
// subscription keeps its own. Adding an account keeps it only once its first login lands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONNECTIONS_FILE, readConnections, writeConnections } from '../../../src/core/connections-file.js';
import { CLAUDE_ACCOUNTS_HOME } from '../../../src/core/paths.js';
import { addAccount, removeAccount } from '../../../src/domain/auth/accounts.js';
import { getAuthStatus } from '../../../src/domain/auth/auth-status.js';
import { buildClaudeAuthEnv } from '../../../src/domain/auth/cc-auth-cli.js';
import { loginClaudeSubscription } from '../../../src/domain/auth/cc-subscription.js';
import { cancelFlow, getFlowState, startFlow, type LoginFlowState, type StartLoginFlowInput } from '../../../src/domain/auth/login-flow.js';
import { createAuthLoginService, type AuthLoginService, type LoginFlowHooks } from '../../../src/domain/auth/login-service.js';
import { logoutAccount } from '../../../src/domain/auth/logout.js';
import { createPendingAccount, findAccount } from '../../../src/domain/connections/accounts.js';
import { createCredentialInventory } from '../../../src/domain/connections/inventory.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-claude-accounts-'));
  writeConnections([]);
  fs.rmSync(CLAUDE_ACCOUNTS_HOME, { recursive: true, force: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeLogin(configDir: string, identity?: Record<string, unknown>): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: Date.now() + 30 * 86_400_000 } }));
  if (identity) fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: identity }));
}

function flowState(input: StartLoginFlowInput): LoginFlowState {
  return {
    flowId: `flow-${input.connection}`, revision: 0, backend: input.backend, provider: input.provider,
    connection: input.connection ?? null, authType: input.authType, step: 'running', pendingPrompt: null,
    notice: null, channel: input.channel, sessionId: input.sessionId, createdAt: '', expiresAt: '',
    outcome: null, error: null, errorCode: null,
  };
}

function fakeLogin() {
  const calls: Array<{ input: StartLoginFlowInput; hooks?: LoginFlowHooks }> = [];
  const service: AuthLoginService = {
    start: async (input, hooks) => { calls.push({ input, hooks }); return flowState(input); },
    getState: () => null,
    respond: async () => { throw new Error('unused'); },
    cancel: async () => { throw new Error('unused'); },
  };
  return { service, calls };
}

describe('the login command of an account', () => {
  it('runs claude auth against the account dir', () => {
    const env = buildClaudeAuthEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/inherited' }, '/accounts/school');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/accounts/school');
    expect(buildClaudeAuthEnv({}).CLAUDE_CONFIG_DIR).not.toBe('/accounts/school');
  });

  it('logs in on the account dir, leaves the legacy token alone and recovers the account', async () => {
    const login = vi.fn(async (_options: unknown, _deps?: unknown) => ({ loggedIn: true, authMethod: 'claude.ai', apiProvider: null }));
    const removeLegacyToken = vi.fn(async () => {});
    const recovered: unknown[] = [];
    await loginClaudeSubscription({ prompt: async () => 'code', notify: () => {} }, {
      login, removeLegacyToken, publishRecovered: (input) => recovered.push(input),
      account: { id: 'school', configDir: '/accounts/school' },
    });
    expect(login.mock.calls[0]?.[1]).toEqual({ configDir: '/accounts/school' });
    expect(removeLegacyToken).not.toHaveBeenCalled();
    expect(recovered).toEqual([{ backend: 'claude', provider: 'anthropic', connection: 'school' }]);
  });
});

describe('the login service with an account', () => {
  const run = (connection: string) => async () => ({ provider: 'anthropic', authType: 'oauth' as const, expiresAt: null, detail: connection });

  it('starts the account consumer for a stored account and refuses an unknown one', async () => {
    writeConnections([{ id: 'school', backend: 'claude', type: 'account', label: 'School' }]);
    const factory = vi.fn(run);
    const service = createAuthLoginService({ claudeAccountConsumerFactory: factory });
    const base = { backend: 'claude' as const, provider: 'anthropic', authType: 'oauth' as const, channel: null, sessionId: null };
    const state = await service.start({ ...base, connection: 'school' });
    expect(state.connection).toBe('school');
    expect(factory).toHaveBeenCalledWith('school');
    await expect(service.start({ ...base, connection: 'nope' })).rejects.toMatchObject({ code: 'account_not_found' });
    await expect(service.start({ ...base, backend: 'pi', provider: 'openai-codex', connection: 'lab' }))
      .rejects.toMatchObject({ code: 'account_not_found' });
  });

  it('keeps one running login per account, not per provider', async () => {
    const pending = () => new Promise<never>(() => {});
    const base = { backend: 'claude' as const, provider: 'anthropic', authType: 'oauth' as const, channel: null, sessionId: null };
    const school = await startFlow({ ...base, connection: 'school' }, pending);
    const lab = await startFlow({ ...base, connection: 'lab' }, pending);
    const fallback = await startFlow(base, pending);
    for (const flow of [school, lab, fallback]) expect(getFlowState(flow.flowId)?.step).toBe('running');
    for (const flow of [school, lab, fallback]) await cancelFlow(flow.flowId);
  });
});

describe('account rows in the auth status', () => {
  async function snapshot() {
    const claudeConfigDir = path.join(root, 'claude');
    const accountsDir = path.join(root, 'accounts');
    writeLogin(claudeConfigDir, { emailAddress: 'me@example.com', organizationName: 'Me', organizationType: 'claude_max' });
    writeLogin(path.join(accountsDir, 'school'), {
      emailAddress: 'me@school.example', organizationName: 'School', organizationType: 'claude_team',
    });
    const file = path.join(root, 'connections.json');
    writeConnections([
      { id: 'school', backend: 'claude', type: 'account', label: 'School Team' },
      { id: 'lab', backend: 'claude', type: 'account', label: 'Lab' },
      { id: 'draft', backend: 'claude', type: 'account', label: 'Draft', pending: true },
    ], file);
    return getAuthStatus({
      claudeConfigDir, claudeAccountsDir: accountsDir,
      inventory: createCredentialInventory({ file, claudeAccountsDir: accountsDir, claude: { claudeConfigDir, env: {}, platform: 'linux' } }),
      loadPiRuntime: async () => ({ available: false, version: null, entry: null, error: 'none', runtime: null, readStoredCredential: null }),
      getDefaultClaudeConnection: () => 'subscription', getActiveBackend: () => 'claude', listFavorites: () => [],
    });
  }

  it('lists the default login, then each confirmed account with its own identity', async () => {
    const rows = (await snapshot()).accounts.map((row) => ({
      connection: row.connection, isDefault: row.isDefault, label: row.label, state: row.state,
      identity: row.identity, inUse: row.inUse,
    }));
    expect(rows).toEqual([
      { connection: null, isDefault: true, label: 'Anthropic', state: 'logged-in', inUse: true,
        identity: { email: 'me@example.com', organization: 'Me', plan: 'claude_max' } },
      { connection: 'school', isDefault: false, label: 'School Team', state: 'logged-in', inUse: true,
        identity: { email: 'me@school.example', organization: 'School', plan: 'claude_team' } },
      { connection: 'lab', isDefault: false, label: 'Lab', state: 'logged-out', inUse: false, identity: null },
    ]);
  });
});

describe('logging an account out', () => {
  it('signs out of the account dir only', async () => {
    writeConnections([{ id: 'school', backend: 'claude', type: 'account', label: 'School' }]);
    const logoutClaudeAuth = vi.fn(async () => {});
    const status = {
      generatedAt: '', piRuntime: { available: false, version: null, entry: null, error: null },
      accounts: [{
        backend: 'claude' as const, provider: 'anthropic', connection: 'school', isDefault: false, label: 'School',
        identity: null, capabilities: ['oauth' as const], authType: 'oauth' as const, state: 'logged-in' as const,
        source: 'credentials.json', expiresAt: null, refreshExpiresAt: null, inUse: true,
        credentials: [{ authType: 'oauth' as const, state: 'logged-in' as const, source: 'credentials.json',
          expiresAt: null, refreshExpiresAt: null, manageable: true }],
      }],
    };
    const result = await logoutAccount(
      { backend: 'claude', provider: 'anthropic', connection: 'school', authType: 'oauth' },
      { getAuthStatus: async () => status, logoutClaudeAuth },
    );
    expect(result.ok).toBe(true);
    expect(logoutClaudeAuth).toHaveBeenCalledWith({ configDir: path.join(CLAUDE_ACCOUNTS_HOME, 'school') });
  });
});

// Injected so no test loads the PI runtime over the real ~/.pi/agent/auth.json.
const NO_PI_PROVIDERS = async () => [];

describe('adding and removing an account', () => {
  it('registers a pending account, starts its login, and keeps it once the login lands', async () => {
    const { service, calls } = fakeLogin();
    const result = await addAccount({ backend: 'claude', label: 'School Team' }, { login: service, piProviders: NO_PI_PROVIDERS });
    expect(result).toMatchObject({ ok: true, account: { id: 'school-team', backend: 'claude', provider: 'anthropic', label: 'School Team' } });
    expect(calls[0]?.input).toMatchObject({ backend: 'claude', provider: 'anthropic', connection: 'school-team', authType: 'oauth' });
    expect(findAccount({ backend: 'claude', id: 'school-team' })?.pending).toBe(true);
    expect(fs.lstatSync(path.join(CLAUDE_ACCOUNTS_HOME, 'school-team', 'projects')).isSymbolicLink()).toBe(true);
    await calls[0]?.hooks?.onSuccess?.();
    expect(findAccount({ backend: 'claude', id: 'school-team' })).toEqual(
      { id: 'school-team', backend: 'claude', type: 'account', label: 'School Team' });
  });

  it('never names a Claude account after a PI provider or a PI account', async () => {
    writeConnections([{ id: 'work', backend: 'pi', type: 'account', provider: 'anthropic', label: 'Work' }]);
    const piProviders = async () => [{ id: 'anthropic', capabilities: ['oauth' as const, 'api_key' as const] }];
    const { service } = fakeLogin();
    const named = await addAccount({ backend: 'claude', label: 'Anthropic' }, { login: service, piProviders });
    const work = await addAccount({ backend: 'claude', label: 'Work' }, { login: service, piProviders });
    expect([named.ok && named.account.id, work.ok && work.account.id]).toEqual(['anthropic-2', 'work-2']);
  });

  it('drops the account and its dir when the first login fails', async () => {
    const { service, calls } = fakeLogin();
    await addAccount({ backend: 'claude', label: 'School' }, { login: service, piProviders: NO_PI_PROVIDERS });
    await calls[0]?.hooks?.onFailure?.();
    expect(findAccount({ backend: 'claude', id: 'school' })).toBeNull();
    expect(fs.existsSync(path.join(CLAUDE_ACCOUNTS_HOME, 'school'))).toBe(false);
  });

  it('discards a pending account whose login is no longer running', async () => {
    createPendingAccount({ backend: 'claude', label: 'Stale' });
    const { service } = fakeLogin();
    await addAccount({ backend: 'claude', label: 'Fresh' }, { login: service, piProviders: NO_PI_PROVIDERS });
    expect(readConnections(CONNECTIONS_FILE).map((entry) => entry.id)).toEqual(['fresh']);
  });

  it('signs out, deletes the dir and the entry, and reports the removal', async () => {
    writeConnections([{ id: 'school', backend: 'claude', type: 'account', label: 'School' }]);
    writeLogin(path.join(CLAUDE_ACCOUNTS_HOME, 'school'));
    const logout = vi.fn(async (input: Parameters<typeof logoutAccount>[0]) => ({ ok: true as const, ...input }));
    const onRemoved = vi.fn();
    const result = await removeAccount({ backend: 'claude', id: 'school' }, { logout, onRemoved });
    expect(result).toEqual({ ok: true, loggedOut: true, account: { id: 'school', backend: 'claude', provider: 'anthropic', label: 'School' } });
    expect(logout).toHaveBeenCalledWith({ backend: 'claude', provider: 'anthropic', connection: 'school', authType: 'oauth' });
    expect(fs.existsSync(path.join(CLAUDE_ACCOUNTS_HOME, 'school'))).toBe(false);
    expect(readConnections(CONNECTIONS_FILE)).toEqual([]);
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(await removeAccount({ backend: 'claude', id: 'school' }, { logout })).toEqual({ ok: false, errors: ['not-found'] });
  });
});
