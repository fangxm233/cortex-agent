import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { en, LangProvider, zh } from '@/i18n';
import { MessageStream } from './MessageStream';
import type { ChatRow } from './transcript-vm';
import type { ReadMark } from './unseen';

const READ = '2026-05-01T10:00:00Z';
const before = '2026-05-01T09:00:00Z';
const after = '2026-05-01T11:00:00Z';
const mark: ReadMark = { lastReadAt: READ, origin: 'direct' };

const user = (text: string, ts?: string): ChatRow => ({ kind: 'user', text, ts });
const say = (text: string, ts?: string): ChatRow => ({ kind: 'assistant', text, streaming: false, ts });

// A 500px scroll box over replies placed at fixed content offsets (`at`), 200px tall each.
function harness(at: Record<number, number>) {
  let tree: ReactTestRenderer | undefined;
  const node = (row: number) => ({
    dataset: { chatRow: String(row) },
    getBoundingClientRect: () => {
      const top = at[row] - scroller.scrollTop;
      return { top, bottom: top + 200, height: 200 };
    },
  });
  const scroller = {
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    querySelectorAll: (sel: string) => (sel === '[data-chat-row]' ? Object.keys(at).map((r) => node(Number(r))) : []),
    querySelector: (sel: string) => node(Number(/"(\d+)"/.exec(sel)?.[1])),
    style: { setProperty: () => {} },
  };
  const view = (rows: ChatRow[]) => (
    <LangProvider>
      <MessageStream rows={rows} loading={false} fetched readMark={mark} streamKey="s1" />
    </LangProvider>
  );
  const render = (rows: ChatRow[]) => act(() => {
    if (tree) tree.update(view(rows));
    else tree = create(view(rows), { createNodeMock: (el) => (el.props.onScroll ? scroller : {}) });
  });
  const scrollTo = (top: number) => {
    scroller.scrollTop = top;
    const box = tree!.root.find((n) => typeof n.type === 'string' && typeof n.props.onScroll === 'function');
    act(() => box.props.onScroll());
  };
  const pill = () => tree!.root.findAll((n) => n.type === 'button' && n.props['data-unseen-jump'] !== undefined)[0];
  return { scroller, render, scrollTo, pill };
}

describe('MessageStream jump to the earliest unseen reply', () => {
  beforeEach(() => { vi.stubGlobal('getComputedStyle', () => ({ paddingTop: '22px' })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('points up at the first reply written since the last read, and jumps to it', () => {
    // Opened at the bottom (scrollTop 2000): row 5 is on screen, row 3 is above it.
    const h = harness({ 1: 1000, 3: 1700, 5: 2200 });
    h.render([user('a', before), say('old', before), user('b', after), say('first new', after), user('c', after), say('second new', after)]);
    expect(h.scroller.scrollTop).toBe(2000);
    expect(h.pill().props['data-unseen-jump']).toBe('up');
    // Row 5 was on screen, so only row 3 is still unseen.
    expect([en.chatUnseenOne, zh.chatUnseenOne]).toContain(h.pill().children.find((c) => typeof c === 'string'));

    act(() => h.pill().props.onClick());
    // Row 3's top lands at the content's top padding.
    expect(h.scroller.scrollTop).toBe(1700 - 22);
    h.scrollTo(h.scroller.scrollTop);
    expect(h.pill()).toBeUndefined();
  });

  it('points down at a reply that lands while the reader is scrolled up', () => {
    const h = harness({ 1: 1000, 3: 2300 });
    h.render([user('a', before), say('old', before)]);
    expect(h.pill()).toBeUndefined();
    h.scrollTo(300);
    h.render([user('a', before), say('old', before), user('b'), say('missed')]);
    expect(h.pill().props['data-unseen-jump']).toBe('down');
  });

  it('offers nothing for a reply that streams in while the reader is at the bottom', () => {
    const h = harness({ 1: 1000, 3: 2300 });
    h.render([user('a', before), say('old', before)]);
    h.render([user('a', before), say('old', before), user('b'), say('watched')]);
    expect(h.pill()).toBeUndefined();
  });
});
