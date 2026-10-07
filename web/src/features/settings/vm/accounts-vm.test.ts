import { describe, expect, it } from 'vitest';
import type {
  AuthAccountStatus,
  AuthCredentialStatus,
  AuthStatusSnapshot,
  AuthType,
} from '@cortex-agent/ui-contract';
import { en, zh } from '@/i18n/vocab';
import { buildAccountsVm, connectedMeta, expiryText, externalSource } from './accounts-vm';

function credential(
  authType: AuthType,
  source: string,
  manageable: boolean,
  state: AuthCredentialStatus['state'] = 'logged-in',
  expiresAt: string | null = null,
): AuthCredentialStatus {
  return { authType, state, source, expiresAt, refreshExpiresAt: null, manageable, detail: 'sentinel-credential-fragment' };
}

function piAccount(
  provider: string,
  capabilities: AuthType[],
  credentials: AuthCredentialStatus[],
  overrides: Partial<AuthAccountStatus> = {},
): AuthAccountStatus {
  const current = credentials[0] ?? null;
  return {
    backend: 'pi', provider, label: provider.toUpperCase(), capabilities,
    authType: current?.authType ?? null, state: current?.state ?? 'logged-out', source: current?.source ?? null,
    expiresAt: current?.expiresAt ?? null, refreshExpiresAt: null, inUse: false, credentials,
    detail: 'sentinel-account-fragment', ...overrides,
  };
}

function claude(credentials: AuthCredentialStatus[], overrides: Partial<AuthAccountStatus> = {}): AuthAccountStatus {
  const current = credentials[0] ?? null;
  return {
    backend: 'claude', provider: 'anthropic', label: 'Anthropic', capabilities: ['api_key', 'oauth'],
    authType: current?.authType ?? null, state: current?.state ?? 'logged-out', source: current?.source ?? null,
    expiresAt: current?.expiresAt ?? null, refreshExpiresAt: null, inUse: true, credentials, ...overrides,
  };
}

function snapshot(accounts: AuthAccountStatus[]): AuthStatusSnapshot {
  return { generatedAt: '2030-01-01T00:00:00.000Z', accounts, piRuntime: { available: true, version: '1', entry: null, error: null } };
}

describe('buildAccountsVm', () => {
  it('splits PI providers into connected and loginable ones', () => {
    const vm = buildAccountsVm(snapshot([
      piAccount('zeta', ['api_key'], []),
      piAccount('deepseek', ['api_key'], [credential('api_key', 'stored', true)], { inUse: true }),
      piAccount('alpha', ['api_key', 'oauth'], []),
      piAccount('github-copilot', ['oauth'], [credential('oauth', 'stored', true)]),
      piAccount('metadata-only', [], []),
    ]));

    expect(vm.connected.map(item => item.provider)).toEqual(['deepseek', 'github-copilot']);
    expect(vm.available.map(item => item.provider)).toEqual(['alpha', 'zeta']);
    expect(vm.available[0]).toEqual({ provider: 'alpha', label: 'ALPHA', loginTypes: ['api_key', 'oauth'] });
    expect(vm.availableTotal).toBe(2);
  });

  it('filters only the loginable list, by label or id', () => {
    const vm = buildAccountsVm(snapshot([
      piAccount('deepseek', ['api_key'], [credential('api_key', 'stored', true)]),
      piAccount('amazon-bedrock', ['api_key'], [], { label: 'Amazon Bedrock' }),
      piAccount('groq', ['api_key'], [], { label: 'Groq' }),
    ]), 'bedrock');

    expect(vm.connected).toHaveLength(1);
    expect(vm.available.map(item => item.label)).toEqual(['Amazon Bedrock']);
    expect(vm.availableTotal).toBe(2);
  });

  it('shows a source only for credentials Cortex cannot remove, in plain words', () => {
    const vm = buildAccountsVm(snapshot([
      piAccount('openai', ['api_key'], [credential('api_key', 'environment', false)]),
      piAccount('google', ['api_key'], [credential('api_key', 'models_json_key', false)]),
      piAccount('deepseek', ['api_key'], [credential('api_key', 'stored', true)]),
    ]));
    const byId = Object.fromEntries(vm.connected.map(item => [item.provider, item]));

    expect(byId.openai).toMatchObject({ external: 'environment', logoutTypes: [] });
    expect(byId.google).toMatchObject({ external: 'models_json', logoutTypes: [] });
    expect(byId.deepseek).toMatchObject({ external: null, logoutTypes: ['api_key'] });
    expect(connectedMeta(byId.openai!, 'pi', en)).toBe('API key · from an environment variable');
    expect(connectedMeta(byId.deepseek!, 'pi', en)).toBe('API key');
    expect(JSON.stringify(vm)).not.toMatch(/sentinel|models_json_key|"stored"/);
  });

  it('offers logout when any credential of the type is manageable (env key plus a stored key)', () => {
    const vm = buildAccountsVm(snapshot([
      piAccount('openrouter', ['api_key', 'oauth'], [
        credential('api_key', 'environment', false),
        credential('api_key', 'stored', true),
      ], { inUse: true }),
    ]));

    expect(vm.connected[0]).toMatchObject({ logoutTypes: ['api_key'], external: 'environment', inUse: true });
    expect(connectedMeta(vm.connected[0]!, 'pi', en)).toBe('API key · from an environment variable · In use');
  });

  it('maps account health without exposing raw state names', () => {
    const vm = buildAccountsVm(snapshot([
      piAccount('openai-codex', ['oauth'], [credential('oauth', 'stored', true, 'expiring', '2030-01-04T00:00:00.000Z')]),
      piAccount('xai', ['api_key', 'oauth'], [credential('oauth', 'stored', true, 'expired', '2029-12-01T00:00:00.000Z')]),
    ]));

    expect(vm.connected.map(item => [item.provider, item.health])).toEqual([['openai-codex', 'expiring'], ['xai', 'expired']]);
  });

  it('keeps both Claude slots and marks the in-use one only while it is connected', () => {
    const vm = buildAccountsVm(snapshot([
      claude([credential('oauth', 'credentials.json', true, 'logged-in', '2030-12-10T00:00:00.000Z')], { authType: 'oauth' }),
    ]));

    expect(vm.claude).toMatchObject({ label: 'Claude Code', inUse: true });
    expect(vm.claude!.slots.map(slot => [slot.authType, slot.connected, slot.inUse, slot.canLogout, slot.external]))
      .toEqual([['oauth', true, true, true, null], ['api_key', false, false, false, null]]);

    const loggedOut = buildAccountsVm(snapshot([claude([])]));
    expect(loggedOut.claude!.inUse).toBe(false);
    expect(loggedOut.claude!.slots.every(slot => !slot.connected && slot.canLogin)).toBe(true);
  });
});

describe('account copy helpers', () => {
  it('maps every external source to plain words', () => {
    expect(externalSource('environment')).toBe('environment');
    expect(externalSource('models_json_command')).toBe('models_json');
    expect(externalSource('runtime')).toBe('runtime');
    expect(externalSource('fallback')).toBe('runtime');
    expect(externalSource('stored')).toBeNull();
    expect(externalSource('credentials.json')).toBeNull();
  });

  it('writes expiry as a relative span near the date and a calendar date further out', () => {
    const now = Date.parse('2030-01-01T12:00:00.000Z');
    expect(expiryText('2030-01-04T12:00:00.000Z', now, 'en', en)).toBe('expires in 3d');
    expect(expiryText('2030-01-04T12:00:00.000Z', now, 'zh', zh)).toBe('3天后过期');
    expect(expiryText('2030-03-10T12:00:00.000Z', now, 'en', en)).toBe('expires Mar 10');
    expect(expiryText('2031-03-10T12:00:00.000Z', now, 'en', en)).toBe('expires Mar 10 2031');
    expect(expiryText('2029-12-01T00:00:00.000Z', now, 'en', en)).toBe('Expired');
    expect(expiryText(null, now, 'en', en)).toBeNull();
  });
});
