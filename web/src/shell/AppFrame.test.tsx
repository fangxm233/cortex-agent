// input:  real AppFrame/TopBar and window-state fixtures
// output: compact header and fullscreen space regressions
// pos:    Frame sizing and persistent shortcut ownership checks
// >>> Once updated, update this header and parent CORTEX.md <<<
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import { AppFrame } from './AppFrame';
const actions = { isFullscreen: false, isMaximized: false, minimize: vi.fn(), close: vi.fn(), toggleMaximize: vi.fn() };
const shortcuts = vi.fn();
vi.mock('@/i18n', () => ({ useVocab: () => en }));
vi.mock('./menu/useAppMenus', () => ({ useAppMenus: () => ({ menus: [], windowActions: actions }) }));
vi.mock('./menu/useNativeMenu', () => ({ useNativeMenu: () => ({ active: false }) }));
vi.mock('./menu/useMenuShortcuts', () => ({ useMenuShortcuts: (...args: unknown[]) => shortcuts(...args) }));
vi.mock('./PaneStateProvider', () => ({ usePaneState: () => ({ toggleRail: vi.fn() }) }));
vi.mock('./NavigationHistoryProvider', () => ({ useNavigationHistory: () => ({ back: vi.fn(), forward: vi.fn() }) }));
afterEach(() => { actions.isFullscreen = false; vi.clearAllMocks(); });
it('uses the real viewport without a fixed minimum and releases all header space in fullscreen', () => {
  const tree = create(<AppFrame><main>Content</main></AppFrame>);
  const frame = tree.root.findAllByType('div')[0];
  expect(frame.props.style).toMatchObject({ height: '100dvh', minHeight: 0, minWidth: 0 });
  const header = () => tree.root.findByProps({ 'data-app-topbar': true });
  expect(header().props.style).toMatchObject({ height: 34, boxSizing: 'border-box', display: 'flex' });
  actions.isFullscreen = true;
  act(() => tree.update(<AppFrame><main>Content</main></AppFrame>));
  expect(header().props.style.display).toBe('none');
  expect(shortcuts).toHaveBeenCalledTimes(2);
  expect(tree.root.findByProps({ 'data-app-panes': true }).props.style).toMatchObject({ flex: 1, minHeight: 0 });
  actions.isFullscreen = false;
  act(() => tree.update(<AppFrame><main>Content</main></AppFrame>));
  expect(header().props.style.display).toBe('flex');
  act(() => tree.unmount());
});
