// input:  shared accounts VM, provider rows, action spies
// output: mobile grouping, capability, and pending-action tests
// pos:    Verifies the mobile accounts drill-in view
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AuthStatusSnapshot } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { buildAccountsVm } from './m-accounts-vm';
import { MAccountsView } from './MAccountsView';

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
          vm={buildAccountsVm(status)}
          onBack={() => {}}
          onLogin={onLogin}
          onLogout={onLogout}
          actionsDisabled={actionsDisabled}
        />
      </LangProvider>,
    );
  });
  return renderer;
}

function actions(renderer: ReactTestRenderer, provider: string, action: string) {
  return renderer.root.findAll(node => (
    node.props['data-provider'] === provider && node.props['data-auth-action'] === action
  ));
}

describe('MAccountsView', () => {
  it('renders providers in the in-use, logged-in, and other groups', () => {
    const html = JSON.stringify(mount().toJSON());
    const inUse = html.indexOf('In use');
    const loggedIn = html.indexOf('Logged in');
    const other = html.indexOf('Other');

    expect(inUse).toBeGreaterThan(-1);
    expect(loggedIn).toBeGreaterThan(inUse);
    expect(other).toBeGreaterThan(loggedIn);
    expect(html).toContain('OpenRouter');
    expect(html).toContain('DeepSeek');
    expect(html).toContain('Unused');
  });

  it('only offers OAuth where capabilities include OAuth', () => {
    const renderer = mount();

    expect(actions(renderer, 'deepseek', 'login').map(node => node.props['data-auth-type'])).toEqual(['api_key']);
    expect(actions(renderer, 'openrouter', 'login').map(node => node.props['data-auth-type'])).toEqual(['api_key', 'oauth']);
  });

  it('only offers logout for manageable credentials and forwards both actions', () => {
    const onLogin = vi.fn();
    const onLogout = vi.fn();
    const renderer = mount(onLogin, onLogout);

    expect(actions(renderer, 'deepseek', 'logout')).toHaveLength(0);
    const login = actions(renderer, 'deepseek', 'login')[0];
    const logout = actions(renderer, 'openrouter', 'logout')[0];
    act(() => { login?.props.onClick(); logout?.props.onClick(); });

    expect(onLogin).toHaveBeenCalledWith({ backend: 'pi', provider: 'deepseek', authType: 'api_key' });
    expect(onLogout).toHaveBeenCalledWith({ backend: 'pi', provider: 'openrouter', authType: 'oauth' });
  });

  it('disables account actions while a logout mutation is pending', () => {
    const renderer = mount(vi.fn(), vi.fn(), true);

    expect(actions(renderer, 'deepseek', 'login')[0]?.props.disabled).toBe(true);
    expect(actions(renderer, 'openrouter', 'logout')[0]?.props.disabled).toBe(true);
  });

  it('shows only status, source, and expiry metadata, never credential detail', () => {
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
            vm={buildAccountsVm(withSensitiveDetail)} onBack={() => {}}
            onLogin={() => {}} onLogout={() => {}} actionsDisabled={false}
          />
        </LangProvider>,
      );
    });
    const html = JSON.stringify(renderer.toJSON());

    expect(html).toContain('stored');
    expect(html).toContain('2030-02-01T00:00:00.000Z');
    expect(html).not.toContain('sentinel-account-secret');
    expect(html).not.toContain('sentinel-slot-secret');
  });
});
