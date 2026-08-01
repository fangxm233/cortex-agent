// input:  desktop Settings/LoginFlow providers and config fixtures
// output: Reachable non-stacked OAuth/API-key entry regression
// pos:    Verifies Settings exposes the shared LoginFlow modal
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
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
  }) };
});

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: (options: any) => ({
    data: options.__kind === 'config.get' ? snapshot : options.__kind === 'threadTemplates.get' ? [] : undefined,
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

describe('desktop authentication settings entry', () => {
  it('renders a reachable control that opens the shared LoginFlow UI', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LangProvider><PlatformPanel snapshot={snapshot} onOpenLogin={() => {}} /></LangProvider>,
      );
    });
    const entry = renderer.root.findByProps({ 'data-auth-login-entry': 'desktop' });

    expect(entry.type).toBe('button');
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain('Backend login');
    expect(html).toContain('API keys and OAuth');
  });

  it('closes Settings before opening the shared LoginFlow dialog', () => {
    const renderer = create(<SettingsHarness />);
    act(() => { renderer.root.findByProps({ 'data-settings-nav': 'platform' }).props.onClick(); });
    act(() => { renderer.root.findByProps({ 'data-auth-login-entry': 'desktop' }).props.onClick(); });

    expect(renderer.root.findAllByProps({ 'data-settings-dialog': true })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-login-flow-dialog': true })).toHaveLength(1);
  });
});
