// input:  desktop Settings/LoginFlow providers and auth fixtures
// output: Settings source-copy and non-stacked login regressions
// pos:    Verifies Settings shell copy and shared LoginFlow handoff
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useState } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AuthStatusSnapshot, ConfigSnapshot } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { ThemeProvider } from '@/theme';
import { PlatformPanel } from './SettingsPanels';

vi.mock('@radix-ui/react-dialog', async importOriginal => ({
  ...await importOriginal<typeof import('@radix-ui/react-dialog')>(),
  Root: ({ open, children }: any) => open ? <div data-settings-root>{children}</div> : null,
  Portal: ({ children }: any) => <>{children}</>,
  Overlay: () => <div />,
  Content: ({ children }: any) => <div data-settings-dialog>{children}</div>,
  Title: ({ children }: any) => <h1>{children}</h1>,
}));

vi.mock('@/features/auth/LoginFlowModal', () => ({
  LoginFlowModal: ({ open }: any) => open ? <div data-login-flow-dialog /> : null,
}));

vi.mock('@/design', async importOriginal => ({
  ...await importOriginal<typeof import('@/design')>(),
  useToast: () => ({ toast: () => {} }),
}));

vi.mock('@/lib/trpc', () => {
  const query = (kind: string) => ({
    queryOptions: () => ({ __kind: kind }),
    queryFilter: () => ({ __kind: kind }),
  });
  const mutation = (kind: string) => ({ mutationOptions: (options: object) => ({ __kind: kind, ...options }) });
  return { useTRPC: () => ({
    config: { get: query('config.get'), set: mutation('config.set') },
    cost: { summary: query('cost.summary') },
    threadTemplates: { get: query('threadTemplates.get') },
    approvals: { request: mutation('approvals.request') },
    auth: { status: query('auth.status'), logout: mutation('auth.logout') },
  }) };
});

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: (options: any) => ({
    data: options.__kind === 'config.get'
      ? snapshot
      : options.__kind === 'threadTemplates.get'
        ? []
        : options.__kind === 'auth.status' ? authStatus : undefined,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

import { LoginFlowProvider } from '@/features/auth/LoginFlowProvider';
import { SettingsModal } from './SettingsModal';

const snapshot: ConfigSnapshot = {
  budget: null,
  profiles: null,
  machines: [],
  mcp: null,
  threadTemplates: { agents: [], templates: [], shells: [] },
  hooks: [],
  env: [],
};

const authStatus: AuthStatusSnapshot = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [{
    backend: 'claude', provider: 'anthropic', label: 'Anthropic',
    capabilities: ['api_key', 'oauth'], authType: null, state: 'logged-out', source: null,
    expiresAt: null, refreshExpiresAt: null, inUse: true, credentials: [],
  }],
  piRuntime: { available: true, version: 'test', entry: null, error: null },
};

function SettingsHarness() {
  const [open, setOpen] = useState(true);
  return (
    <LangProvider>
      <ThemeProvider>
        <LoginFlowProvider>
          <SettingsModal open={open} onClose={() => setOpen(false)} />
        </LoginFlowProvider>
      </ThemeProvider>
    </LangProvider>
  );
}

function renderedText(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : renderedText(child)).join('');
}

describe('desktop authentication settings entry', () => {
  it('omits internal config-source copy from the settings shell and profiles panel', () => {
    const renderer = create(<SettingsHarness />);
    expect(renderedText(renderer.root)).not.toContain('~/.cortex/config/');
    for (const row of renderer.root.findAll(node => node.props['data-settings-nav'])) {
      expect(row.findAllByType('span')).toHaveLength(1);
    }

    act(() => { renderer.root.findByProps({ 'data-settings-nav': 'profiles' }).props.onClick(); });
    expect(renderedText(renderer.root)).not.toContain('Per-profile fallback is not in the config.get contract');
  });

  it('moves authentication controls out of Platform into a dedicated Accounts section', () => {
    let platform!: ReactTestRenderer;
    act(() => {
      platform = create(<LangProvider><PlatformPanel snapshot={snapshot} /></LangProvider>);
    });
    expect(platform.root.findAllByProps({ 'data-auth-login-entry': 'desktop' })).toHaveLength(0);

    const renderer = create(<SettingsHarness />);
    act(() => { renderer.root.findByProps({ 'data-settings-nav': 'accounts' }).props.onClick(); });
    expect(renderer.root.findAll(node => node.props['data-auth-action'] === 'login').length).toBeGreaterThan(0);
  });

  it('closes Settings before opening the shared LoginFlow dialog', () => {
    const renderer = create(<SettingsHarness />);
    act(() => { renderer.root.findByProps({ 'data-settings-nav': 'accounts' }).props.onClick(); });
    const login = renderer.root.findAll(node => (
      node.props['data-provider'] === 'anthropic'
      && node.props['data-auth-action'] === 'login'
      && node.props['data-auth-type'] === 'oauth'
    ))[0];
    act(() => { login?.props.onClick(); });

    expect(renderer.root.findAllByProps({ 'data-settings-dialog': true })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-login-flow-dialog': true })).toHaveLength(1);
  });
});
