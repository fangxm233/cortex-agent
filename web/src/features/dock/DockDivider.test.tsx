import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockDivider } from './DockDivider';

function panes(): { pane: HTMLElement; chat: HTMLElement } {
  const chat = { style: {} as CSSStyleDeclaration, getBoundingClientRect: () => ({ left: 0, width: 500 }) };
  const pane = { style: {} as CSSStyleDeclaration, previousElementSibling: chat, getBoundingClientRect: () => ({ left: 500, width: 500 }) };
  return { pane: pane as unknown as HTMLElement, chat: chat as unknown as HTMLElement };
}

function mount(onCommit = vi.fn()): { handle: ReactTestInstance; onCommit: ReturnType<typeof vi.fn>; pane: HTMLElement; chat: HTMLElement } {
  const { pane, chat } = panes();
  let root!: ReturnType<typeof create>;
  act(() => {
    root = create(<DockDivider split={0.5} label="resize" paneRef={{ current: pane }} onCommit={onCommit} />);
  });
  return { handle: root.root.findByProps({ role: 'separator' }), onCommit, pane, chat };
}

const target = { setPointerCapture: () => {} };
const down = (clientX: number, button = 0) => ({ button, clientX, pointerId: 1, preventDefault() {}, currentTarget: target });

describe('DockDivider', () => {
  beforeEach(() => vi.stubGlobal('document', { body: { style: {} } }));
  afterEach(() => vi.unstubAllGlobals());

  it('moves both panes during the drag and commits the ratio once on release', () => {
    const { handle, onCommit, pane, chat } = mount();
    act(() => handle.props.onPointerDown(down(500)));
    act(() => handle.props.onPointerMove({ clientX: 400 }));
    expect(pane.style.flexGrow).toBe('0.6');
    expect(Number(chat.style.flexGrow)).toBeCloseTo(0.4);
    expect(onCommit).not.toHaveBeenCalled();
    act(() => handle.props.onPointerUp());
    act(() => handle.props.onLostPointerCapture());
    expect(onCommit.mock.calls).toEqual([[0.6]]);
  });

  it('ignores non-primary buttons and moves without a press', () => {
    const { handle, onCommit, pane } = mount();
    act(() => handle.props.onPointerDown(down(500, 2)));
    act(() => handle.props.onPointerMove({ clientX: 400 }));
    act(() => handle.props.onPointerUp());
    expect(pane.style.flexGrow).toBeUndefined();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
