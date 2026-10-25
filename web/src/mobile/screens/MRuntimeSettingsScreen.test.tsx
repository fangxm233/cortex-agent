import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigSnapshot, SystemNoticeEntry } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

const adapter = vi.hoisted(() => ({
  onSet: vi.fn(),
  onToggle: vi.fn(),
  snapshot: null as ConfigSnapshot | null,
  native: false,
  tokenLogin: true,
  logout: vi.fn(),
  history: { entries: [] as SystemNoticeEntry[], cap: 0, loading: false, error: false },
}));

vi.mock('@/lib/desktop-config', () => ({
  isNativeShell: () => adapter.native,
  readDesktopConfig: () => null,
}));

vi.mock('@/lib/ui-session', () => ({
  probeUiSession: async () => ({ authenticated: true, tokenLogin: adapter.tokenLogin }),
  uiLogout: adapter.logout,
}));

vi.mock('@/features/notifications/useNoticeHistory', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/notifications/useNoticeHistory')>(),
  useNoticeHistory: () => adapter.history,
}));

vi.mock('./MNativeNotificationsCard', () => ({ MNativeNotificationsCard: () => null }));
vi.mock('@/features/settings/panels/LocalNotificationsCard', () => ({ LocalNotificationsCard: () => null }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: adapter.snapshot, isLoading: false, isError: false }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ config: { get: { queryOptions: () => ({}) } } }),
}));

vi.mock('@/features/settings/controllers/runtime-settings-writer', () => ({
  useRuntimeSettingWrite: () => ({
    pending: false,
    onSet: adapter.onSet,
    onToggle: adapter.onToggle,
  }),
}));

import { en } from '@/i18n/vocab';
import { MAdvancedScreen, MNotificationsScreen } from './MRuntimeSettingsScreen';

const snapshot: ConfigSnapshot = {
  budget: null,
  models: { default: null, favorites: [], memory: {} }, selectionDefault: null,
  machines: [],
  mcp: null,
  hooks: [],
  env: [
    { key: 'DEBUG', present: true, masked: '••••••••' },
    { key: 'CORTEX_GPU_MONITOR_MOCK', present: false, masked: '' },
  ],
  settings: [
    { key: 'eventLog', value: true, source: 'default' },
    { key: 'diskMonitor', value: true, source: 'default' },
    { key: 'showToolCalls', value: false, source: 'file' },
    { key: 'disableUserContext', value: true, source: 'env' },
    { key: 'serverUpdateDisable', value: false, source: 'default' },
    { key: 'sessionRetentionDays', value: 30, source: 'file' },
    { key: 'piCompactReserveTokens', value: 16_384, source: 'default' },
    { key: 'maxContextTokens', value: 450_000, source: 'file' },
    { key: 'memoryIndexRegenEnabled', value: true, source: 'file' },
    { key: 'memoryIndexRegenIntervalMs', value: 86_400_000, source: 'file' },
  ],
};

function mountAdvanced(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MemoryRouter><LangProvider><MAdvancedScreen /></LangProvider></MemoryRouter>,
    );
  });
  return renderer;
}

describe('mobile runtime Advanced settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapter.snapshot = snapshot;
    adapter.native = false;
    adapter.tokenLogin = true;
    adapter.history = { entries: [], cap: 0, loading: false, error: false };
  });

  it.each([true, false])('shows DEBUG enabled=%s even when the variable is present', (enabled) => {
    adapter.snapshot = { ...snapshot, env: [{ key: 'DEBUG', present: true, masked: '••••••••', enabled }] };
    const renderer = mountAdvanced();
    const row = renderer.root.findByProps({ 'data-settings-row': 'DEBUG' });
    const toggle = row.findByProps({ role: 'switch' });
    expect(toggle.props['aria-checked']).toBe(enabled);
    expect(toggle.props.disabled).toBe(true);
  });

  it('shows the update check as on and writes the inverse disable key', () => {
    const renderer = mountAdvanced();
    const toggle = renderer.root.findByProps({ 'data-settings-row': 'serverUpdateDisable' })
      .findByProps({ role: 'switch' });
    expect(toggle.props['aria-checked']).toBe(true);
    act(() => toggle.props.onClick());
    expect(adapter.onToggle).toHaveBeenCalledWith('serverUpdateDisable', true);
  });

  it('lists the GPU mock only while it is set', () => {
    expect(mountAdvanced().root.findAllByProps({ 'data-settings-row': 'CORTEX_GPU_MONITOR_MOCK' })).toHaveLength(0);
    adapter.snapshot = { ...snapshot, env: [{ key: 'CORTEX_GPU_MONITOR_MOCK', present: true, masked: '••' }] };
    expect(mountAdvanced().root.findAllByProps({ 'data-settings-row': 'CORTEX_GPU_MONITOR_MOCK' })).toHaveLength(1);
  });

  it('titles each group of rows', () => {
    const text = JSON.stringify(mountAdvanced().toJSON());
    for (const title of [en.stAdvSecAgent, en.stAdvSecUpdates, en.stAdvSecData, en.stAdvSecDiagnostics]) {
      expect(text).toContain(title);
    }
  });

  it('writes retention by its descriptor key and rejects unsafe integer drafts', () => {
    const renderer = mountAdvanced();
    const row = renderer.root.findByProps({ 'data-settings-row': 'sessionRetentionDays' });
    const input = row.findByType('input');
    const save = row.findByType('button');

    act(() => input.props.onChange({ target: { value: String(Number.MAX_SAFE_INTEGER + 1) } }));
    expect(row.findByType('button').props.disabled).toBe(true);

    act(() => input.props.onChange({ target: { value: '45' } }));
    expect(row.findByType('button').props.disabled).toBe(false);
    act(() => save.props.onClick());
    expect(adapter.onSet).toHaveBeenCalledWith('sessionRetentionDays', 45);
  });

  it('writes the PI compaction reserve and refuses a value under the range', () => {
    const renderer = mountAdvanced();
    const row = renderer.root.findByProps({ 'data-settings-row': 'piCompactReserveTokens' });
    const input = row.findByType('input');

    act(() => input.props.onChange({ target: { value: '1023' } }));
    expect(row.findByType('button').props.disabled).toBe(true);

    act(() => input.props.onChange({ target: { value: '32768' } }));
    expect(row.findByType('button').props.disabled).toBe(false);
    act(() => row.findByType('button').props.onClick());
    expect(adapter.onSet).toHaveBeenCalledWith('piCompactReserveTokens', 32_768);
  });

  it('clears the max context cap to null and refuses a value under the range', () => {
    const renderer = mountAdvanced();
    const row = renderer.root.findByProps({ 'data-settings-row': 'maxContextTokens' });
    const input = row.findByType('input');
    expect(input.props.placeholder).toBeTruthy();

    act(() => input.props.onChange({ target: { value: '99999' } }));
    expect(row.findByType('button').props.disabled).toBe(true);

    act(() => input.props.onChange({ target: { value: '' } }));
    expect(row.findByType('button').props.disabled).toBe(false);
    act(() => row.findByType('button').props.onClick());
    expect(adapter.onSet).toHaveBeenCalledWith('maxContextTokens', null);
  });

  it('shows no config-key footer or default-only descriptions', () => {
    const text = JSON.stringify(mountAdvanced().toJSON());
    expect(text).not.toContain('config.set');
    expect(text).not.toContain('daemon.log');
    expect(text).not.toContain('nvidia-smi');
    expect(text).toContain('500 MB');
  });

  it('offers sign-out in a browser signed in with the UI token', async () => {
    const renderer = mountAdvanced();
    await act(async () => { await Promise.resolve(); });
    const button = renderer.root.findByProps({ 'data-ui-sign-out': true });
    expect(button.props.children).toBe(en.uiLogoutAction);
  });

  it.each([
    ['the native app', true, true],
    ['a browser without token login', false, false],
  ])('hides sign-out in %s', async (_label, native, tokenLogin) => {
    adapter.native = native;
    adapter.tokenLogin = tokenLogin;
    const renderer = mountAdvanced();
    await act(async () => { await Promise.resolve(); });
    expect(renderer.root.findAllByProps({ 'data-ui-sign-out': true })).toHaveLength(0);
  });
});

describe('mobile Notifications recent notices', () => {
  function mountNotifications(): ReactTestRenderer {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<MemoryRouter><LangProvider><MNotificationsScreen /></LangProvider></MemoryRouter>);
    });
    return renderer;
  }

  beforeEach(() => {
    adapter.snapshot = snapshot;
  });

  it('lists the notices the server broadcast', () => {
    adapter.history = {
      cap: 50, loading: false, error: false,
      entries: [{ id: 'n1', ts: new Date().toISOString(), level: 'warning', title: 'Disk low', text: '410 MB free' }],
    };
    const text = JSON.stringify(mountNotifications().toJSON());
    expect(text).toContain(en.stRecentNotifications);
    expect(text).toContain('Disk low');
    expect(text).toContain('410 MB free');
  });

  it('says so when the notice history cannot be read', () => {
    adapter.history = { cap: 0, loading: false, error: true, entries: [] };
    const text = JSON.stringify(mountNotifications().toJSON());
    expect(text).toContain(en.stRecentNotifError);
  });
});
