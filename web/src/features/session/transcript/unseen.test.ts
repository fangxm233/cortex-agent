import { describe, expect, it } from 'vitest';
import type { ChatRow } from './chat-row';
import { advanceVisit, newVisit, readBoundary, unseenTarget, type ReadMark, type Visit } from './unseen';

const user = (text: string, ts?: string): ChatRow => ({ kind: 'user', text, ts });
const say = (text: string, ts?: string): ChatRow => ({ kind: 'assistant', text, streaming: false, ts });
const tools = (): ChatRow => ({ kind: 'tools', count: 1, calls: [{ kind: 'Bash', input: 'ls' }] });

const READ = '2026-05-01T10:00:00Z';
const before = '2026-05-01T09:00:00Z';
const after = '2026-05-01T11:00:00Z';
const direct = (lastReadAt?: string | null): ReadMark => ({ lastReadAt, origin: 'direct' });

function visit(rows: ChatRow[], mark: ReadMark | undefined): Visit {
  const v = newVisit('s1');
  advanceVisit(v, { rows, fetched: true, mark, away: false });
  return v;
}

const target = (v: Visit, rows: ChatRow[], live = false, workOpen = false) => unseenTarget(v, rows, { live, workOpen });

describe('readBoundary', () => {
  it('is unknown for a server that does not send the mark', () => {
    expect(readBoundary(direct(undefined))).toBeNull();
  });

  it('treats a never-opened scheduled run as entirely unseen, a never-tracked session as read', () => {
    expect(readBoundary({ lastReadAt: null, origin: 'scheduled' })).toBe(-Infinity);
    expect(readBoundary(direct(null))).toBeNull();
  });

  it('is the read time otherwise', () => {
    expect(readBoundary(direct(READ))).toBe(Date.parse(READ));
  });
});

describe('advanceVisit + unseenTarget', () => {
  it('targets the earliest reply written after the last read, counting every unseen reply', () => {
    const rows = [user('a', before), say('old', before), user('b', after), say('new one', after), user('c', after), say('new two', after)];
    expect(target(visit(rows, direct(READ)), rows)).toEqual({ row: 3, count: 2 });
  });

  it('has nothing to point at when everything was read, or the mark is unknown', () => {
    const rows = [user('a', before), say('old', before)];
    expect(target(visit(rows, direct(READ)), rows)).toBeNull();
    const fresh = [user('a', after), say('new', after)];
    expect(target(visit(fresh, direct(undefined)), fresh)).toBeNull();
  });

  it('skips the rows already seen', () => {
    const rows = [user('a', after), say('one', after), user('b', after), say('two', after)];
    const v = visit(rows, direct(READ));
    v.seen.add(1);
    expect(target(v, rows)).toEqual({ row: 3, count: 1 });
  });

  it('skips working notes folded into a settled work log, unless logs are kept open', () => {
    const rows = [user('a', before), say('note', after), tools(), say('answer', after)];
    const v = visit(rows, direct(READ));
    expect(target(v, rows)).toEqual({ row: 3, count: 1 });
    expect(target(v, rows, false, true)).toEqual({ row: 1, count: 2 });
  });

  it('reaches the notes of the running turn, whose work log is open', () => {
    const rows = [user('a', before), say('note', after), tools()];
    expect(target(visit(rows, direct(READ)), rows, true)).toEqual({ row: 1, count: 1 });
  });

  it('waits for both the loaded transcript and the mark, and judges only the rows loaded', () => {
    const v = newVisit('s1');
    const loaded = [user('a', before), say('new', after)];
    advanceVisit(v, { rows: loaded, fetched: true, mark: undefined, away: false });
    // A reply streamed in while the reader watched, before the session list answered.
    const grown = [...loaded, user('b', after), say('watched', after)];
    advanceVisit(v, { rows: grown, fetched: true, mark: direct(READ), away: false });
    expect(target(v, grown)).toEqual({ row: 1, count: 1 });
  });

  it('counts a reply as unseen only when it lands while the reader is away', () => {
    const v = visit([user('a', before)], direct(READ));
    const watched = [user('a', before), say('watched')];
    advanceVisit(v, { rows: watched, fetched: true, mark: direct(READ), away: false });
    expect(target(v, watched)).toBeNull();
    const missed = [...watched, user('b'), say('missed')];
    advanceVisit(v, { rows: missed, fetched: true, mark: direct(READ), away: true });
    expect(target(v, missed)).toEqual({ row: 3, count: 1 });
  });

  it('records nothing until the transcript has been fetched', () => {
    const v = newVisit('s1');
    advanceVisit(v, { rows: [say('live first')], fetched: false, mark: direct(READ), away: true });
    const rows = [user('a', before), say('live first')];
    advanceVisit(v, { rows, fetched: true, mark: direct(READ), away: true });
    expect(target(v, rows)).toBeNull();
  });
});
