import type { ChatRow } from './chat-row';
import { layoutTurns, type TurnItem } from './turn-layout';

// Which replies in an open chat the reader has not seen yet, so the stream can offer to jump to
// the earliest one. Two sources feed one set of candidate rows:
// - the replies that landed while the reader was away from the session: the rows the transcript
//   opened with that were written after the reader's last view (the session list's lastReadAt);
// - the replies that land during this visit while the reader is scrolled up or on another tab.
// A candidate stops counting once it has been on screen. What streamed in while the reader sat at
// the bottom of the chat was watched, so it never becomes a candidate.

/** What the session list knows about the reader's last view. */
export interface ReadMark {
  /** Undefined: a server too old to send it. Null: never viewed. */
  lastReadAt?: string | null;
  origin: string;
}

/** One visit to one session; reset when the stream switches session. */
export interface Visit {
  key?: string;
  /** Rows written after this moment were not seen: -Infinity for all of them, null for none. */
  boundary: number | null | 'pending';
  /** Rows present once this visit first fetched the transcript; null until then. A reopened session
   *  shows its cached transcript first, and what landed while the reader was away comes with that
   *  fetch — so it belongs to the opening rows, not to what streamed in while they watched. */
  loaded: number | null;
  /** The opening rows have been judged against the boundary. */
  judged: boolean;
  /** Rows already accounted for; anything past it is an arrival. */
  high: number;
  candidates: Set<number>;
  seen: Set<number>;
}

export interface VisitInput {
  rows: ChatRow[];
  /** The transcript has been fetched from the server since this visit began. */
  fetched: boolean;
  /** Undefined until the session list has answered. */
  mark?: ReadMark;
  /** Scrolled up from the bottom, or the page is hidden. */
  away: boolean;
}

export interface UnseenTarget {
  row: number;
  /** Unseen replies from the target on. */
  count: number;
}

export function readBoundary(mark: ReadMark): number | null {
  if (mark.lastReadAt === undefined) return null;
  // A scheduled run nobody has opened is the unread state itself; an untracked session is read.
  if (mark.lastReadAt === null) return mark.origin === 'scheduled' ? -Infinity : null;
  const at = Date.parse(mark.lastReadAt);
  return Number.isNaN(at) ? null : at;
}

export function newVisit(key?: string): Visit {
  return { key, boundary: 'pending', loaded: null, judged: false, high: 0, candidates: new Set(), seen: new Set() };
}

function writtenAfter(row: ChatRow, boundary: number): boolean {
  if (row.kind !== 'assistant') return false;
  return boundary === -Infinity || (!!row.ts && Date.parse(row.ts) > boundary);
}

function judgeOpening(v: Visit, rows: ChatRow[]): void {
  if (v.judged || v.loaded === null || v.boundary === 'pending') return;
  v.judged = true;
  const boundary = v.boundary;
  if (boundary === null) return;
  rows.slice(0, v.loaded).forEach((row, i) => {
    if (writtenAfter(row, boundary)) v.candidates.add(i);
  });
}

function recordArrivals(v: Visit, rows: ChatRow[], away: boolean): void {
  for (let i = v.high; i < rows.length; i++) {
    if (away && rows[i].kind === 'assistant') v.candidates.add(i);
  }
  v.high = Math.max(v.high, rows.length);
}

/** Folds one render's inputs into the visit. Idempotent for the same input, so it may run in render. */
export function advanceVisit(v: Visit, input: VisitInput): void {
  if (v.boundary === 'pending' && input.mark) v.boundary = readBoundary(input.mark);
  if (v.loaded === null && input.fetched) {
    v.loaded = input.rows.length;
    v.high = input.rows.length;
  }
  judgeOpening(v, input.rows);
  if (v.loaded !== null) recordArrivals(v, input.rows, input.away);
}

/** The rows an item puts on screen: its own row, or the rows of a work log that is open. */
function shownIndexes(item: TurnItem, workOpen: boolean): number[] {
  if (item.kind === 'work') return item.live || workOpen ? item.indexes : [];
  return item.role === 'plain' ? [] : [item.index];
}

function shownAssistantRows(item: TurnItem, rows: ChatRow[], workOpen: boolean): number[] {
  return shownIndexes(item, workOpen).filter((i) => rows[i].kind === 'assistant');
}

function pendingRows(v: Visit, total: number): number[] {
  return [...v.candidates].filter((i) => i < total && !v.seen.has(i));
}

/** The earliest unseen reply the reader can land on. `workOpen`: settled work logs are kept open. */
export function unseenTarget(v: Visit, rows: ChatRow[], opts: { live: boolean; workOpen: boolean }): UnseenTarget | null {
  const pending = pendingRows(v, rows.length);
  if (pending.length === 0) return null;
  const shown = new Set(layoutTurns(rows, { live: opts.live }).flatMap((item) => shownAssistantRows(item, rows, opts.workOpen)));
  const reachable = pending.filter((i) => shown.has(i)).sort((a, b) => a - b);
  return reachable.length ? { row: reachable[0], count: reachable.length } : null;
}
