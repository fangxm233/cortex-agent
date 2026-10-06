import { useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStickToBottom, type StickToBottom } from './useStickToBottom';

const scroller = { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 };
const observers: Array<() => void> = [];
let api!: StickToBottom;

function Stream({ streamKey, rows, freezeMs }: { streamKey: string; rows: number; freezeMs?: number }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  api = useStickToBottom(scrollRef, contentRef, { streamKey, changes: [rows], freezeMs });
  return <div ref={scrollRef} data-scroller=""><div ref={contentRef} data-content="" /></div>;
}

function mount(props: { streamKey: string; rows: number; freezeMs?: number }): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Stream {...props} />, {
      createNodeMock: (node) => (node.props['data-scroller'] !== undefined ? scroller : {}),
    });
  });
  return renderer;
}

/** The user scrolls to `top`; content then grows to `height`. */
function scrollTo(top: number): void { scroller.scrollTop = top; api.onScroll(); }
function grow(height: number): void { scroller.scrollHeight = height; act(() => observers.forEach((fire) => fire())); }

vi.stubGlobal('ResizeObserver', class {
  constructor(callback: () => void) { observers.push(callback); }
  observe = vi.fn();
  disconnect = vi.fn();
});

afterEach(() => {
  Object.assign(scroller, { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
  observers.length = 0;
  vi.useRealTimers();
});

describe('useStickToBottom', () => {
  it('opens at the bottom and follows new rows and growing content while pinned', () => {
    const r = mount({ streamKey: 'a', rows: 1 });
    expect(scroller.scrollTop).toBe(2000);
    scroller.scrollHeight = 2300;
    act(() => r.update(<Stream streamKey="a" rows={2} />));
    expect(scroller.scrollTop).toBe(2300);
    grow(2400);
    expect(scroller.scrollTop).toBe(2400);
  });

  it('lets go when the user scrolls up and re-pins once they are back near the bottom', () => {
    const r = mount({ streamKey: 'a', rows: 1 });
    scrollTo(800);
    grow(2600);
    act(() => r.update(<Stream streamKey="a" rows={2} />));
    expect(scroller.scrollTop).toBe(800);
    scrollTo(2600 - 500 - 30);
    grow(2700);
    expect(scroller.scrollTop).toBe(2700);
  });

  it('opens another stream at its bottom even after the previous one was released', () => {
    const r = mount({ streamKey: 'a', rows: 1 });
    act(() => api.release());
    grow(2500);
    expect(scroller.scrollTop).toBe(2000);
    act(() => r.update(<Stream streamKey="b" rows={1} />));
    expect(scroller.scrollTop).toBe(2500);
  });

  it('holds still for the freeze after a tap, then follows again', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    mount({ streamKey: 'a', rows: 1, freezeMs: 800 });
    api.freeze();
    grow(2400);
    expect(scroller.scrollTop).toBe(2000);
    vi.setSystemTime(10_800);
    grow(2500);
    expect(scroller.scrollTop).toBe(2500);
  });

  it('ignores a tap where no freeze was asked for', () => {
    mount({ streamKey: 'a', rows: 1 });
    api.freeze();
    grow(2400);
    expect(scroller.scrollTop).toBe(2400);
  });
});
