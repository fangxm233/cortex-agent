import { describe, expect, it } from 'vitest';
import { act, create } from 'react-test-renderer';
import { LangProvider } from '@/i18n';
import { MessageStream } from './MessageStream';
import type { ChatRow } from './transcript-vm';

// The scroll box is the only host node with an onScroll handler; every other ref gets an inert stub.
function fakeScroller() {
  return {
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [],
    style: { setProperty: () => {} },
  };
}

function rowsOf(label: string): ChatRow[] {
  return [{ kind: 'divider', text: label }];
}

describe('MessageStream scroll pin across sessions', () => {
  it('opens another session at its bottom even after the previous one was scrolled up', () => {
    const scroller = fakeScroller();
    const view = (streamKey: string, rows: ChatRow[]) => (
      <LangProvider>
        <MessageStream rows={rows} loading={false} streamKey={streamKey} />
      </LangProvider>
    );
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(view('a', rowsOf('a1')), {
        createNodeMock: (el) => (el.props.onScroll ? scroller : {}),
      });
    });
    expect(scroller.scrollTop).toBe(2000);

    // The user reads back through session a: the pin releases and new rows no longer move the view.
    scroller.scrollTop = 300;
    const box = tree.root.find((n) => typeof n.type === 'string' && typeof n.props.onScroll === 'function');
    act(() => box.props.onScroll());
    act(() => tree.update(view('a', rowsOf('a2'))));
    expect(scroller.scrollTop).toBe(300);

    // Switching to session b lands on its latest message, and it stays pinned as b grows.
    act(() => tree.update(view('b', rowsOf('b1'))));
    expect(scroller.scrollTop).toBe(2000);
    scroller.scrollHeight = 2600;
    act(() => tree.update(view('b', rowsOf('b2'))));
    expect(scroller.scrollTop).toBe(2600);
    tree.unmount();
  });
});
