import type { ChatRow } from './chat-row';
import { systemOriginDisplay } from './system-origin';

// How the chat rows of a transcript are laid out on screen: each turn as its work, its answer and
// what it produced, instead of every tool run and working note at the weight of the answer.
//
// The rows are cut into SEGMENTS, one per time the agent was set going. A segment opens at a human
// message, at a lead's message to its worker, and at a system-authored turn that woke the agent up
// (a waitpoint's signal, a worker's report or question, a background agent's result that arrived
// after the agent had finished). It does NOT open at a resume after a rate limit (the same work,
// continued) or at a background agent's result that was folded into a turn still running — the
// row before such a result is a tool call, because the agent was in the middle of acting.
//
// Inside a segment every row is one of:
// - the ANSWER: the last thing the agent said. While the segment is still being written this is
//   only the trailing text, so the reply the reader is watching stream never moves; once a tool call
//   follows it, it was a working note after all.
// - PINNED: what the reader must see or act on, left in place: plan and question cards, notices,
//   files and decisions the agent sent, a board it opened, a worker it started, a waitpoint it armed,
//   a background agent still running after the turn ended, a long working note (a heading, a table,
//   or a few paragraphs: the agent wrote it for the reader), and messages not read yet.
// - PROCESS: tool runs, thoughts, short working notes, subagents, the lead's routine worker actions
//   and the system hints folded into the work. A segment's process rows become one WORK item, a
//   single summary line where the work began, that opens to the rows themselves in order. Pinned
//   rows stay where they were without splitting it — a worker started or a file sent mid-turn is an
//   outcome, not a break in the work — and so does the answer: a tool call or two after the final
//   text is part of the work, not a second log. Only a plan or question card splits the work,
//   because the reader acted there: what the agent did before it and after it are two pieces.
//
// While the segment is still being written, the work keeps everything in the order it happened:
// once it has begun, a pinned row that lands in it — a decision, a file, a long note — joins the open
// log where it arrived, and only the reply being written sits below. Pinned rows that stayed below
// the log made every working note written after one appear under it and then jump above it into
// the log at the next tool call. When the segment settles the log folds and those rows step out
// below it, as above. A plan or question card still splits the work, and messages the agent has not
// read yet stay at the tail.
//
// A work item of a single row stays that row — a lone tool run already is one line — and one of
// nothing but thoughts stays as its thought lines.

export type TurnRowRole = 'opener' | 'answer' | 'pinned' | 'plain';

export interface WorkStats {
  /** Tool calls in the work, the lead's worker actions included. */
  toolCalls: number;
  subagents: number;
  /** The span the work covers, from the row before it to the last row it reaches; null when the rows
   *  carry no timestamps. */
  startTs: string | null;
  endTs: string | null;
}

export type TurnItem =
  | { kind: 'row'; index: number; role: TurnRowRole; segment: number }
  | { kind: 'work'; key: string; indexes: number[]; live: boolean; segment: number; stats: WorkStats };

export interface TurnLayoutOpts {
  /** The foreground turn is running, so the last segment is still being written. A session held
   *  open only by background work is not live: its turn has ended and said what it had to say. */
  live?: boolean;
}

/** A working note this long was written for the reader, not as a progress line. */
export const LONG_FORM_CHARS = 400;

const HEADING = /^#{1,6}\s/m;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m;

export function isLongForm(text: string): boolean {
  const t = text.trim();
  return t.length >= LONG_FORM_CHARS || HEADING.test(t) || TABLE_RULE.test(t);
}

function hasText(row: ChatRow): boolean {
  return row.kind === 'assistant' && row.text.trim().length > 0;
}

/** Rows the builder keeps that render nothing. */
function isInvisible(row: ChatRow): boolean {
  return row.kind === 'assistant' && !row.preview && !row.text.trim() && !row.attachments?.length && !row.decisions?.length;
}

function isHumanTurn(row: ChatRow): boolean {
  return row.kind === 'user' && !row.pending && (!row.systemOrigin || systemOriginDisplay(row.systemOrigin) === 'bubble');
}

/** A row that means the agent was mid-action: a system turn landing right after it was folded in. */
function isAction(row: ChatRow): boolean {
  return row.kind === 'tools' || row.kind === 'subagent' || row.kind === 'team-action'
    || row.kind === 'board-action' || row.kind === 'waitpoint';
}

/** Whether a system-authored hint row starts a segment, given the rows of the segment before it. */
function hintOpens(row: Extract<ChatRow, { kind: 'user' }>, body: ChatRow[]): boolean {
  if (row.systemOrigin === 'resume') return false;
  if (row.systemOrigin !== 'agent-result') return true;
  for (let i = body.length - 1; i >= 0; i--) {
    const prev = body[i];
    if (prev.kind === 'thinking' || isInvisible(prev)) continue;
    return !isAction(prev);
  }
  return true;
}

function opens(row: ChatRow, body: ChatRow[]): boolean {
  if (row.kind === 'divider' || isHumanTurn(row)) return true;
  if (row.kind === 'user' && row.systemOrigin && !row.pending) return hintOpens(row, body);
  // A worker's report or request woke the lead; routine updates arrive while it works.
  if (row.kind === 'team-updates') return !row.pending && row.updates.some((u) => u.kind !== 'progress');
  return false;
}

type Role = 'process' | 'pinned' | 'plain';

function classify(row: ChatRow, live: boolean): Role {
  switch (row.kind) {
    case 'tools':
    case 'thinking':
      return 'process';
    case 'subagent':
      // Still running after its turn ended: background work the reader is waiting on.
      return !live && row.status === 'running' ? 'pinned' : 'process';
    case 'team-action':
      return row.action.op === 'spawn' ? 'pinned' : 'process';
    case 'user':
      return row.pending ? 'pinned' : 'process';
    case 'assistant':
      if (isInvisible(row)) return 'plain';
      if (row.attachments?.length || row.decisions?.length) return 'pinned';
      return !row.preview && isLongForm(row.text) ? 'pinned' : 'process';
    default:
      return 'pinned';
  }
}

/** Text and nothing else: pinned, if at all, only for its length. */
function isNote(row: ChatRow): boolean {
  return row.kind === 'assistant' && !row.attachments?.length && !row.decisions?.length;
}

/** The row the segment's answer is, or null. */
function answerOf(rows: ChatRow[], body: number[], roles: Map<number, Role>, live: boolean): number | null {
  for (let k = body.length - 1; k >= 0; k--) {
    const i = body[k];
    const row = rows[i];
    // While it is still trailing, a long note is the reply so far too; it is pinned only once work
    // follows it.
    if (hasText(row)) return roles.get(i) === 'process' || (live && isNote(row)) ? i : null;
    // Still being written: only a trailing text is the answer so far. Cards and messages after it do
    // not end it; anything the agent did after it does.
    if (live && roles.get(i) === 'process') return null;
  }
  return null;
}

function rowTs(row: ChatRow): string | null {
  switch (row.kind) {
    case 'user':
    case 'assistant':
      return row.ts ?? null;
    case 'interaction':
      return row.ts ?? null;
    case 'team-action':
    case 'board-action':
      return row.action.ts;
    case 'team-updates':
      return row.updates.at(-1)?.ts ?? null;
    case 'waitpoint':
      return row.wait.ts;
    default:
      return null;
  }
}

function workStats(rows: ChatRow[], indexes: number[], from: number, to: number): WorkStats {
  let toolCalls = 0;
  let subagents = 0;
  for (const i of indexes) {
    const row = rows[i];
    if (row.kind === 'tools') toolCalls += row.count;
    else if (row.kind === 'team-action') toolCalls += 1;
    else if (row.kind === 'subagent') subagents += 1;
  }
  // From the nearest stamp at or before the work (its opener, usually) to the latest stamp it reaches,
  // the row right after it included — the answer that ended it, usually.
  let startTs: string | null = null;
  for (let i = indexes[0]; i >= from && !startTs; i--) startTs = rowTs(rows[i]);
  let endTs: string | null = null;
  const last = Math.min(indexes[indexes.length - 1] + 1, to - 1);
  for (let i = indexes[0]; i <= last; i++) {
    const ts = rowTs(rows[i]);
    if (ts && (!endTs || Date.parse(ts) > Date.parse(endTs))) endTs = ts;
  }
  return { toolCalls, subagents, startTs, endTs };
}

type RunSlot = { kind: 'run'; indexes: number[] };
type Slot = { kind: 'row'; index: number; role: TurnRowRole } | RunSlot;

/** A pinned row that joins a live segment's work once the work has begun (see the header). */
function joinsLiveWork(row: ChatRow, role: Role): boolean {
  if (role !== 'pinned' || row.kind === 'interaction') return false;
  return !('pending' in row && row.pending);
}

function buildSlots(rows: ChatRow[], body: number[], roles: Map<number, Role>, answer: number | null, live: boolean): Slot[] {
  const slots: Slot[] = [];
  let run: RunSlot | null = null;
  // Only the work still being written takes pinned rows in: work before a plan or question card is
  // already folded, and a decision in it would fold away with it.
  const openFrom = live ? Math.max(-1, ...body.filter((i) => rows[i].kind === 'interaction')) : Infinity;
  for (const i of body) {
    const role = roles.get(i)!;
    const takesIn = run !== null && i > openFrom && joinsLiveWork(rows[i], role);
    const joins = i !== answer && (role === 'process' || takesIn);
    if (!joins) {
      if (rows[i].kind === 'interaction') run = null;
      slots.push({ kind: 'row', index: i, role: i === answer || role === 'process' ? 'answer' : role });
      continue;
    }
    if (!run) {
      run = { kind: 'run', indexes: [] };
      slots.push(run);
    }
    run.indexes.push(i);
  }
  return slots;
}

/** Work after a settled segment's answer joins the work before it. */
function joinWorkAfterAnswer(slots: Slot[], answer: number): void {
  const at = slots.findIndex((s) => s.kind === 'row' && s.index === answer);
  const before = slots.slice(0, at).reverse().find((s): s is RunSlot => s.kind === 'run');
  if (!before) return;
  for (let k = slots.length - 1; k > at; k--) {
    const s = slots[k];
    if (s.kind !== 'run') continue;
    before.indexes.push(...s.indexes);
    slots.splice(k, 1);
  }
  before.indexes.sort((a, b) => a - b);
}

function layoutSegment(rows: ChatRow[], from: number, to: number, segment: number, live: boolean, out: TurnItem[]): void {
  let start = from;
  if (opens(rows[from], [])) {
    out.push({ kind: 'row', index: from, role: rows[from].kind === 'divider' ? 'plain' : 'opener', segment });
    start = from + 1;
  }
  const body: number[] = [];
  for (let i = start; i < to; i++) body.push(i);
  const roles = new Map<number, Role>(body.map((i) => [i, classify(rows[i], live)]));
  const answer = answerOf(rows, body, roles, live);
  const slots = buildSlots(rows, body, roles, answer, live);
  if (answer !== null && !live) joinWorkAfterAnswer(slots, answer);
  emitSlots(rows, slots, { from, to, segment, live }, out);
}

function emitSlots(rows: ChatRow[], slots: Slot[], seg: { from: number; to: number; segment: number; live: boolean }, out: TurnItem[]): void {
  const { from, to, segment, live } = seg;
  const lastRun = slots.reduce<Slot | null>((acc, s) => (s.kind === 'run' ? s : acc), null);
  for (const s of slots) {
    if (s.kind === 'row') {
      out.push({ ...s, segment });
      continue;
    }
    const thoughtsOnly = s.indexes.every((i) => rows[i].kind === 'thinking' || isInvisible(rows[i]));
    const substantive = s.indexes.filter((i) => !isInvisible(rows[i]));
    // A settled lone tool run reads better as its own line than as a one-row fold. The live tail is
    // different: it is where the "working" line lives, and the reader needs it from the first run.
    const liveTail = live && s === lastRun;
    if (thoughtsOnly || substantive.length < (liveTail ? 1 : 2)) {
      for (const i of s.indexes) out.push({ kind: 'row', index: i, role: 'plain', segment });
      continue;
    }
    out.push({
      kind: 'work', key: `work-${s.indexes[0]}`, indexes: s.indexes, live: liveTail, segment,
      stats: workStats(rows, s.indexes, from, to),
    });
  }
}

/** Lay the rows out as turns. Every row index appears exactly once, in a row item or a work item. */
export function layoutTurns(rows: ChatRow[], opts: TurnLayoutOpts = {}): TurnItem[] {
  const out: TurnItem[] = [];
  const starts: number[] = [];
  const body: ChatRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (i === 0 || opens(rows[i], body)) {
      starts.push(i);
      body.length = 0;
      if (rows[i].kind !== 'divider') continue;
    }
    body.push(rows[i]);
  }
  starts.forEach((from, segment) => {
    const to = starts[segment + 1] ?? rows.length;
    // A day divider starts a segment too: work it falls in the middle of continues below it.
    const live = !!opts.live && segment === starts.length - 1;
    layoutSegment(rows, from, to, segment, live, out);
  });
  return out;
}

/** Every row of a flat list as a plain item — the nested (subagent) transcripts, which are one
 *  agent's single run and are already folded away inside their block. */
export function flatItems(rows: ChatRow[]): TurnItem[] {
  return rows.map((_, index) => ({ kind: 'row', index, role: 'plain', segment: 0 }));
}

/** The item that hosts each turn's copy action: the last item of the segment holding the copy
 *  target, so the button stays under what the reader sees when the target is folded into work. */
export function copyHosts(items: TurnItem[], targets: Map<number, string>, rows: ChatRow[]): Map<number, string> {
  const out = new Map<number, string>();
  if (targets.size === 0) return out;
  const segmentOf = new Map<number, number>();
  const lastOfSegment = new Map<number, number>();
  items.forEach((item, k) => {
    if (item.kind === 'row') segmentOf.set(item.index, item.segment);
    else for (const i of item.indexes) segmentOf.set(i, item.segment);
    // A message the agent has not read yet trails the stream; the reply's button stays above it.
    const row = item.kind === 'row' ? rows[item.index] : null;
    if (row?.kind === 'user' && row.pending) return;
    lastOfSegment.set(item.segment, k);
  });
  for (const [index, text] of targets) {
    const segment = segmentOf.get(index);
    const host = segment === undefined ? undefined : lastOfSegment.get(segment);
    if (host !== undefined) out.set(host, text);
  }
  return out;
}

/** The row indexes an item covers. */
export function itemIndexes(item: TurnItem): number[] {
  return item.kind === 'row' ? [item.index] : item.indexes;
}
