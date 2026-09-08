// input:  nav marks, the visible turn set, mocked rail geometry, and a fake jump callback
// output: Rail visibility, visible-turn lighting, pointer magnification, preview and jump wiring
// pos:    Behavior tests for the desktop transcript nav rail
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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

/** The preview card, found by its fixed width — `top` is where it landed against the rail. */
function card(tree: ReactTestRenderer): { top: number } {
  const node = tree.root.findAll((n) => n.type === 'div' && n.props?.style?.width === 360)[0];
  return { top: node.props.style.top as number };
}

/** The drawn line inside a tick — its width is the magnification, its background the lighting. */
function line(tree: ReactTestRenderer, row: number): { width: number; background: string } {
  const style = tick(tree, row).findAll((n) => n.type === 'span')[0].props.style;
  return { width: style.width as number, background: style.background as string };
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

/** Ten marks at the 14px step a roomy pane gives: tick i is centred at 14i + 7. */
const many = Array.from({ length: 10 }, (_, i) => mark(i * 2, `prompt ${i}`));

describe('ChatNavRail', () => {
  it('stays away until there is somewhere to navigate', () => {
    expect(mount([]).tree.toJSON()).toBeNull();
    expect(mount([mark(1, 'only prompt')]).tree.toJSON()).toBeNull();
  });

  it('draws one tick per prompt', () => {
    const { tree } = mount(many);
    expect(tree.root.findAll((n) => n.props?.['data-nav-tick'] !== undefined).length).toBe(10);
  });

  it('lights every turn on screen without changing any length', () => {
    const { tree } = mount(many, [2, 4, 6]);
    const lit = line(tree, 4);
    const dark = line(tree, 12);
    expect(lit.background).not.toBe(dark.background);
    expect(line(tree, 2).background).toBe(lit.background);
    expect(line(tree, 6).background).toBe(lit.background);
    expect(lit.width).toBe(dark.width);
  });

  it('swells the ticks around the pointer and leaves the far ones alone', () => {
    const { tree } = mount(many);
    const resting = line(tree, 0).width;
    move(tree, 45); // inside the fourth tick — rows 6, 8, 18 are it, its neighbour and a far one
    const under = line(tree, 6).width;
    const neighbour = line(tree, 8).width;
    const far = line(tree, 18).width;
    expect(under).toBeGreaterThan(neighbour);
    expect(neighbour).toBeGreaterThan(far);
    expect(far).toBe(resting);
  });

  it('keeps the settled tick clearly longer than the one next to it', () => {
    const { tree } = mount(many);
    move(tree, 45);
    // A glance has to say which tick is being picked, so the gap to the neighbour is a real step,
    // not a hair — and it holds anywhere inside the tick, not only at its exact middle.
    expect(line(tree, 6).width - line(tree, 8).width).toBeGreaterThan(4);
    move(tree, 55);
    expect(line(tree, 6).width - line(tree, 8).width).toBeGreaterThan(4);
  });

  it('lets every tick settle back when the pointer leaves', () => {
    const { tree } = mount(many);
    const resting = line(tree, 0).width;
    move(tree, 45);
    expect(line(tree, 8).width).toBeGreaterThan(resting);
    act(() => { column(tree).props.onMouseLeave(); });
    expect(line(tree, 8).width).toBe(resting);
    expect(line(tree, 4).width).toBe(resting);
  });

  it('previews the prompt under the pointer, with its body and attachments', () => {
    const { tree } = mount([
      mark(0, '这是论文源码，你改一版吧。', {
        body: ['已改好，7 页（含参考文献）', '重写了 Introduction'],
        truncated: true,
        attachments: [{ name: 'HAP_revised.pdf', type: 'file' }],
      }),
      mark(2, 'second'),
    ]);
    expect(text(tree)).not.toContain('HAP_revised.pdf');
    move(tree, 4);
    const shown = text(tree);
    expect(shown).toContain('这是论文源码，你改一版吧。');
    expect(shown).toContain('重写了 Introduction');
    expect(shown).toContain('HAP_revised.pdf');
    expect(shown).toContain('PDF');
  });

  it('follows the pointer from one prompt to the next', () => {
    // Bodies, not titles: a title also renders as the tick's own label and tooltip.
    const { tree } = mount([
      mark(0, 'first prompt', { body: ['first body'] }),
      mark(2, 'second prompt', { body: ['second body'] }),
      mark(4, 'third prompt', { body: ['third body'] }),
    ]);
    move(tree, 4);
    expect(text(tree)).toContain('first body');
    move(tree, 32);
    const shown = text(tree);
    expect(shown).toContain('third body');
    expect(shown).not.toContain('first body');
  });

  it('drops the preview when the pointer leaves the rail', () => {
    const { tree } = mount([mark(0, 'first', { body: ['body line'] }), mark(2, 'second')]);
    move(tree, 4);
    expect(text(tree)).toContain('body line');
    act(() => { column(tree).props.onMouseLeave(); });
    expect(text(tree)).not.toContain('body line');
  });

  it('previews from the keyboard too', () => {
    const { tree } = mount([mark(0, 'first', { body: ['body line'] }), mark(2, 'second')]);
    act(() => {
      tick(tree, 0).props.onFocus({ currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 10 }) } });
    });
    expect(text(tree)).toContain('body line');
  });

  it('measures the pane on the render that first draws the rail', () => {
    // The rail is absent until a session has two prompts, so its node arrives after the component
    // does. Miss that and the pane reads as zero: ticks jam at their floor and the card is pinned
    // to the top of the pane instead of sitting beside the tick it describes.
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <LangProvider><ChatNavRail marks={[mark(0, 'first')]} activeRows={[]} onJump={vi.fn()} /></LangProvider>,
        { createNodeMock: nodeMock },
      );
    });
    expect(tree.toJSON()).toBeNull();
    act(() => {
      tree.update(<LangProvider><ChatNavRail marks={many} activeRows={[]} onJump={vi.fn()} /></LangProvider>);
    });
    expect(tick(tree, 0).props.style.height).toBe(14);
    move(tree, 200); // the last tick, low in the pane — the card follows it down
    expect(card(tree).top).toBeGreaterThan(60);
  });

  it('reports the row a click asks for, and closes the preview', () => {
    const { tree, onJump } = mount([mark(0, 'first', { body: ['body line'] }), mark(2, 'second')]);
    move(tree, 4);
    act(() => { tick(tree, 0).props.onClick(); });
    expect(onJump).toHaveBeenCalledWith(0);
    expect(text(tree)).not.toContain('body line');
  });
});
