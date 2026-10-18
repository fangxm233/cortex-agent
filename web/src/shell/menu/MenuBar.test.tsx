import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MenuBar } from './MenuBar';
import type { MenuDef } from './menu-model';

vi.mock('@/lib/desktop-platform', () => ({ usesCommandKey: () => false }));

const menus: MenuDef[] = [{
  id: 'view', label: 'View', items: [
    { kind: 'item', id: 'view.dock', label: 'Dock', accel: 'mod+j', run: vi.fn() },
    { kind: 'item', id: 'view.zoomIn', label: 'Zoom in', accel: 'mod+=', disabled: true, run: vi.fn() },
    { kind: 'submenu', id: 'view.appearance', label: 'Appearance', items: [
      { kind: 'item', id: 'view.theme.light', label: 'Light', checked: true, run: vi.fn() },
    ] },
  ],
}];

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');

afterEach(() => { vi.unstubAllGlobals(); });

describe('in-app menu bar', () => {
  it('opens an opaque panel and keeps disabled rows legible with a dimmed shortcut', () => {
    // An open menu listens on the window for Escape and outside clicks.
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const view = create(<MenuBar menus={menus} />);
    act(() => view.root.findByProps({ className: 'shell-menu-trigger' }).props.onClick({ stopPropagation: () => {} }));
    const panel = view.root.findByProps({ role: 'menu' });
    expect(panel.props.style.background).toBe('var(--proto-card)');
    expect(panel.props.style.backdropFilter).toBeUndefined();
    const rows = view.root.findAllByProps({ role: 'menuitem' });
    const zoom = rows.find((row) => text(row).startsWith('Zoom in'))!;
    expect(zoom.props.style.color).toBe('var(--proto-faint)');
    expect(zoom.findAllByType('span').at(-1)!.props.style.color).toBe('var(--proto-faint)');
    const dock = rows.find((row) => text(row).startsWith('Dock'))!;
    expect(dock.findAllByType('span').at(-1)!.props.style.color).toBe('var(--proto-muted)');
    act(() => view.unmount());
  });
});
