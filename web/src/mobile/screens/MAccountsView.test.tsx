import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AuthStatusSnapshot } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { buildAccountsVm } from '@/features/settings/vm/accounts-vm';
import { MAccountsView, type MCustomProvidersProps } from './MAccountsView';

const status: AuthStatusSnapshot = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [
    {
      backend: 'claude', provider: 'anthropic', label: 'Anthropic', capabilities: ['api_key', 'oauth'],
      authType: 'oauth', state: 'logged-in', source: 'credentials.json', expiresAt: '2031-01-01T00:00:00.000Z',
      refreshExpiresAt: null, inUse: true,
      credentials: [{ authType: 'oauth', state: 'logged-in', source: 'credentials.json', expiresAt: '2031-01-01T00:00:00.000Z', refreshExpiresAt: null, manageable: true }],
    },
    {
      backend: 'pi', provider: 'openrouter', label: 'OpenRouter', capabilities: ['api_key', 'oauth'],
      authType: 'oauth', state: 'expiring', source: 'stored', expiresAt: '2030-02-01T00:00:00.000Z',
      refreshExpiresAt: null, inUse: true,
      credentials: [{ authType: 'oauth', state: 'expiring', source: 'stored', expiresAt: '2030-02-01T00:00:00.000Z', refreshExpiresAt: null, manageable: true }],
    },
    {
      backend: 'pi', provider: 'deepseek', label: 'DeepSeek', capabilities: ['api_key'],
      authType: 'api_key', state: 'logged-in', source: 'environment', expiresAt: null,
      refreshExpiresAt: null, inUse: false,
      credentials: [{ authType: 'api_key', state: 'logged-in', source: 'environment', expiresAt: null, refreshExpiresAt: null, manageable: false }],
    },
    {
      backend: 'pi', provider: 'unused', label: 'Unused', capabilities: ['api_key'],
      authType: null, state: 'logged-out', source: null, expiresAt: null,
      refreshExpiresAt: null, inUse: false, credentials: [],
    },
  ],
  piRuntime: { available: true, version: 'test', entry: null, error: null },
};

const custom: MCustomProvidersProps = {
  providers: [], confirmingDelete: null, savePending: false, removePending: false,
  onNew: () => {}, onEdit: () => {}, onDelete: () => {},
};

function mount(
  onLogin = vi.fn(),
  onLogout = vi.fn(),
  actionsDisabled = false,
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <LangProvider>
        <MAccountsView
          vm={buildAccountsVm(status)} filter="" onFilter={() => {}}
          onBack={() => {}}
          onLogin={onLogin}
          onLogout={onLogout}
          actionsDisabled={actionsDisabled}
          custom={custom} onRescan={() => {}} rescanning={false}
        />
      </LangProvider>,
    );
  });
  return renderer;
}

function actions(renderer: ReactTestRenderer, provider: string, action: string) {
  return renderer.root.findAll(node => (
    node.type === 'button' && node.props['data-provider'] === provider && node.props['data-auth-action'] === action
  ));
}

describe('MAccountsView', () => {
  it('lists connected providers with re-login and loginable ones with their capabilities', () => {
    const renderer = mount();

    expect(actions(renderer, 'deepseek', 'login').map(node => node.props.children)).toEqual(['Replace key']);
    expect(actions(renderer, 'openrouter', 'login').map(node => node.props.children)).toEqual(['Use API key', 'Log in again']);
    expect(actions(renderer, 'unused', 'login').map(node => node.props.children)).toEqual(['API key']);
  });

  it('confirms a logout before forwarding it, and forwards logins with the label', () => {
    const onLogin = vi.fn();
    const onLogout = vi.fn();
    const renderer = mount(onLogin, onLogout);

    expect(actions(renderer, 'deepseek', 'logout')).toHaveLength(0);
    act(() => { actions(renderer, 'deepseek', 'login')[0]?.props.onClick(); });
    act(() => { actions(renderer, 'openrouter', 'logout')[0]?.props.onClick(); });
    expect(onLogout).not.toHaveBeenCalled();
    act(() => { actions(renderer, 'openrouter', 'logout-confirm')[0]?.props.onClick(); });

    expect(onLogin).toHaveBeenCalledWith({ backend: 'pi', provider: 'deepseek', authType: 'api_key', label: 'DeepSeek' });
    expect(onLogout).toHaveBeenCalledWith({ backend: 'pi', provider: 'openrouter', authType: 'oauth', label: 'OpenRouter' });
  });

  it('disables account actions while a logout mutation is pending', () => {
    const renderer = mount(vi.fn(), vi.fn(), true);

    expect(actions(renderer, 'deepseek', 'login')[0]?.props.disabled).toBe(true);
    expect(actions(renderer, 'openrouter', 'logout')[0]?.props.disabled).toBe(true);
  });

  it('never shows credential detail, provider ids or raw sources', () => {
    const withSensitiveDetail: AuthStatusSnapshot = {
      ...status,
      accounts: status.accounts.map(account => ({
        ...account,
        detail: 'sentinel-account-secret',
        credentials: account.credentials.map(item => ({ ...item, detail: 'sentinel-slot-secret' })),
      })),
    };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LangProvider>
          <MAccountsView
            vm={buildAccountsVm(withSensitiveDetail)} filter="" onFilter={() => {}} onBack={() => {}}
            onLogin={() => {}} onLogout={() => {}} actionsDisabled={false}
            custom={custom} onRescan={() => {}} rescanning={false}
          />
        </LangProvider>,
      );
    });
    const html = JSON.stringify(renderer.toJSON());

    expect(html).not.toContain('sentinel-account-secret');
    expect(html).not.toContain('sentinel-slot-secret');
    const parts: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') parts.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
    };
    walk(renderer.toJSON());
    expect(parts.join(' ')).not.toMatch(/deepseek|openrouter|stored|credentials\.json|2030-|2031-/);
  });
});
