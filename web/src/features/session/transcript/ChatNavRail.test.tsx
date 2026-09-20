import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { ChatNavRail } from './ChatNavRail';
import type { NavMark } from './chat-nav';

/** Rail geometry the component would read from the DOM: a 600px-tall pane whose tick column starts
 *  at the viewport's top edge, so a pointer's clientY IS its offset into the column. */
const PANE_H = 600;
function nodeMock(): unknown {
  return {
    clientHeight: PANE_H,
    offsetHeight: 120,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 26, height: PANE_H, bottom: PANE_H, right: 26 }),
    querySelector: () => null,
    scrollIntoView: () => {},
  };
}

function mark(row: number, title: string, extra: Partial<NavMark> = {}): NavMark {
  return { row, title, body: [], truncated: false, attachments: [], pending: false, ...extra };
}

function mount(marks: NavMark[], activeRows: number[] = [], onJump = vi.fn()): {
  tree: ReactTestRenderer;
  onJump: ReturnType<typeof vi.fn>;
} {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <LangProvider><ChatNavRail marks={marks} activeRows={activeRows} onJump={onJump} /></LangProvider>,
      { createNodeMock: nodeMock },
    );
  });
  return { tree, onJump };
}

function tick(tree: ReactTestRenderer, row: number): ReactTestInstance {
  return tree.root.findByProps({ 'data-nav-tick': row });
}

/** The tick column — the strip that tracks the pointer. */
function column(tree: ReactTestRenderer): ReactTestInstance {
  return tree.root.findAll((n) => typeof n.props?.onMouseMove === 'function')[0];
}

function move(tree: ReactTestRenderer, clientY: number): void {
  act(() => { column(tree).props.onMouseMove({ clientY }); });
}

function text(tree: ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON());
}

describe('ChatNavRail', () => {
  it('stays away until there is somewhere to navigate', () => {
    expect(mount([]).tree.toJSON()).toBeNull();
    expect(mount([mark(1, 'only prompt')]).tree.toJSON()).toBeNull();
  });

  it('reports the row a click asks for, and closes the preview', () => {
    const { tree, onJump } = mount([mark(0, 'first', { body: ['body line'] }), mark(2, 'second')]);
    move(tree, 4);
    act(() => { tick(tree, 0).props.onClick(); });
    expect(onJump).toHaveBeenCalledWith(0);
    expect(text(tree)).not.toContain('body line');
  });
});
