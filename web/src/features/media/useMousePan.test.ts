import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindMousePan, type PanZoom } from './useMousePan';

// Node environment: `EventTarget` stands in for the stage element and `window`.
let win: EventTarget;

function mouse(type: string, x: number, y: number, button = 0): Event {
  return Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: y, button });
}

function setup(zoom: PanZoom, hasContent = true) {
  const el = new EventTarget();
  const state = { zoom, dragging: false };
  const unbind = bindMousePan(el, {
    getZoom: () => state.zoom,
    hasContent: () => hasContent,
    setTranslate: (t) => { state.zoom = { ...state.zoom, ...t }; },
    onDragChange: (d) => { state.dragging = d; },
  });
  return { el, state, unbind };
}

beforeEach(() => {
  win = new EventTarget();
  vi.stubGlobal('window', win);
});
afterEach(() => vi.unstubAllGlobals());

describe('bindMousePan', () => {
  it('drags the zoomed content 1:1 with the cursor, from its current translate', () => {
    const { el, state } = setup({ scale: 2, x: 10, y: 20 });
    const down = mouse('mousedown', 100, 100);
    el.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(state.dragging).toBe(true);
    win.dispatchEvent(mouse('mousemove', 130, 80));
    expect(state.zoom).toEqual({ scale: 2, x: 40, y: 0 });
    win.dispatchEvent(mouse('mouseup', 130, 80));
    expect(state.dragging).toBe(false);
    win.dispatchEvent(mouse('mousemove', 300, 300));
    expect(state.zoom).toEqual({ scale: 2, x: 40, y: 0 });
  });

  it('does not start at 1x, on a non-left button, or without image content (video)', () => {
    for (const [zoom, button, content] of [
      [{ scale: 1, x: 0, y: 0 }, 0, true],
      [{ scale: 2, x: 0, y: 0 }, 2, true],
      [{ scale: 2, x: 0, y: 0 }, 0, false],
    ] as const) {
      const { el, state } = setup(zoom, content);
      const down = mouse('mousedown', 0, 0, button);
      el.dispatchEvent(down);
      win.dispatchEvent(mouse('mousemove', 50, 50));
      expect(down.defaultPrevented).toBe(false);
      expect(state.dragging).toBe(false);
      expect(state.zoom).toEqual(zoom);
    }
  });

  it('swallows the click that ends a real drag, but not a plain click', () => {
    const { el } = setup({ scale: 2, x: 0, y: 0 });
    const click = (): Event => {
      const e = new Event('click', { cancelable: true });
      win.dispatchEvent(e);
      return e;
    };

    el.dispatchEvent(mouse('mousedown', 0, 0));
    win.dispatchEvent(mouse('mousemove', 40, 0));
    win.dispatchEvent(mouse('mouseup', 40, 0));
    expect(click().defaultPrevented).toBe(true);

    el.dispatchEvent(mouse('mousedown', 0, 0));
    win.dispatchEvent(mouse('mousemove', 2, 0));
    win.dispatchEvent(mouse('mouseup', 2, 0));
    expect(click().defaultPrevented).toBe(false);
  });

  it('drops the click guard when no click follows the drag', async () => {
    const { el } = setup({ scale: 2, x: 0, y: 0 });
    el.dispatchEvent(mouse('mousedown', 0, 0));
    win.dispatchEvent(mouse('mousemove', 40, 0));
    win.dispatchEvent(mouse('mouseup', 40, 0));
    await new Promise((r) => setTimeout(r, 0));
    const e = new Event('click', { cancelable: true });
    win.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('unbinding mid-drag stops tracking', () => {
    const { el, state, unbind } = setup({ scale: 2, x: 0, y: 0 });
    el.dispatchEvent(mouse('mousedown', 0, 0));
    unbind();
    expect(state.dragging).toBe(false);
    win.dispatchEvent(mouse('mousemove', 50, 50));
    expect(state.zoom).toEqual({ scale: 2, x: 0, y: 0 });
  });
});
