import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppMenus } from './useAppMenus';
import type { MenuNode } from './menu-model';

const server = vi.hoisted(() => ({ mutate: vi.fn().mockResolvedValue({ status: 'current' }) }));
vi.mock('@/lib/trpc', () => ({ useTRPCClient: () => ({ system: { checkUpdate: server } }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/i18n', async () => {
  const { en } = await import('@/i18n/vocab');
  return { useVocab: () => en };
});
vi.mock('@/design/Toast', () => ({ useToastOptional: () => null }));
vi.mock('@/features/settings/useSettings', () => ({ useSettings: () => ({ open: vi.fn() }) }));
vi.mock('@/features/schedule/useScheduleModal', () => ({ useScheduleModal: () => ({ open: vi.fn() }) }));
vi.mock('@/features/projects/CurrentProjectProvider', () => ({ useCurrentProject: () => ({ currentProjectId: null }) }));
vi.mock('@/features/session/state/SelectedSessionProvider', () => ({
  useSelectedSession: () => ({ selectedSessionId: null, setSelectedSession: vi.fn() }),
}));
vi.mock('@/features/dock/DockProvider', () => ({ useDock: () => ({ open: true, canDock: true, toggleDock: vi.fn() }) }));
vi.mock('@/theme/ThemeProvider', () => ({ useTheme: () => 'dark', useSetTheme: () => vi.fn() }));
vi.mock('../PaneStateProvider', () => ({ usePaneState: () => ({ toggleRail: vi.fn() }) }));
const machines = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock('@/features/machines/MachinesMenu', () => ({ useMachinesMenuActions: () => machines }));
vi.mock('../useShellModals', () => ({ useShellModals: () => ({
  openNewProject: vi.fn(), openAbout: vi.fn(), openDaemonStatus: vi.fn(),
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
  it('offers notes and machines in the View menu', () => {
    const view = menu.menus.find((group) => group.id === 'view')!;
    const ids = view.items.flatMap((node) => (node.kind === 'item' ? [node.id] : []));
    expect(ids).toEqual(expect.arrayContaining(['view.notes', 'view.machines']));
    expect(ids).not.toContain('view.rightPanel');
    const notes = view.items.find((node) => node.kind === 'item' && node.id === 'view.notes') as Extract<MenuNode, { kind: 'item' }>;
    expect(notes.accelDisplayOnly).toBe(true);
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('KeyboardEvent', class { constructor(type: string, init: object) { Object.assign(this, { type, ...init }); } });
    notes.run();
    expect(dispatchEvent.mock.calls[0][0]).toMatchObject({ type: 'keydown', key: 'N', shiftKey: true });
    (view.items.find((node) => node.kind === 'item' && node.id === 'view.machines') as Extract<MenuNode, { kind: 'item' }>).run();
    expect(machines.open).toHaveBeenCalledOnce();
  });

  it('disables and relabels updates during the real command, including stale repeated actions', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal('__TAURI__', { core: { invoke } });
    const staleAction = updateItem().run;
    expect(updateItem().disabled).toBe(false);
    act(() => { staleAction(); staleAction(); });
    expect(updateItem().disabled).toBe(true);
    await act(async () => {});
    expect(invoke).toHaveBeenCalledOnce();
    await act(async () => { finish({ ui: { status: 'current' }, shell: { status: 'current' } }); });
    expect(updateItem().disabled).toBe(false);
    expect(invoke.mock.calls).toEqual([['check_for_updates', undefined]]);
  });

  it('enables browser checks and disables stale actions while checking', async () => {
    vi.stubGlobal('__CORTEX_DESKTOP__', false);
    act(() => renderer.update(<Probe />));
    expect(updateItem().disabled).toBe(false);
    const invoke = vi.fn();
    vi.stubGlobal('__TAURI__', { core: { invoke } });
    const action = updateItem().run;
    act(() => { action(); action(); });
    expect(updateItem().disabled).toBe(true);
    expect(updateItem().label).toBe('Checking for updates…');
    await act(async () => {});
    expect(updateItem().disabled).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
