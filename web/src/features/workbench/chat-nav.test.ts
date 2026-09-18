import { describe, expect, it } from 'vitest';
import type { ChatRow } from './transcript-vm';
import { buildNavMarks, visibleNavRows } from './chat-nav';

const user = (text: string, extra: Partial<Extract<ChatRow, { kind: 'user' }>> = {}): ChatRow => ({
  kind: 'user', text, ...extra,
});
const assistant = (text: string): ChatRow => ({ kind: 'assistant', text, streaming: false });

describe('buildNavMarks', () => {
  it('marks user rows only, and keeps their row index', () => {
    const marks = buildNavMarks([
      { kind: 'divider', text: 'Today' },
      user('first'),
      assistant('reply'),
      user('second'),
    ]);
    expect(marks.map((m) => m.row)).toEqual([1, 3]);
    expect(marks.map((m) => m.title)).toEqual(['first', 'second']);
  });

  it('skips system-authored turns — the rail indexes prompts, not callbacks', () => {
    const marks = buildNavMarks([
      user('first'),
      user('[Task done] #ab12 is complete.', { systemOrigin: 'task-callback' }),
      user('second'),
    ]);
    expect(marks.map((m) => m.title)).toEqual(['first', 'second']);
    expect(marks.map((m) => m.row)).toEqual([0, 2]);
  });

  it('splits the first line off as the title and keeps three body lines', () => {
    const mark = buildNavMarks([user('title\n\nbody one\nbody two\nbody three\nbody four')])[0];
    expect(mark.title).toBe('title');
    expect(mark.body).toEqual(['body one', 'body two', 'body three']);
    expect(mark.truncated).toBe(true);
  });

  it('is not truncated when the whole message fits', () => {
    const mark = buildNavMarks([user('one\ntwo')])[0];
    expect(mark.body).toEqual(['two']);
    expect(mark.truncated).toBe(false);
  });

  it('clips an over-long line and reports it as truncated', () => {
    const mark = buildNavMarks([user('x'.repeat(200))])[0];
    expect(mark.title.endsWith('…')).toBe(true);
    expect(mark.title.length).toBeLessThan(100);
    expect(mark.truncated).toBe(true);
  });

  it('titles an attachment-only message on its first file', () => {
    const mark = buildNavMarks([user('', {
      attachments: [
        { name: 'HAP_revised.pdf', path: '/w/HAP_revised.pdf', size: 10, mimeType: 'application/pdf', type: 'file' },
        { name: 'plot.png', path: '/w/plot.png', size: 20, mimeType: 'image/png', type: 'image' },
      ],
    })])[0];
    expect(mark.title).toBe('HAP_revised.pdf');
    expect(mark.attachments).toEqual([
      { name: 'HAP_revised.pdf', type: 'file' },
      { name: 'plot.png', type: 'image' },
    ]);
  });

  it('carries the pending flag through', () => {
    expect(buildNavMarks([user('sent', { pending: true })])[0].pending).toBe(true);
    expect(buildNavMarks([user('sent')])[0].pending).toBe(false);
  });
});

describe('visibleNavRows', () => {
  // Turn 1 runs off the top of the view, turn 4 fills it, turn 9 starts below the fold.
  const tops = [{ row: 1, top: -400 }, { row: 4, top: 40 }, { row: 9, top: 600 }];

  it('lights every turn the viewport overlaps, head or tail', () => {
    expect(visibleNavRows(tops, 500)).toEqual([1, 4]);
  });

  it('lights a turn whose prompt has scrolled off but whose reply is still on screen', () => {
    expect(visibleNavRows([{ row: 1, top: -900 }, { row: 4, top: 800 }], 500)).toEqual([1]);
  });

  it('lights the last turn however far its reply runs', () => {
    expect(visibleNavRows(tops, 700)).toEqual([1, 4, 9]);
  });

  it('drops a turn that ends above the view', () => {
    expect(visibleNavRows([{ row: 1, top: -300 }, { row: 4, top: -10 }], 500)).toEqual([4]);
  });

  it('lights nothing for an empty transcript', () => {
    expect(visibleNavRows([], 500)).toEqual([]);
  });
});
