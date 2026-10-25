import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DockTabMenu } from './DockTabMenu';

vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: unknown) => node,
}));

beforeAll(() => {
  vi.stubGlobal('window', { innerWidth: 1200, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('document', { body: {} });
});
afterAll(() => { vi.unstubAllGlobals(); });

function mount(pinned: boolean) {
  const calls = { onPin: vi.fn(), onUnpin: vi.fn(), onClose: vi.fn(), onDismiss: vi.fn() };
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<DockTabMenu target={{ id: 'tab-1', x: 40, y: 30 }} pinned={pinned} {...calls} />); });
  return { renderer, calls };
}

function pick(renderer: ReactTestRenderer, id: string): void {
  act(() => renderer.root.findByProps({ 'data-selection-row': id }).props.onClick({ stopPropagation: () => {} }));
}

function label(renderer: ReactTestRenderer, id: string): string {
  return renderer.root.findByProps({ 'data-selection-row': id }).findByType('span').props.children;
}

describe('dock tab menu', () => {
  it('pins an unpinned tab and dismisses itself', () => {
    const { renderer, calls } = mount(false);
    expect(label(renderer, 'pin')).toBe('Pin tab');
    pick(renderer, 'pin');
    expect(calls.onPin).toHaveBeenCalledWith('tab-1');
    expect(calls.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('offers unpin and close for a pinned tab', () => {
    const { renderer, calls } = mount(true);
    expect(label(renderer, 'pin')).toBe('Unpin tab');
    pick(renderer, 'pin');
    pick(renderer, 'close');
    expect(calls.onUnpin).toHaveBeenCalledWith('tab-1');
    expect(calls.onClose).toHaveBeenCalledWith('tab-1');
    expect(calls.onPin).not.toHaveBeenCalled();
  });
});
