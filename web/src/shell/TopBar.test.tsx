// input:  TopBar, react-test-renderer, mocked shell providers
// output: Window chrome action and sizing regression tests
// pos:    Verify compact chrome retains labeled native controls
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

const actions = vi.hoisted(() => ({
  theme: vi.fn(), settings: vi.fn(), settingsSection: vi.fn(), rail: vi.fn(), back: vi.fn(), forward: vi.fn(),
  daemon: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(),
}));
vi.mock('@/i18n', () => ({ useVocab: () => new Proxy({}, { get: (_, key) => String(key) }) }));
vi.mock('@/lib/desktop-platform', () => ({
  captionInsetLeft: () => 0, titleBarMode: () => 'custom', usesCommandKey: () => false,
  desktopPlatform: () => 'linux',
}));
vi.mock('@/theme', () => ({ useTheme: () => 'light', useSetTheme: () => actions.theme }));
vi.mock('@/features/settings/SettingsProvider', () => ({
  useSettings: () => ({ open: actions.settings, openSection: actions.settingsSection }),
}));
vi.mock('@/features/connection/ConnectionStatusProvider', () => ({ useConnectionStatus: () => 'connected' }));
vi.mock('@/features/workbench/LeftRail', () => ({
  BrandBadge: ({ label, onClick }: { label: string; onClick: () => void }) => <button aria-label={label} onClick={onClick} />,
  GearIcon: () => <svg />,
}));
vi.mock('./PaneStateProvider', () => ({ usePaneState: () => ({ railCollapsed: false, toggleRail: actions.rail }) }));
vi.mock('./NavigationHistoryProvider', () => ({
  useNavigationHistory: () => ({ canBack: true, canForward: true, back: actions.back, forward: actions.forward }),
}));
vi.mock('./ShellModalsProvider', () => ({ useShellModals: () => ({ openDaemonStatus: actions.daemon }) }));
vi.mock('./menu/useAppMenus', () => ({ useAppMenus: () => ({
  menus: ['File', 'Edit', 'View', 'Help'].map((label) => ({ id: label, label, items: [] })),
  windowActions: { ...actions, isFullscreen: false, isMaximized: false },
}) }));
vi.mock('./menu/useMenuShortcuts', () => ({ useMenuShortcuts: () => {} }));
vi.mock('./menu/useNativeMenu', () => ({ useNativeMenu: () => ({ active: false }) }));

beforeEach(() => vi.clearAllMocks());

describe('responsive TopBar', () => {
  it('retains all app menus and a shrinkable named palette button', () => {
    const view = create(<TopBar />);
    expect(view.root.findAllByProps({ className: 'shell-menu-trigger' })).toHaveLength(4);
    const palette = view.root.findByProps({ className: 'shell-command-pill' });
    expect(palette.type).toBe('button');
    expect(palette.props['aria-label']).toBe('cmdkPh');
    expect(palette.props.title).toContain('Ctrl+K');
    expect(palette.props.style.flex).toBe('0 1 320px');
    expect(palette.props.style.minWidth).toBe(34);
    act(() => view.unmount());
  });

  it('keeps navigation, theme, usage, settings and caption actions keyboard reachable', () => {
    const view = create(<TopBar />);
    const labels = ['tbToggleRail', 'tbBack', 'tbForward', 'stThemeLight', 'stThemeDark',
      'stNavUsage', 'settings', 'winMinimize', 'winMaximize', 'winClose'];
    labels.forEach((label) => {
      const button = view.root.findAllByType('button').find((node) => node.props['aria-label'] === label)!;
      expect(button).toBeDefined();
      act(() => button.props.onClick());
    });
    expect(actions.theme.mock.calls).toEqual([['light'], ['dark']]);
    expect(actions.settingsSection.mock.calls).toEqual([['usage']]);
    ['rail', 'back', 'forward', 'settings', 'minimize', 'toggleMaximize', 'close'].forEach((key) => {
      expect(actions[key as keyof typeof actions]).toHaveBeenCalledOnce();
    });
    act(() => view.unmount());
  });
});
