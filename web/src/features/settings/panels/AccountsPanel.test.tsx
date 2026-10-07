import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatusSnapshot } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

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
    {
      backend: 'pi', provider: 'groq', label: 'Groq', capabilities: ['api_key'],
      authType: null, state: 'logged-out', source: null, expiresAt: null,
      refreshExpiresAt: null, inUse: false, credentials: [],
    },
  ],
  piRuntime: { available: true, version: 'test', entry: null, error: null },
};

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
    mutate: (variables: unknown, call?: { onSuccess?: (...args: unknown[]) => void }) => {
      if (options.__kind === 'auth.syncGateway') {
        harness.syncCalls.push(variables);
        options.onSuccess?.(harness.syncResult, variables);
        return;
      }
      harness.logoutCalls.push(variables);
      options.onSuccess?.({}, variables);
      call?.onSuccess?.({}, variables);
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
  act(() => { renderer = create(<LangProvider><AccountsPanel onLogin={(target) => harness.loginCalls.push(target)} /></LangProvider>); });
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

function visibleText(renderer: ReactTestRenderer): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') parts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(renderer.toJSON());
  return parts.join(' ');
}

describe('desktop accounts settings', () => {
  it('groups Claude slots, connected providers and providers to add', () => {
    const renderer = mount();
    const groups = renderer.root.findAll(node => node.type === 'div' && node.props['data-account-group'] !== undefined)
      .map(node => node.props['data-account-group']);
    expect(groups).toEqual(['claude', 'connected', 'available']);
    const connected = renderer.root.findAll(node => node.type === 'div' && node.props['data-account-connected'] !== undefined)
      .map(node => node.props['data-account-row']);
    expect(connected).toEqual(['claude:oauth', 'claude:api_key', 'openrouter', 'deepseek']);
    expect(actions(renderer, 'groq', 'login').map(node => node.props.children)).toEqual(['API key']);
  });

  it('never shows provider ids, raw sources or timestamps', () => {
    const text = visibleText(mount());
    expect(text).not.toMatch(/deepseek|openrouter|environment"|credentials\.json|stored|2030-06-01|\bPI\b/);
    expect(text).toContain('from an environment variable');
    expect(text).toContain('Set outside Cortex');
  });

  it('confirms a logout inline, warns when the account is in use, then calls auth.logout', () => {
    const renderer = mount();

    expect(actions(renderer, 'deepseek', 'logout')).toHaveLength(0);
    const logout = actions(renderer, 'openrouter', 'logout');
    expect(logout).toHaveLength(1);
    act(() => { logout[0]?.props.onClick(); });
    expect(harness.logoutCalls).toEqual([]);
    expect(visibleText(renderer)).toContain('Profiles using it will stop working.');
    act(() => { actions(renderer, 'openrouter', 'logout-confirm')[0]?.props.onClick(); });

    expect(harness.logoutCalls).toEqual([{ backend: 'pi', provider: 'openrouter', authType: 'oauth' }]);
    expect(harness.invalidations).toEqual([{ __kind: 'auth.status' }, { __kind: 'config.get' }]);
    expect(harness.toasts).toEqual([{ title: 'Logged out of OpenRouter', tone: 'done' }]);
  });

  it('cancels an armed logout', () => {
    const renderer = mount();
    act(() => { actions(renderer, 'openrouter', 'logout')[0]?.props.onClick(); });
    act(() => { renderer.root.findAll(node => node.type === 'button' && node.props['data-auth-action'] === 'logout-cancel')[0]?.props.onClick(); });
    expect(actions(renderer, 'openrouter', 'logout')).toHaveLength(1);
    expect(harness.logoutCalls).toEqual([]);
  });

  it('hands the row target, with its label, to the login handler', () => {
    const renderer = mount();
    const oauth = actions(renderer, 'openrouter', 'login').find(node => node.props['data-auth-type'] === 'oauth');
    expect(oauth?.props.children).toBe('Log in again');
    act(() => { oauth?.props.onClick(); });
    act(() => { actions(renderer, 'groq', 'login')[0]?.props.onClick(); });
    expect(harness.loginCalls).toEqual([
      { backend: 'pi', provider: 'openrouter', authType: 'oauth', label: 'OpenRouter' },
      { backend: 'pi', provider: 'groq', authType: 'api_key', label: 'Groq' },
    ]);
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
    const invalidated = JSON.stringify(harness.invalidations);
    expect(invalidated).toContain('auth.status');
    expect(invalidated).toContain('config.get');
  });
});
