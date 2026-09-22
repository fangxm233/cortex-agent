// input:  Toast provider, viewport, react-test-renderer, Vitest
// output: Notification material, timer and interaction checks
// pos:    Guard toast shell extraction and notification lifecycle
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast, type ToastInput } from './Toast';
import { ToastViewport } from './ToastViewport';

// The one on-screen stack: both producers (imperative `toast()` calls and the notification feed)
// render through this, so the timing/dismissal rules are asserted here rather than per feature.

let api: ReturnType<typeof useToast> | null = null;

function Probe(): null {
  api = useToast();
  return null;
}

function mount(): ReactTestRenderer {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(<ToastProvider><Probe /><ToastViewport /></ToastProvider>);
  });
  return renderer!;
}

function push(input: ToastInput): string {
  let id = '';
  act(() => { id = api!.toast(input); });
  return id;
}

function bubbles(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAll((node) => typeof node.props['data-toast-level'] === 'string');
}

function byLabel(tree: ReactTestRenderer, label: string): ReactTestInstance[] {
  return tree.root.findAll((node) => node.props['aria-label'] === label);
}

let tree: ReactTestRenderer;

beforeEach(() => {
  vi.useFakeTimers();
  api = null;
  tree = mount();
});

afterEach(() => {
  act(() => tree.unmount());
  vi.useRealTimers();
});

describe('ToastViewport', () => {
  it('keeps material actions unfiltered and prevents them from activating the body', () => {
    const onActivate = vi.fn(), onClick = vi.fn(), stopPropagation = vi.fn();
    push({ title: 'Ready', onActivate, actions: [{ label: 'Open', onClick }] });
    const action = byLabel(tree, 'Open')[0];
    expect(bubbles(tree)[0].props.className).toContain('[background:var(--material-overlay-bg)]');
    expect(action.props.className).toContain('[background:var(--material-control-bg)]');
    expect(action.props.className).not.toContain('backdrop-filter');
    act(() => action.props.onClick({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onActivate).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('expands overflow without changing the notification order', () => {
    for (let i = 0; i < 4; i++) push({ title: `Notice ${i}`, duration: Infinity });
    expect(bubbles(tree)).toHaveLength(3);
    const more = tree.root.findAllByType('button').find(node => node.props.className.includes('pointer-events-auto'))!;
    expect(more.props.className).toContain('[background:var(--material-overlay-bg)]');
    act(() => more.props.onClick());
    expect(bubbles(tree)).toHaveLength(4);
    const titles = tree.root.findAllByType('span').filter(node => node.props.className.includes('truncate'));
    expect(titles.map(node => node.children[0])).toEqual(['Notice 0', 'Notice 1', 'Notice 2', 'Notice 3']);
  });

  it('auto-dismisses after the item duration and maps tone to level', () => {
    push({ title: 'Saved', tone: 'done', duration: 5000 });
    expect(bubbles(tree)).toHaveLength(1);
    expect(bubbles(tree)[0].props['data-toast-level']).toBe('success');

    act(() => { vi.advanceTimersByTime(4999); });
    expect(bubbles(tree)).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(bubbles(tree)).toHaveLength(0);
  });

  it('keeps a resident bubble (duration Infinity) until dismissed imperatively', () => {
    const id = push({ title: 'Checking…', tone: 'running', duration: Infinity });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(bubbles(tree)).toHaveLength(1);

    act(() => api!.dismiss(id));
    expect(bubbles(tree)).toHaveLength(0);
  });

  it('pauses the countdown while hovered', () => {
    push({ title: 'Downloaded', tone: 'done', duration: 5000 });
    act(() => { vi.advanceTimersByTime(4000); });
    act(() => { bubbles(tree)[0].props.onMouseEnter(); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(bubbles(tree)).toHaveLength(1);

    act(() => { bubbles(tree)[0].props.onMouseLeave(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(bubbles(tree)).toHaveLength(0);
  });

  it('runs the click-through target once and dismisses; inert bubbles ignore body clicks', () => {
    const onActivate = vi.fn();
    push({ title: 'Inbox', description: 'Done', onActivate });
    act(() => { bubbles(tree)[0].props.onClick(); });
    expect(onActivate).toHaveBeenCalledOnce();
    expect(bubbles(tree)).toHaveLength(0);

    push({ title: 'Saved' });
    expect(bubbles(tree)[0].props.onClick).toBeUndefined();
  });

  it('runs an action button and dismisses the bubble', () => {
    const onClick = vi.fn();
    push({ title: 'Downloaded', actions: [{ label: 'Open file', onClick }], duration: 10_000 });
    act(() => {
      byLabel(tree, 'Open file')[0].props.onClick({ stopPropagation: () => {} });
    });
    expect(onClick).toHaveBeenCalledOnce();
    expect(bubbles(tree)).toHaveLength(0);
  });
});
