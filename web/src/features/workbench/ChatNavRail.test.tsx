// input:  nav marks, an active row, and a fake jump callback
// output: Rail visibility, tick emphasis, preview content, and jump wiring
// pos:    Behavior tests for the desktop transcript nav rail
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { ChatNavRail } from './ChatNavRail';
import type { NavMark } from './chat-nav';

function mark(row: number, title: string, extra: Partial<NavMark> = {}): NavMark {
  return { row, title, body: [], truncated: false, attachments: [], pending: false, ...extra };
}

function mount(marks: NavMark[], activeRow: number | null, onJump = vi.fn()): {
  tree: ReactTestRenderer;
  onJump: ReturnType<typeof vi.fn>;
} {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<LangProvider><ChatNavRail marks={marks} activeRow={activeRow} onJump={onJump} /></LangProvider>);
  });
  return { tree, onJump };
}

function tick(tree: ReactTestRenderer, row: number): ReactTestInstance {
  return tree.root.findByProps({ 'data-nav-tick': row });
}

function text(tree: ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON());
}

describe('ChatNavRail', () => {
  it('stays away until there is somewhere to navigate', () => {
    expect(mount([], null).tree.toJSON()).toBeNull();
    expect(mount([mark(1, 'only prompt')], null).tree.toJSON()).toBeNull();
  });

  it('draws one tick per prompt', () => {
    const { tree } = mount([mark(1, 'first'), mark(4, 'second'), mark(9, 'third')], null);
    expect(tree.root.findAll((n) => n.props?.['data-nav-tick'] !== undefined).length).toBe(3);
  });

  it('widens the tick the transcript is sitting on', () => {
    const { tree } = mount([mark(1, 'first'), mark(4, 'second')], 4);
    const widthOf = (row: number): number => {
      const line = tick(tree, row).findAll((n) => n.type === 'span')[0];
      return line.props.style.width as number;
    };
    expect(widthOf(4)).toBeGreaterThan(widthOf(1));
  });

  it('previews the focused prompt with its body and attachments', () => {
    const { tree } = mount([
      mark(1, '这是论文源码，你改一版吧。', {
        body: ['已改好，7 页（含参考文献）', '重写了 Introduction'],
        truncated: true,
        attachments: [{ name: 'HAP_revised.pdf', type: 'file' }],
      }),
      mark(4, 'second'),
    ], null);
    expect(text(tree)).not.toContain('HAP_revised.pdf');
    act(() => { tick(tree, 1).props.onFocus(); });
    const shown = text(tree);
    expect(shown).toContain('这是论文源码，你改一版吧。');
    expect(shown).toContain('重写了 Introduction');
    expect(shown).toContain('HAP_revised.pdf');
    expect(shown).toContain('PDF');
  });

  it('drops the preview when focus leaves the tick', () => {
    const { tree } = mount([mark(1, 'first'), mark(4, 'second')], null);
    act(() => { tick(tree, 1).props.onFocus(); });
    act(() => { tick(tree, 1).props.onBlur(); });
    expect(tree.root.findAll((n) => n.props?.['aria-label'] === 'first' && n.type === 'div').length).toBe(0);
  });

  it('reports the row a click asks for, and closes the preview', () => {
    const { tree, onJump } = mount([mark(1, 'first'), mark(4, 'second')], null);
    act(() => { tick(tree, 4).props.onFocus(); });
    act(() => { tick(tree, 4).props.onClick(); });
    expect(onJump).toHaveBeenCalledWith(4);
    expect(text(tree)).not.toContain('shadow-overlay');
  });
});
