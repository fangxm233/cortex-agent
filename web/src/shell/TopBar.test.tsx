import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

const chrome = vi.hoisted(() => ({ mode: 'custom', fullscreen: false }));
const actions = vi.hoisted(() => ({
  settings: vi.fn(), settingsSection: vi.fn(), rail: vi.fn(), back: vi.fn(), forward: vi.fn(),
  daemon: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(),
}));
vi.mock('@/i18n', () => ({ useVocab: () => new Proxy({}, { get: (_, key) => String(key) }) }));
vi.mock('@/lib/desktop-platform', () => ({
  captionInsetLeft: () => (chrome.mode === 'overlay' ? 78 : 0), titleBarMode: () => chrome.mode,
  usesCommandKey: () => false,
  desktopPlatform: () => 'linux',
}));
vi.mock('@/features/settings/useSettings', () => ({
  useSettings: () => ({ open: actions.settings, openSection: actions.settingsSection }),
}));
vi.mock('@/features/machines/MachinesMenu', () => ({ MachinesMenu: () => null }));
vi.mock('@/features/connection/ConnectionStatusProvider', () => ({ useConnectionStatus: () => 'connected' }));
vi.mock('@/features/workbench/rail/LeftRail', () => ({
  BrandBadge: ({ label, onClick }: { label: string; onClick: () => void }) => <button aria-label={label} onClick={onClick} />,
}));
vi.mock('@/features/workbench/rail/rail-collapsed', () => ({ useRailCollapsed: () => false, toggleRail: actions.rail }));
vi.mock('./NavigationHistoryProvider', () => ({
  useNavigationHistory: () => ({ canBack: true, canForward: true, back: actions.back, forward: actions.forward }),
}));
vi.mock('@/features/daemon/useDaemonStatusModal', () => ({ useDaemonStatusModal: () => ({ open: actions.daemon }) }));
vi.mock('./menu/useAppMenus', () => ({ useAppMenus: () => ({
  menus: ['File', 'Edit', 'View', 'Help'].map((label) => ({ id: label, label, items: [] })),
  windowActions: { ...actions, isFullscreen: chrome.fullscreen, isMaximized: false },
}) }));
vi.mock('./menu/useMenuShortcuts', () => ({ useMenuShortcuts: () => {} }));
vi.mock('./menu/useNativeMenu', () => ({ useNativeMenu: () => ({ active: false }) }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(chrome, { mode: 'custom', fullscreen: false });
});

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
    // The shortcut hint is a label, not code: UI face.
    const accel = palette.findByProps({ className: 'shell-command-accel' });
    expect(accel.props.style.font).toContain('var(--font-ui)');
    expect(accel.props.style.font).not.toContain('Mono');
    act(() => view.unmount());
  });

  it('keeps navigation, usage, settings and caption actions keyboard reachable', () => {
    const view = create(<TopBar />);
    const labels = ['tbToggleRail', 'tbBack', 'tbForward',
      'stNavUsage', 'settings', 'winMinimize', 'winMaximize', 'winClose'];
    labels.forEach((label) => {
      const button = view.root.findAllByType('button').find((node) => node.props['aria-label'] === label)!;
      expect(button).toBeDefined();
      act(() => button.props.onClick());
    });
    expect(actions.settingsSection.mock.calls).toEqual([['usage']]);
    ['rail', 'back', 'forward', 'settings', 'minimize', 'toggleMaximize', 'close'].forEach((key) => {
      expect(actions[key as keyof typeof actions]).toHaveBeenCalledOnce();
    });
    act(() => view.unmount());
  });

  it('leaves theme to View → Appearance and shows the settings shortcut in its tooltip', () => {
    const view = create(<TopBar />);
    const labels = view.root.findAllByType('button').map((node) => node.props['aria-label']);
    expect(labels).not.toContain('stThemeLight');
    expect(labels).not.toContain('stThemeDark');
    const settings = view.root.findAllByType('button').find((node) => node.props['aria-label'] === 'settings')!;
    expect(settings.props.title).toBe('settings (Ctrl+,)');
    act(() => view.unmount());
  });
});

describe('TopBar in full screen', () => {
  const bar = (view: ReturnType<typeof create>) => view.root.findByProps({ 'data-app-topbar': true });

  it('stays on macOS without the traffic-light strip or window drag', () => {
    Object.assign(chrome, { mode: 'overlay', fullscreen: true });
    const view = create(<TopBar />);
    expect(bar(view).props.style.display).toBe('flex');
    expect(bar(view).props['data-tauri-drag-region']).toBeUndefined();
    expect(bar(view).findAllByType('div')[1].props.style.width).toBe(0);
    act(() => view.unmount());
  });

  it('reserves the traffic-light strip on macOS outside full screen', () => {
    Object.assign(chrome, { mode: 'overlay', fullscreen: false });
    const view = create(<TopBar />);
    expect(bar(view).props['data-tauri-drag-region']).toBe('deep');
    expect(bar(view).findAllByType('div')[1].props.style.width).toBe(78);
    act(() => view.unmount());
  });

  it('stays on Windows and Linux without caption buttons or window drag', () => {
    Object.assign(chrome, { mode: 'custom', fullscreen: true });
    const view = create(<TopBar />);
    expect(bar(view).props.style.display).toBe('flex');
    expect(bar(view).props['data-tauri-drag-region']).toBeUndefined();
    const labels = view.root.findAllByType('button').map((node) => node.props['aria-label']);
    expect(labels).toContain('settings');
    expect(labels).not.toContain('winClose');
    act(() => view.unmount());
  });
});
