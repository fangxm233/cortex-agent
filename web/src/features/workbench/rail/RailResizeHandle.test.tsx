// input:  RailResizeHandle, react-test-renderer
// output: rail divider drag regression tests
// pos:    Verify drag deltas, clamping, commit and reset of the left rail width
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { RailResizeHandle } from './RailResizeHandle';
import { RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MAX } from './rail-width';

function mount(width: number, onResize = vi.fn()): { handle: ReactTestInstance; onResize: ReturnType<typeof vi.fn> } {
  let root!: ReturnType<typeof create>;
  act(() => {
    root = create(<LangProvider><RailResizeHandle width={width} onResize={onResize} /></LangProvider>);
  });
  return { handle: root.root.findByProps({ role: 'separator' }), onResize };
}

const target = { setPointerCapture: () => {} };

describe('RailResizeHandle', () => {
  beforeEach(() => vi.stubGlobal('document', { body: { style: {} } }));
  afterEach(() => vi.unstubAllGlobals());

  it('follows the pointer and commits the width it ends on', () => {
    const { handle, onResize } = mount(300);
    act(() => handle.props.onPointerDown({ button: 0, clientX: 100, pointerId: 1, preventDefault() {}, currentTarget: target }));
    act(() => handle.props.onPointerMove({ clientX: 160 }));
    act(() => handle.props.onPointerUp());
    expect(onResize.mock.calls).toEqual([[300, false], [360, false], [360, true]]);
  });

  it('clamps to the band and ignores non-primary buttons', () => {
    const { handle, onResize } = mount(300);
    act(() => handle.props.onPointerDown({ button: 2, clientX: 0, pointerId: 1, preventDefault() {}, currentTarget: target }));
    act(() => handle.props.onPointerMove({ clientX: 50 }));
    expect(onResize).not.toHaveBeenCalled();
    act(() => handle.props.onPointerDown({ button: 0, clientX: 0, pointerId: 1, preventDefault() {}, currentTarget: target }));
    act(() => handle.props.onPointerMove({ clientX: 5000 }));
    act(() => handle.props.onPointerUp());
    expect(onResize).toHaveBeenLastCalledWith(RAIL_WIDTH_MAX, true);
  });

  it('resets to the default on double-click', () => {
    const { handle, onResize } = mount(420);
    act(() => handle.props.onDoubleClick());
    expect(onResize).toHaveBeenCalledWith(RAIL_WIDTH_DEFAULT, true);
  });
});
