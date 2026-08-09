// input:  desktop Settings/LoginFlow providers and template fixtures
// output: Settings layout/source-copy and non-stacked login regressions
// pos:    Verifies Settings shell layout and shared LoginFlow handoff
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useState } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type {
  AuthStatusSnapshot,
  ConfigSnapshot,
  ThreadTemplateDetail,
  ThreadTemplateEntry,
} from '@cortex-agent/ui-contract';
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
    threadTemplates: {
      get: query('threadTemplates.get'),
      detail: query('threadTemplates.detail'),
      validate: mutation('threadTemplates.validate'),
      save: mutation('threadTemplates.save'),
      remove: mutation('threadTemplates.remove'),
    },
    approvals: { request: mutation('approvals.request') },
    profiles: {
      create: mutation('profiles.create'),
      update: mutation('profiles.update'),
      remove: mutation('profiles.remove'),
    },
    auth: {
      status: query('auth.status'),
      logout: mutation('auth.logout'),
      customProviders: query('auth.customProviders'),
      upsertCustomProvider: mutation('auth.upsertCustomProvider'),
      removeCustomProvider: mutation('auth.removeCustomProvider'),
    },
  }) };
});

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: (options: any) => ({
    data: options.__kind === 'config.get'
      ? snapshot
      : options.__kind === 'threadTemplates.get'
        ? templateEntries
        : options.__kind === 'threadTemplates.detail'
          ? templateDetail
          : options.__kind === 'auth.status'
            ? authStatus
            : options.__kind === 'auth.customProviders' ? [] : undefined,
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

const templateEntries: ThreadTemplateEntry[] = [{
  kind: 'template',
  name: 'coder-review',
  description: 'coder → reviewer',
  body: { name: 'coder-review', maxTotalSteps: 4 },
  valid: true,
  errorCount: 0,
  origin: 'custom',
}];

const templateDetail: ThreadTemplateDetail = {
  ...templateEntries[0],
  filePath: '/tmp/coder-review.json',
  sha256: 'a'.repeat(64),
  errors: [],
  warnings: [],
  usedByTemplates: [],
  runningThreads: 0,
  referencingTasks: 0,
  expanded: null,
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

  it('bounds template cards while their two content regions scroll independently', () => {
    const renderer = create(<SettingsHarness />);
    expect(renderedText(renderer.root)).not.toContain('Language & theme — interface language');
    act(() => { renderer.root.findByProps({ 'data-settings-nav': 'templates' }).props.onClick(); });

    const content = renderer.root.find(node => node.props.style?.padding === '16px 22px');
    expect(content.props.style).toMatchObject({ display: 'flex', flexDirection: 'column', overflow: 'hidden' });
    expect(renderedText(renderer.root)).not.toContain('config/thread-templates/ — validated on save');
    expect(renderedText(renderer.root)).not.toContain('Files under config/thread-templates/');

    const panel = renderer.root.findByProps({ 'data-settings-panel': 'templates' });
    const cards = panel.findAll(node => (
      node.type === 'div' && node.props.style?.border === '1px solid var(--proto-line)'
    ));
    expect(cards).toHaveLength(2);
    expect(cards.every(card => card.props.style.minHeight === 0)).toBe(true);
    expect(panel.findAll(node => node.props.style?.overflow === 'auto')).toHaveLength(2);

    const detailCard = cards.find(card => card.props.style.minWidth === 0)!;
    const detailScroller = detailCard.find(node => node.props.style?.overflow === 'auto');
    expect(detailScroller.findAllByProps({ 'data-action': 'save' })).toHaveLength(0);
    expect(detailCard.findAll(node => node.type === 'span' && node.props['data-action'] === 'save')).toHaveLength(1);
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
