import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type {
  AuthStatusSnapshot,
  ConfigSnapshot,
  ThreadTemplateDetail,
  ThreadTemplateEntry,
} from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { ThemeProvider } from '@/theme';

vi.mock('@radix-ui/react-dialog', async importOriginal => ({
  ...await importOriginal<typeof import('@radix-ui/react-dialog')>(),
  Root: ({ open, children, onOpenChange }: any) => open ? <div data-settings-root data-on-open-change={onOpenChange}>{children}</div> : null,
  Portal: ({ children }: any) => <>{children}</>,
  Overlay: () => <div />,
  Content: ({ children, ...props }: any) => <div data-settings-dialog {...props}>{children}</div>,
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
    system: {
      usageStatus: query('system.usageStatus'),
      refreshUsage: mutation('system.refreshUsage'),
    },
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
      syncGateway: mutation('auth.syncGateway'),
    },
  }) };
});

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: (options: any) => {
    return {
      data: options.__kind === 'config.get'
        ? snapshot
        : options.__kind === 'threadTemplates.get'
          ? templateEntries
          : options.__kind === 'threadTemplates.detail'
            ? templateDetail
            : options.__kind === 'auth.status'
              ? authStatus
              : options.__kind === 'auth.customProviders' || options.__kind === 'system.usageStatus'
                ? []
                : undefined,
      isLoading: false,
      isError: false,
      error: null,
    };
  },
  useMutation: () => ({ mutate: () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

import { LoginFlowProvider } from '@/features/auth/LoginFlowProvider';
import { SettingsModal } from './SettingsModal';
import { markSelectOutsideInteraction } from '@/design/select-outside-interaction';

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

// Exercise Settings' actual Content callback; model only Radix's default-dismiss boundary.
function dispatchSettingsOutside(renderer: ReactTestRenderer, originalEvent: Event): Event {
  const outside = Object.assign(new Event('pointerDownOutside', { cancelable: true }), {
    detail: { originalEvent },
  });
  act(() => {
    renderer.root.findByProps({ 'data-settings-dialog': true }).props.onPointerDownOutside(outside);
    if (!outside.defaultPrevented) {
      renderer.root.findByProps({ 'data-settings-root': true }).props['data-on-open-change'](false);
    }
  });
  return outside;
}

describe('Settings outside dismissal', () => {
  it('guards the same Select gesture repeatedly but closes on the next independent one', () => {
    const renderer = create(<SettingsHarness />);
    const originalEvent = new Event('pointerdown', { cancelable: true });
    markSelectOutsideInteraction({ detail: { originalEvent }, preventDefault: vi.fn() });
    expect(dispatchSettingsOutside(renderer, originalEvent).defaultPrevented).toBe(true);
    expect(dispatchSettingsOutside(renderer, originalEvent).defaultPrevented).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-settings-dialog': true })).toHaveLength(1);
    expect(originalEvent.defaultPrevented).toBe(false);

    expect(dispatchSettingsOutside(renderer, new Event('pointerdown')).defaultPrevented).toBe(false);
    expect(renderer.root.findAllByProps({ 'data-settings-dialog': true })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('allows an ordinary outside gesture without a Select mark', () => {
    const renderer = create(<SettingsHarness />);
    expect(dispatchSettingsOutside(renderer, new Event('pointerdown')).defaultPrevented).toBe(false);
    expect(renderer.root.findAllByProps({ 'data-settings-dialog': true })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('leaves Escape and right-click filtering to Radix', () => {
    const renderer = create(<SettingsHarness />);
    const content = renderer.root.findByProps({ 'data-settings-dialog': true });
    expect(content.props.onEscapeKeyDown).toBeUndefined();
    expect(content.props.onInteractOutside).toBeUndefined();
    act(() => { renderer.root.findByProps({ 'data-settings-root': true }).props['data-on-open-change'](false); });
    expect(renderer.root.findAllByProps({ 'data-settings-dialog': true })).toHaveLength(0);
    act(() => renderer.unmount());
  });
});

describe('desktop authentication settings entry', () => {
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
