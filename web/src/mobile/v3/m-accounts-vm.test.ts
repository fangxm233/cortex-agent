// input:  secret-free auth status snapshots and provider filters
// output: shared accounts VM grouping, status, and action tests
// pos:    Pins desktop/mobile account state derivation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type {
  AuthAccountStatus,
  AuthCredentialStatus,
  AuthStatusSnapshot,
  AuthType,
} from '@cortex-agent/ui-contract';
import { buildAccountsVm } from './m-accounts-vm';

function credential(
  authType: AuthType,
  source: string,
  manageable: boolean,
  state: AuthCredentialStatus['state'] = 'logged-in',
): AuthCredentialStatus {
  return {
    authType,
    state,
    source,
    expiresAt: authType === 'oauth' ? '2030-06-01T00:00:00.000Z' : null,
    refreshExpiresAt: null,
    manageable,
    detail: 'sentinel-credential-fragment',
  };
}

function piAccount(
  provider: string,
  state: AuthAccountStatus['state'],
  capabilities: AuthType[],
  credentials: AuthCredentialStatus[],
  inUse = false,
): AuthAccountStatus {
  const current = credentials[0] ?? null;
  return {
    backend: 'pi',
    provider,
    label: provider.toUpperCase(),
    capabilities,
    authType: current?.authType ?? null,
    state,
    source: current?.source ?? null,
    expiresAt: current?.expiresAt ?? null,
    refreshExpiresAt: null,
    inUse,
    credentials,
    detail: 'sentinel-account-fragment',
  };
}

const snapshot: AuthStatusSnapshot = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [
    {
      backend: 'claude', provider: 'anthropic', label: 'Anthropic',
      capabilities: ['api_key', 'oauth'], authType: 'api_key', state: 'logged-in',
      source: 'env', expiresAt: null, refreshExpiresAt: null, inUse: true,
      credentials: [
        credential('api_key', 'env', true),
        credential('oauth', 'credentials.json', true, 'expiring'),
      ],
    },
    piAccount('deepseek', 'logged-in', ['api_key'], [credential('api_key', 'environment', false)]),
    piAccount('openrouter', 'expiring', ['api_key', 'oauth'], [credential('oauth', 'stored', true, 'expiring')], true),
    piAccount('unused', 'logged-out', ['api_key'], []),
    piAccount('broken', 'unknown', ['api_key'], []),
  ],
  piRuntime: { available: true, version: 'test', entry: null, error: null },
};

describe('buildAccountsVm', () => {
  it('builds two Claude credential slots without hiding their independent states', () => {
    const vm = buildAccountsVm(snapshot);

    expect(vm.claude?.slots.map(slot => slot.authType)).toEqual(['oauth', 'api_key']);
    expect(vm.claude?.slots[0]?.credentials[0]).toMatchObject({
      kind: 'expiring', tone: 'waiting', source: 'credentials.json',
    });
    expect(vm.claude?.slots[1]?.credentials[0]).toMatchObject({
      kind: 'logged-in', tone: 'done', source: 'env',
    });
  });

  it('puts in-use providers first and groups the mobile list as in-use, logged-in, then other', () => {
    const vm = buildAccountsVm(snapshot);

    expect(vm.piProviders.map(provider => provider.provider)).toEqual([
      'openrouter', 'broken', 'deepseek', 'unused',
    ]);
    expect(vm.groups.map(group => [group.key, group.providers.map(provider => provider.provider)])).toEqual([
      ['in-use', ['openrouter']],
      ['logged-in', ['deepseek']],
      ['other', ['broken', 'unused']],
    ]);
  });

  it('derives OAuth login and logout only from capabilities and manageable credentials', () => {
    const vm = buildAccountsVm(snapshot);
    const apiOnly = vm.piProviders.find(provider => provider.provider === 'deepseek');
    const oauth = vm.piProviders.find(provider => provider.provider === 'openrouter');

    expect(apiOnly?.loginTypes).toEqual(['api_key']);
    expect(apiOnly?.logoutTypes).toEqual([]);
    expect(oauth?.loginTypes).toEqual(['api_key', 'oauth']);
    expect(oauth?.logoutTypes).toEqual(['oauth']);
  });

  it('gates logout by the credential targeted by auth.logout rather than login capabilities', () => {
    const accounts = [
      piAccount('retired-login', 'logged-in', [], [credential('oauth', 'stored', true)]),
      piAccount('runtime-shadow', 'logged-in', ['api_key'], [
        credential('api_key', 'runtime', false),
        credential('api_key', 'stored', true),
      ]),
    ];
    const vm = buildAccountsVm({ ...snapshot, accounts });

    expect(vm.piProviders.find(item => item.provider === 'retired-login')?.logoutTypes).toEqual(['oauth']);
    expect(vm.piProviders.find(item => item.provider === 'runtime-shadow')?.logoutTypes).toEqual([]);
  });

  it('maps unknown and expired states to the invalid four-state presentation', () => {
    const vm = buildAccountsVm(snapshot);
    expect(vm.piProviders.find(provider => provider.provider === 'broken')?.status).toEqual({
      kind: 'invalid', tone: 'failed', labelKey: 'accountsStatusInvalid',
    });
  });

  it('filters providers by id or label and never carries credential detail into the UI model', () => {
    const vm = buildAccountsVm(snapshot, 'route');

    expect(vm.piProviders.map(provider => provider.provider)).toEqual(['openrouter']);
    expect(JSON.stringify(buildAccountsVm(snapshot))).not.toContain('sentinel-credential-fragment');
    expect(JSON.stringify(buildAccountsVm(snapshot))).not.toContain('sentinel-account-fragment');
  });

  it('summarizes usable Claude and PI accounts for the mobile settings row', () => {
    expect(buildAccountsVm(snapshot).summary).toEqual({
      claudeLoggedIn: true,
      piLoggedInCount: 2,
    });
  });
});
