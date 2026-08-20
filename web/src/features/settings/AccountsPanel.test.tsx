// input:  AccountsPanel, auth status fixtures, and login/logout spies
// output: desktop accounts navigation, capability, and safety tests
// pos:    Verifies the desktop account-management surface
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatusSnapshot } from '@cortex-agent/ui-contract';
import { en, LangProvider } from '@/i18n';
import { getSettingsNav } from './settings-nav';

const harness = vi.hoisted(() => ({
  loginCalls: [] as unknown[],
  logoutCalls: [] as unknown[],
  invalidations: [] as unknown[],
  syncCalls: [] as unknown[],
  syncResult: { configured: true, endpoints: 2, profiles: ['plan', 'execute'] } as Record<string, unknown>,
  toasts: [] as unknown[],
}));

const status: AuthStatusSnapshot = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [
    {
      backend: 'claude', provider: 'anthropic', label: 'Anthropic',
      capabilities: ['api_key', 'oauth'], authType: 'api_key', state: 'logged-in',
      source: 'env', expiresAt: null, refreshExpiresAt: null, inUse: true,
      credentials: [
        { authType: 'api_key', state: 'logged-in', source: 'env', expiresAt: null, refreshExpiresAt: null, manageable: true },
        { authType: 'oauth', state: 'expiring', source: 'credentials.json', expiresAt: '2030-06-01T00:00:00.000Z', refreshExpiresAt: '2030-07-01T00:00:00.000Z', manageable: true, detail: 'sentinel-secret-fragment' },
      ],
    },
    {
      backend: 'pi', provider: 'deepseek', label: 'DeepSeek', capabilities: ['api_key'],
      authType: 'api_key', state: 'logged-in', source: 'environment', expiresAt: null,
      refreshExpiresAt: null, inUse: false,
      credentials: [{ authType: 'api_key', state: 'logged-in', source: 'environment', expiresAt: null, refreshExpiresAt: null, manageable: false }],
    },
    {
      backend: 'pi', provider: 'openrouter', label: 'OpenRouter', capabilities: ['api_key', 'oauth'],
      authType: 'oauth', state: 'expiring', source: 'stored', expiresAt: '2030-06-01T00:00:00.000Z',
      refreshExpiresAt: null, inUse: true,
      credentials: [{ authType: 'oauth', state: 'expiring', source: 'stored', expiresAt: '2030-06-01T00:00:00.000Z', refreshExpiresAt: null, manageable: true }],
    },
  ],
  piRuntime: { available: true, version: 'test', entry: null, error: null },
};

vi.mock('@/features/auth/LoginFlowProvider', () => ({
  useLoginFlow: () => ({
    openLogin: (target: unknown) => harness.loginCalls.push(target),
    closeLogin: () => {},
  }),
}));

vi.mock('@/design', async importOriginal => ({
  ...await importOriginal<typeof import('@/design')>(),
  useToast: () => ({ toast: (value: unknown) => harness.toasts.push(value) }),
}));

vi.mock('@/lib/trpc', () => {
  const query = (kind: string) => ({
    queryOptions: () => ({ __kind: kind }),
    queryFilter: () => ({ __kind: kind }),
  });
  const mutation = (kind: string) => ({
    mutationOptions: (options: object) => ({ __kind: kind, ...options }),
  });
  return { useTRPC: () => ({
    auth: {
      status: query('auth.status'),
      logout: mutation('auth.logout'),
      customProviders: query('auth.customProviders'),
      upsertCustomProvider: mutation('auth.upsertCustomProvider'),
      removeCustomProvider: mutation('auth.removeCustomProvider'),
      syncGateway: mutation('auth.syncGateway'),
    },
    config: {
      get: query('config.get'),
    },
  }) };
});

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: (options: any) => (options?.__kind === 'auth.customProviders'
    ? { data: [], isLoading: false, isError: false, error: null }
    : { data: status, isLoading: false, isError: false, error: null }),
  useMutation: (options: any) => ({
    mutate: (variables: unknown) => {
      if (options.__kind === 'auth.syncGateway') {
        harness.syncCalls.push(variables);
        options.onSuccess?.(harness.syncResult, variables);
        return;
      }
      harness.logoutCalls.push(variables);
      options.onSuccess?.({}, variables);
    },
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: (filter: unknown) => harness.invalidations.push(filter),
  }),
}));

import { AccountsPanel } from './AccountsPanel';

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LangProvider><AccountsPanel /></LangProvider>); });
  return renderer;
}

function actions(renderer: ReactTestRenderer, provider: string, action: string) {
  return renderer.root.findAll(node => (
    node.type === 'button'
    && node.props['data-provider'] === provider
    && node.props['data-auth-action'] === action
  ));
}

beforeEach(() => {
  harness.loginCalls = [];
  harness.logoutCalls = [];
  harness.invalidations = [];
  harness.syncCalls = [];
  harness.toasts = [];
  harness.syncResult = { configured: true, endpoints: 2, profiles: ['plan', 'execute'] };
});

describe('desktop accounts settings', () => {
  it('places Accounts before Profiles in every settings navigation record', () => {
    const keys = getSettingsNav(en).map(entry => entry.key);
    expect(keys.indexOf('accounts')).toBe(keys.indexOf('profiles') - 1);
    expect(getSettingsNav(en).find(entry => entry.key === 'accounts')).toEqual({
      key: 'accounts', label: 'Accounts',
    });
  });

  it('renders both Claude credential slots without credential fragments', () => {
    const html = JSON.stringify(mount().toJSON());

    expect(html).toContain('Subscription (OAuth)');
    expect(html).toContain('API key');
    expect(html).toContain('credentials.json');
    expect(html).toContain('2030-06-01T00:00:00.000Z');
    expect(html).not.toContain('sentinel-secret-fragment');
  });

  it('shows one collapsed expiry without a refresh-token line', () => {
    const html = JSON.stringify(mount().toJSON());

    expect(html).not.toContain('Refresh expires');
    expect(html).not.toContain('2030-07-01T00:00:00.000Z');
  });

  it('marks credential state compactly and shows a brand icon per account row', () => {
    const renderer = mount();

    const states = renderer.root.findAll(node => node.props['data-account-state'] !== undefined)
      .map(node => node.props['data-account-state']);
    expect(states).toContain('expiring');
    expect(states).toContain('logged-in');

    const icons = renderer.root.findAll(node => node.props['data-provider-icon'] !== undefined)
      .map(node => node.props['data-provider-icon']);
    expect(icons).toEqual(['claude-code', 'openrouter', 'deepseek']);
  });

  it('never renders an OAuth login action for a provider without OAuth capability', () => {
    const renderer = mount();

    expect(actions(renderer, 'deepseek', 'login').map(node => node.props['data-auth-type'])).toEqual(['api_key']);
    expect(actions(renderer, 'openrouter', 'login').map(node => node.props['data-auth-type'])).toEqual(['api_key', 'oauth']);
  });

  it('renders logout only for manageable credentials and calls auth.logout', () => {
    const renderer = mount();

    expect(actions(renderer, 'deepseek', 'logout')).toHaveLength(0);
    const logout = actions(renderer, 'openrouter', 'logout');
    expect(logout).toHaveLength(1);
    act(() => { logout[0]?.props.onClick(); });
    expect(harness.logoutCalls).toEqual([{ backend: 'pi', provider: 'openrouter', authType: 'oauth' }]);
    expect(harness.invalidations).toEqual([{ __kind: 'auth.status' }]);
  });

  it('starts the shared LoginFlow with the row target and filters the full PI list', () => {
    const renderer = mount();
    const oauth = actions(renderer, 'openrouter', 'login').find(node => node.props['data-auth-type'] === 'oauth');
    act(() => { oauth?.props.onClick(); });
    expect(harness.loginCalls).toEqual([{ backend: 'pi', provider: 'openrouter', authType: 'oauth' }]);

    act(() => {
      renderer.root.findByProps({ 'data-accounts-filter': true }).props.onChange({ target: { value: 'deep' } });
    });
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain('DeepSeek');
    expect(html).not.toContain('OpenRouter');
  });
});

describe('model rescan after a login', () => {
  function rescanButton(renderer: ReactTestRenderer) {
    return renderer.root.findAll(node => node.type === 'button' && node.props['data-accounts-sync'] !== undefined)[0];
  }

  it('offers a rescan action that refreshes model routing and profile lists', () => {
    const renderer = mount();

    act(() => { rescanButton(renderer).props.onClick(); });

    expect(harness.syncCalls).toEqual([{}]);
    expect(harness.toasts).toEqual([{ title: en.accountsSyncModelsDone, tone: 'done' }]);
    const invalidated = JSON.stringify(harness.invalidations);
    expect(invalidated).toContain('auth.status');
    expect(invalidated).toContain('config.get');
  });

  it('explains an empty rescan instead of claiming success', () => {
    harness.syncResult = { configured: false, endpoints: 0, profiles: [], reason: 'no-endpoints' };
    const renderer = mount();

    act(() => { rescanButton(renderer).props.onClick(); });

    expect(harness.toasts).toEqual([{ title: en.accountsSyncModelsEmpty, tone: 'waiting' }]);
  });
});
