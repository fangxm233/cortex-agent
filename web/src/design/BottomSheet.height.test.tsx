import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MBottomSheet } from './BottomSheet';

vi.mock('./mobile-overlay-host', () => ({ MobileOverlayPortal: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('./use-back-dismiss', () => ({ useBackDismiss: vi.fn() }));

const geometry = { content: 300, available: 640 };
const nodes = {
  host: { get clientHeight() { return geometry.available; } },
  sheet: {},
  scroll: { offsetTop: 33 },
  content: { get offsetHeight() { return geometry.content; } },
};
let notify: () => void;
let renderer: ReactTestRenderer;
const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
  geometry.content = 300;
  geometry.available = 640;
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('getComputedStyle', (node: unknown) => node === nodes.host ? { paddingTop: '12px' } : { paddingBottom: '56px' });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notify = callback; }
    observe = observe;
    disconnect = disconnect;
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function mount(animateHeight = true): void {
  act(() => {
    renderer = create(<MBottomSheet onClose={vi.fn()} animateHeight={animateHeight}><div>root</div></MBottomSheet>, {
      createNodeMock: ({ props }) => {
        if ('data-mobile-sheet-host' in props) return nodes.host;
        if ('data-mobile-sheet' in props) return nodes.sheet;
        return props['data-mobile-sheet-scroll'] ? nodes.scroll : nodes.content;
      },
    });
  });
}

const shell = () => renderer.root.findByProps({ 'data-mobile-sheet': true });
const scroll = () => renderer.root.findByProps({ 'data-mobile-sheet-scroll': 'true' });

function navigate(height: number, pane: string): void {
  geometry.content = height;
  act(() => renderer.update(<MBottomSheet onClose={vi.fn()} animateHeight><div>{pane}</div></MBottomSheet>));
}

describe('opt-in bottom sheet height', () => {
  it('starts at natural height, then transitions capped numeric targets in both directions', () => {
    mount();
    expect(shell().props.style.height).toBe(389);
    expect(shell().props.style.bottom).toBe(0);
    expect(shell().props.style.transition).toContain('height 200ms ease-out');
    expect(scroll().props.style).toMatchObject({ flex: 1, minHeight: 0, overflowX: 'hidden', overflowY: 'auto', scrollbarGutter: 'stable' });
    navigate(1200, 'model');
    expect(shell().props.style.height).toBe(628); // available minus the safe top gap
    navigate(100, 'thinking');
    expect(shell().props.style.height).toBe(189); // no uncapped 1289px target to animate through
    navigate(300, 'root');
    expect(shell().props.style.height).toBe(389);
  });

  it('observes async content and viewport resizing, and disconnects on unmount', () => {
    mount();
    expect(observe.mock.calls).toEqual([[nodes.host], [nodes.content]]);
    geometry.content = 900;
    act(() => notify());
    expect(shell().props.style.height).toBe(628);
    geometry.available = 400;
    act(() => notify());
    expect(shell().props.style.height).toBe(388);
    geometry.available = 700;
    act(() => notify());
    expect(shell().props.style.height).toBe(688);
    geometry.content = 50;
    act(() => notify());
    expect(shell().props.style.height).toBe(139);
    act(() => renderer.unmount());
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('preserves nested Escape and delayed dim dismissal with measured height', () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    mount();
    const onClose = vi.fn();
    const onBack = vi.fn();
    act(() => renderer.update(<MBottomSheet onClose={onClose} onBack={onBack} animateHeight><div>model</div></MBottomSheet>));
    act(() => { window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })); });
    expect(onBack).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    const dim = renderer.root.find((node) => node.type === 'div' && !!node.props.onClick);
    act(() => dim.props.onClick());
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(300); });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the grab handle live for drag dismissal', () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    mount();
    const onClose = vi.fn();
    act(() => renderer.update(<MBottomSheet onClose={onClose} animateHeight><div>root</div></MBottomSheet>));
    const handle = renderer.root.find((node) => node.type === 'div' && !!node.props.onPointerDown);
    expect(handle.props.style.flexShrink).toBe(0);
    act(() => handle.props.onPointerDown({ currentTarget: {}, clientY: 100, pointerId: 1 }));
    expect(shell().props.style.transition).toBe('none');
    act(() => handle.props.onPointerMove({ clientY: 300 }));
    act(() => handle.props.onPointerUp());
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(300); });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('leaves other sheets on automatic height without a measurement wrapper or observer', () => {
    mount(false);
    expect(shell().props.style.height).toBeUndefined();
    expect(shell().props.style.transition).not.toContain('height');
    expect(scroll().props.style.scrollbarGutter).toBeUndefined();
    expect(renderer.root.findAllByProps({ 'data-mobile-sheet-content': true })).toHaveLength(0);
    expect(observe).not.toHaveBeenCalled();
  });
});
