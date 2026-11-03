import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthAccountStatus, AuthStatusSnapshot } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

const harness = vi.hoisted(() => ({
  loginCalls: [] as unknown[],
  mutations: [] as Array<{ kind: string; variables: unknown }>,
  toasts: [] as unknown[],
}));

const oauth = { authType: 'oauth' as const, state: 'logged-in' as const, source: 'credentials.json', expiresAt: null, refreshExpiresAt: null, manageable: true };

function row(overrides: Partial<AuthAccountStatus>): AuthAccountStatus {
  return {
    backend: 'claude', provider: 'anthropic', label: 'Anthropic', connection: null, isDefault: true, identity: null,
    capabilities: ['oauth'], authType: 'oauth', state: 'logged-in', source: 'credentials.json', expiresAt: null,
    refreshExpiresAt: null, inUse: true, credentials: [oauth], ...overrides,
  };
}

const status: AuthStatusSnapshot = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [
    row({ capabilities: ['api_key', 'oauth'], identity: { email: 'me@home.com', organization: null, plan: 'claude_max' } }),
    row({ connection: 'school', isDefault: false, label: 'School', identity: { email: 'me@school.edu', organization: 'School', plan: 'claude_team' } }),
    row({ connection: 'lab', isDefault: false, label: 'Lab', authType: null, state: 'logged-out', source: null, credentials: [] }),
    row({ backend: 'pi', provider: 'openai', label: 'OpenAI', capabilities: ['api_key', 'oauth'], inUse: false }),
  ],
  piRuntime: { available: true, version: 'test', entry: null, error: null },
};

vi.mock('@/design', async importOriginal => ({
  ...await importOriginal<typeof import('@/design')>(),
  useToast: () => ({ toast: (value: unknown) => harness.toasts.push(value) }),
}));

vi.mock('@/lib/trpc', () => {
  const query = (kind: string) => ({ queryOptions: () => ({ __kind: kind }), queryFilter: () => ({ __kind: kind }) });
  const mutation = (kind: string) => ({ mutationOptions: (options: object) => ({ __kind: kind, ...options }) });
  return { useTRPC: () => ({
    auth: {
      status: query('auth.status'), logout: mutation('auth.logout'),
      removeAccount: mutation('auth.removeAccount'), syncModels: mutation('auth.syncModels'),
    },
    connections: { list: query('connections.list'), upsert: mutation('connections.upsert'), remove: mutation('connections.remove') },
    config: { get: query('config.get') },
    models: { catalog: query('models.catalog') },
    system: { usageStatus: query('system.usageStatus'), rateLimitStatus: query('system.rateLimitStatus') },
  }) };
});

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: (options: any) => (options?.__kind === 'connections.list'
    ? { data: [], isLoading: false, isError: false, error: null }
    : { data: status, isLoading: false, isError: false, error: null }),
  useMutation: (options: any) => ({
    mutate: (variables: unknown, call?: { onSuccess?: (...args: unknown[]) => void }) => {
      harness.mutations.push({ kind: options.__kind, variables });
      options.onSuccess?.({}, variables);
      call?.onSuccess?.({}, variables);
    },
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: () => undefined }),
}));

import { AccountsPanel } from './AccountsPanel';

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LangProvider><AccountsPanel onLogin={(target) => harness.loginCalls.push(target)} /></LangProvider>); });
  return renderer;
}

function button(renderer: ReactTestRenderer, props: Record<string, unknown>) {
  return renderer.root.find(node => node.type === 'button'
    && Object.entries(props).every(([key, value]) => node.props[key] === value));
}

function rowText(renderer: ReactTestRenderer, id: string): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string): void => {
    if (typeof node === 'string') parts.push(node);
    else node.children.forEach(walk);
  };
  walk(renderer.root.find(node => node.type === 'div' && node.props['data-account-row'] === id));
  return parts.join(' ');
}

beforeEach(() => {
  harness.loginCalls = [];
  harness.mutations = [];
  harness.toasts = [];
});

describe('named accounts in Settings → Accounts', () => {
  it('lists Claude accounts under the default login, which is tagged as the default', () => {
    const renderer = mount();
    const rows = renderer.root.findAll(node => node.type === 'div' && typeof node.props['data-account-row'] === 'string')
      .map(node => node.props['data-account-row']);
    expect(rows).toEqual(['claude:oauth', 'claude:api_key', 'claude:anthropic:school', 'claude:anthropic:lab', 'openai']);
    expect(renderer.root.findAll(node => node.props['data-account-default'] !== undefined)).toHaveLength(1);
    const school = renderer.root.find(node => node.props['data-account-row'] === 'claude:anthropic:school');
    expect(school.findByProps({ 'data-account-meta': true }).props.children).toBe('me@school.edu · claude_team · In use');
    const lab = renderer.root.find(node => node.props['data-account-row'] === 'claude:anthropic:lab');
    expect(lab.findByProps({ 'data-account-meta': true }).props.children).toBe('Logged out');
    expect(rowText(renderer, 'claude:oauth')).toContain('me@home.com · claude_max');
  });

  it('signs a named account in again with its connection and a readable name', () => {
    const renderer = mount();
    act(() => { button(renderer, { 'data-auth-action': 'login', 'data-connection': 'school' }).props.onClick(); });
    expect(harness.loginCalls).toEqual([{
      backend: 'claude', provider: 'anthropic', authType: 'oauth', connection: 'school', label: 'Claude Code (School)',
    }]);
  });

  it('confirms a delete with what it does to sessions, then removes the account by id', () => {
    const renderer = mount();
    act(() => { button(renderer, { 'data-auth-action': 'remove', 'data-connection': 'school' }).props.onClick(); });
    expect(harness.mutations).toEqual([]);
    const school = renderer.root.find(node => node.props['data-account-row'] === 'claude:anthropic:school');
    expect(school.findAllByProps({ 'data-logout-confirm': true })).toHaveLength(1);
    expect(rowText(renderer, 'claude:anthropic:school')).toContain('Sessions using it switch to the default account.');
    act(() => { button(renderer, { 'data-auth-action': 'remove-confirm', 'data-connection': 'school' }).props.onClick(); });
    expect(harness.mutations).toEqual([{ kind: 'auth.removeAccount', variables: { backend: 'claude', id: 'school' } }]);
    expect(harness.toasts).toEqual([{ title: 'Deleted Claude Code (School)', tone: 'done' }]);
  });

  it('logs a named account out by its connection', () => {
    const renderer = mount();
    act(() => { button(renderer, { 'data-auth-action': 'logout', 'data-connection': 'school' }).props.onClick(); });
    act(() => { button(renderer, { 'data-auth-action': 'logout-confirm', 'data-connection': 'school' }).props.onClick(); });
    expect(harness.mutations).toEqual([{
      kind: 'auth.logout', variables: { backend: 'claude', provider: 'anthropic', authType: 'oauth', connection: 'school' },
    }]);
  });

  it('adds an account by name and starts its login', () => {
    const renderer = mount();
    const add = renderer.root.find(node => node.props['data-account-add'] === 'claude:anthropic');
    act(() => { add.findByProps({ 'data-account-add-open': true }).props.onClick(); });
    const input = renderer.root.findByProps({ 'data-account-add-label': true });
    act(() => { input.props.onChange({ target: { value: '  Team  ' } }); });
    act(() => { renderer.root.findByProps({ 'data-account-add-submit': true }).props.onClick(); });
    expect(harness.loginCalls).toEqual([{
      backend: 'claude', provider: 'anthropic', authType: 'oauth', newAccount: 'Team', label: 'Claude Code (Team)',
    }]);
    expect(renderer.root.findAllByProps({ 'data-account-add-label': true })).toHaveLength(0);
  });

  it('asks which login a new PI account uses when the provider offers both', () => {
    const renderer = mount();
    const add = renderer.root.find(node => node.props['data-account-add'] === 'pi:openai');
    act(() => { add.findByProps({ 'data-account-add-open': true }).props.onClick(); });
    act(() => { renderer.root.findByProps({ 'data-account-add-label': true }).props.onChange({ target: { value: 'Lab' } }); });
    const choices = renderer.root.findAll(node => node.type === 'button' && node.props['data-account-add-submit'] !== undefined);
    expect(choices.map(node => node.props.children)).toEqual(['API key', 'OAuth']);
    act(() => { choices[1].props.onClick(); });
    expect(harness.loginCalls).toEqual([{
      backend: 'pi', provider: 'openai', authType: 'oauth', newAccount: 'Lab', label: 'OpenAI (Lab)',
    }]);
  });
});
