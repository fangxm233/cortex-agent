import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LangProvider } from '@/i18n';
import { MessageStream } from './MessageStream';
import { ChatNavRail } from './ChatNavRail';
import { EditBox } from './MessageEdit';
import type { ChatRow } from './transcript-vm';
import { WINDOW_TAIL_ROWS, windowStart } from './useTranscriptWindow';

const ROW_H = 50;

function userRows(n: number): ChatRow[] {
  return Array.from({ length: n }, (_, i) => ({ kind: 'user', text: `u${i}`, turnIndex: i }));
}

function mountedAnchors(tree: ReactTestRenderer | undefined): number[] {
  if (!tree) return [];
  return tree.root
    .findAll((n) => typeof n.type === 'string' && n.props['data-chat-anchor'] !== undefined)
    .map((n) => n.props['data-chat-anchor'] as number);
}

// A scroll box whose content height is the mounted rows' — enough geometry for the window to keep
// the reader's place when rows mount above them.
function harness(clientHeight = 500) {
  let tree: ReactTestRenderer | undefined;
  const scroller = {
    scrollTop: 0,
    clientHeight,
    get scrollHeight() { return mountedAnchors(tree).length * ROW_H; },
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [],
    querySelector: () => ({ getBoundingClientRect: () => ({ top: 120 }) }),
    scrollTo: vi.fn(),
    style: { setProperty: () => {} },
  };
  const textarea = { value: '', scrollHeight: 40, style: {}, focus: () => {}, setSelectionRange: () => {} };
  const onSubmit = vi.fn();
  const edit = { running: false, busy: false, onSubmit };
  const view = (key: string, rows: ChatRow[], loading = false) => (
    <LangProvider>
      <MessageStream rows={rows} loading={loading} streamKey={key} edit={edit} />
    </LangProvider>
  );
  const render = (key: string, rows: ChatRow[], loading = false) => {
    act(() => {
      if (tree) tree.update(view(key, rows, loading));
      else tree = create(view(key, rows, loading), { createNodeMock: (el) => (el.props.onScroll ? scroller : el.type === 'textarea' ? textarea : {}) });
    });
  };
  const scrollTo = (top: number) => {
    scroller.scrollTop = top;
    const box = tree!.root.find((n) => typeof n.type === 'string' && typeof n.props.onScroll === 'function');
    act(() => box.props.onScroll());
  };
  const anchors = () => mountedAnchors(tree);
  const range = () => { const a = anchors(); return [a[0], a[a.length - 1], a.length]; };
  return { scroller, render, scrollTo, anchors, range, onSubmit, tree: () => tree! };
}

describe('windowStart', () => {
  it('starts at the tail, and a pinned start never passes it', () => {
    expect(windowStart(10, null)).toBe(0);
    expect(windowStart(100, null)).toBe(100 - WINDOW_TAIL_ROWS);
    expect(windowStart(100, 12)).toBe(12);
    expect(windowStart(50, 30)).toBe(50 - WINDOW_TAIL_ROWS);
  });
});

describe('MessageStream transcript window', () => {
  it('mounts only the tail of a long transcript', () => {
    const h = harness();
    h.render('a', userRows(100));
    expect(h.range()).toEqual([60, 99, 40]);
  });

  it('mounts the previous chunk as the reader nears the top, keeping their place', () => {
    const h = harness();
    h.render('a', userRows(100));
    h.scrollTo(100);
    expect(h.range()).toEqual([20, 99, 80]);
    expect(h.scroller.scrollTop).toBe(100 + 40 * ROW_H);
    h.scrollTo(1500);
    expect(h.range()).toEqual([20, 99, 80]);
  });

  it('follows the tail while the history loads, then holds its start as rows append', () => {
    const h = harness();
    h.render('a', userRows(3), true);
    expect(h.range()).toEqual([0, 2, 3]);
    h.render('a', userRows(100));
    expect(h.range()).toEqual([60, 99, 40]);
    h.render('a', userRows(105));
    expect(h.range()).toEqual([60, 104, 45]);
  });

  it('keeps a full tail mounted when a rewind shrinks the transcript', () => {
    const h = harness();
    h.render('a', userRows(100));
    h.render('a', userRows(50));
    expect(h.range()).toEqual([10, 49, 40]);
  });

  it('mounts an unmounted prompt before the nav rail scrolls to it', () => {
    const h = harness();
    h.render('a', userRows(100));
    act(() => h.tree().root.findByType(ChatNavRail).props.onJump(45));
    expect(h.range()).toEqual([5, 99, 95]);
    expect(h.scroller.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('keeps growing while the mounted rows do not fill the box', () => {
    const h = harness(4500);
    h.render('a', userRows(100));
    expect(h.range()).toEqual([0, 99, 100]);
  });

  it('opens another session at its own tail', () => {
    const h = harness();
    h.render('a', userRows(100));
    h.scrollTo(0);
    expect(h.anchors()).toHaveLength(80);
    h.render('b', userRows(200));
    expect(h.range()).toEqual([160, 199, 40]);
  });

  it('edits a mounted prompt without mounting the rows above the window', () => {
    const h = harness();
    h.render('a', userRows(100));
    const row = h.tree().root.find((n) => typeof n.props.onStartEdit === 'function' && n.props.row?.text === 'u80');
    act(() => row.props.onStartEdit());
    const box = h.tree().root.findByType(EditBox);
    expect(box.props.initialText).toBe('u80');
    expect(h.anchors()).toEqual([...Array.from({ length: 20 }, (_, i) => 60 + i), ...Array.from({ length: 19 }, (_, i) => 81 + i)]);
    act(() => box.props.onSubmit('revised'));
    expect(h.onSubmit).toHaveBeenCalledWith(80, 'revised');
    expect(h.tree().root.findAllByType(EditBox)).toHaveLength(0);
  });
});
