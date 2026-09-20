// input:  actual menu hook, provider mocks and native transport
// output: menu removal, separator and update busy regressions
// pos:    Shared desktop menu hook specification
// >>> If updated, update this header and parent CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppMenus } from './useAppMenus';
import type { MenuNode } from './menu-model';

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/i18n', async () => {
  const { en } = await import('@/i18n/vocab');
  return { useVocab: () => en };
});
vi.mock('@/design/Toast', () => ({ useToastOptional: () => null }));
vi.mock('@/features/settings/SettingsProvider', () => ({ useSettings: () => ({ open: vi.fn() }) }));
vi.mock('@/features/schedule/ScheduleModalProvider', () => ({ useScheduleModal: () => ({ open: vi.fn() }) }));
vi.mock('@/features/projects/CurrentProjectProvider', () => ({ useCurrentProject: () => ({ currentProjectId: null }) }));
vi.mock('@/features/session/state/SelectedSessionProvider', () => ({
  useSelectedSession: () => ({ selectedSessionId: null, setSelectedSession: vi.fn() }),
}));
vi.mock('@/features/dock/DockProvider', () => ({ useDock: () => ({ open: true, canDock: true, toggleDock: vi.fn() }) }));
vi.mock('@/theme/ThemeProvider', () => ({ useTheme: () => 'dark', useSetTheme: () => vi.fn() }));
vi.mock('../PaneStateProvider', () => ({ usePaneState: () => ({ toggleRail: vi.fn(), togglePanel: vi.fn() }) }));
vi.mock('../ShellModalsProvider', () => ({ useShellModals: () => ({
  openNewProject: vi.fn(), openAbout: vi.fn(), openDaemonStatus: vi.fn(), openShortcuts: vi.fn(),
}) }));
vi.mock('./useWindowActions', () => ({ useWindowActions: () => ({
  close: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomReset: vi.fn(), toggleFullscreen: vi.fn(), toggleDevTools: vi.fn(),
}) }));

let menu: ReturnType<typeof useAppMenus>;
let renderer: ReactTestRenderer;
function Probe() { menu = useAppMenus(); return null; }
function updateItem() {
  return menu.menus.flatMap((group) => group.items).find((node) => node.kind === 'item' && node.id === 'help.updates') as Extract<MenuNode, { kind: 'item' }>;
}

beforeEach(() => {
  vi.stubGlobal('__CORTEX_DESKTOP__', true);
  act(() => { renderer = create(<Probe />); });
});
afterEach(() => { act(() => renderer.unmount()); vi.unstubAllGlobals(); });

describe('useAppMenus', () => {
  it('disables and relabels updates during the real command, including stale repeated actions', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal('__TAURI__', { core: { invoke } });
    const staleAction = updateItem().run;
    expect(updateItem().disabled).toBe(false);
    act(() => { staleAction(); staleAction(); });
    expect(updateItem().disabled).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    await act(async () => { finish({ ui: { status: 'current' }, shell: { status: 'current' } }); });
    expect(updateItem().disabled).toBe(false);
    expect(invoke.mock.calls).toEqual([['check_for_updates', undefined]]);
  });

  it('keeps native update checks disabled in a browser', () => {
    vi.stubGlobal('__CORTEX_DESKTOP__', false);
    act(() => renderer.update(<Probe />));
    expect(updateItem().disabled).toBe(true);
  });
});
