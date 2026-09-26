import stringWidth from 'string-width';
import type { TuiFrame } from '../platform/tui/protocol.js';

// ── Display-width helpers (CJK / full-width aware) ──
// Terminal columns are display CELLS, but JS strings are code units: a CJK char is 1 char / 2
// cells. Every layout step (wrap, pad, mouse-selection mapping) must measure in display columns,
// or Chinese/full-width text drifts (wrong wrap point, phantom grey row, mis-aligned selection).

/** Display width (terminal columns) of a string — CJK/full-width chars count as 2. */
export function displayWidth(s: string): number {
  return stringWidth(s);
}

/** Pad a string with spaces up to `width` DISPLAY columns (no-op if already ≥ width). */
export function padToWidth(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/** Take the longest prefix of `s` fitting within `width` display columns; return [head, rest]. */
function sliceHeadToWidth(s: string, width: number): [string, string] {
  const chars = [...s]; // iterate by code point so surrogate pairs stay intact
  let col = 0;
  let i = 0;
  for (; i < chars.length; i++) {
    const cw = stringWidth(chars[i]);
    if (col + cw > width) break;
    col += cw;
  }
  return [chars.slice(0, i).join(''), chars.slice(i).join('')];
}

/** Split a line into before/selected/after by DISPLAY-column range [startCol, endCol). Each char
 *  is classified by its starting column (a wide char straddling a boundary goes with its start). */
export function splitByDisplayCols(
  text: string, startCol: number, endCol: number,
): { before: string; selected: string; after: string } {
  let col = 0;
  let before = '';
  let selected = '';
  let after = '';
  for (const ch of [...text]) {
    if (col < startCol) before += ch;
    else if (col < endCol) selected += ch;
    else after += ch;
    col += stringWidth(ch);
  }
  return { before, selected, after };
}

// ── Focus arbitration ──
// Only one zone owns the keyboard at a time. Modals pre-empt everything; an open
// dashboard side panel takes focus from the input box (resolves the key conflict
// where dashboard hotkeys would leak into the message input).

export type FocusZone = 'modal' | 'dashboard' | 'input';

export function computeFocusZone(opts: { modalOpen: boolean; sidePanelVisible: boolean }): FocusZone {
  if (opts.modalOpen) return 'modal';
  if (opts.sidePanelVisible) return 'dashboard';
  return 'input';
}

// ── Agent-response detection ──
// The M4 protocol has no explicit turn-end frame. The arrival of any agent reply
// or stream frame is the signal that the agent has started responding — used to
// re-enable sending and clear the queued counter.

const AGENT_RESPONSE_TYPES: ReadonlySet<string> = new Set([
  'chat.post',
  'chat.update',
  'interactive.post',
  'stream.text',
  'stream.mutableOpen',
  'stream.mutableUpdate',
  'transcript.replay',
]);

export function isAgentResponseFrame(frame: TuiFrame): boolean {
  return AGENT_RESPONSE_TYPES.has((frame as { type: string }).type);
}

// ── Stream text collection ──
// Concatenate a message's stream segments + mutable regions into a single string
// so streamed output renders as flowing text rather than one-line-per-chunk.

/** One ordered unit in a stream: a discrete assistant text message, or an updatable region
 *  (tool-call trace). Each TUI stream frame is a whole message — NOT a token — so blocks render
 *  one per line, in arrival order. */
export interface StreamBlock {
  kind: 'text' | 'region';
  /** Set for 'region' blocks so stream.mutableUpdate can find and replace it in place. */
  regionId?: string;
  text: string;
}

export interface StreamLike {
  blocks: StreamBlock[];
}

/** Join a message's stream blocks into display text — one block per line, in order, so distinct
 *  assistant messages and interleaved tool traces appear as separate lines (not one merged blob). */
export function collectStreamText(streams: Map<string, StreamLike>): string {
  const parts: string[] = [];
  for (const [, stream] of streams) {
    for (const b of stream.blocks) parts.push(b.text);
  }
  return parts.join('\n');
}

// ── Visible window ──
// Bottom-anchored viewport over the transcript id list. scrollOffset counts
// messages scrolled up from the bottom (0 = pinned to bottom).

export function computeVisibleWindow(
  idsLength: number,
  visibleCount: number,
  scrollOffset: number,
): { start: number; end: number } {
  if (idsLength <= 0) return { start: 0, end: 0 };
  const maxOffset = Math.max(0, idsLength - 1);
  const effectiveOffset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const end = idsLength - effectiveOffset;
  const start = Math.max(0, end - Math.max(1, visibleCount));
  return { start, end };
}

// ── Line-aware transcript window ──
// The transcript holds variable-height messages (a replayed history can have long,
// multi-line entries). A message-count window overflows the terminal — Ink can't clear
// rows that scrolled off, so borders/text garble. Estimate each message's rendered line
// count and pick, from the bottom up, as many as fit the line budget.

/** Estimate how many terminal rows a block of text occupies at the given width. */
export function estimateLines(text: string, width: number): number {
  if (!text) return 0;
  const w = Math.max(1, width);
  let lines = 0;
  for (const line of text.split('\n')) {
    lines += Math.max(1, Math.ceil(line.length / w));
  }
  return lines;
}

/**
 * Bottom-anchored window over variable-height rows. `lineCounts[i]` is the estimated
 * height of row i. Returns absolute [start, end) including as many rows from the bottom
 * (offset by `scrollOffset` rows) as fit `budget` lines — always at least one row.
 */
export function computeLineWindow(
  lineCounts: number[],
  budget: number,
  scrollOffset = 0,
): { start: number; end: number } {
  const n = lineCounts.length;
  if (n === 0) return { start: 0, end: 0 };
  const maxOffset = Math.max(0, n - 1);
  const off = Math.min(Math.max(0, scrollOffset), maxOffset);
  const end = n - off;
  const cap = Math.max(1, budget);
  let used = 0;
  let start = end; // exclusive lower bound walked downward
  for (let i = end - 1; i >= 0; i--) {
    const h = Math.max(1, lineCounts[i]);
    if (used + h > cap && start < end) break; // would overflow, and we already have ≥1 row
    used += h;
    start = i;
  }
  return { start, end };
}

// ── Focus-centered window ──
// A bounded viewport over a navigable list that always keeps the focused row visible.
// Dashboard tabs render every item by default, so a long list (schedules / executions)
// overflows the terminal — and Ink cannot clear lines that scrolled past the top, leaving
// permanent ghost rows. Capping the rendered slice fixes both the overflow and the
// corruption. Returns absolute [start, end) indices plus how many rows are hidden on each
// side (for "↑ N more" / "↓ N more" affordances).

export function computeFocusWindow(
  total: number,
  focusedIndex: number,
  maxVisible: number,
): { start: number; end: number; hiddenAbove: number; hiddenBelow: number } {
  if (total <= 0) return { start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0 };
  const cap = Math.max(1, maxVisible);
  if (total <= cap) return { start: 0, end: total, hiddenAbove: 0, hiddenBelow: 0 };

  const focus = Math.min(Math.max(0, focusedIndex), total - 1);
  // Center the focused row in the window, then clamp to the list bounds.
  let start = focus - Math.floor(cap / 2);
  start = Math.max(0, Math.min(start, total - cap));
  const end = start + cap;
  return { start, end, hiddenAbove: start, hiddenBelow: total - end };
}

// ── Input history navigation ──
// Up/Down arrows in the input box cycle previously submitted messages (shell-style).
// `index` is the position inside the history array currently shown (null = the user's
// live draft, not navigating). `draft` preserves the in-progress text entered before
// navigation started, so stepping back past the newest entry restores it.

export interface InputHistoryState {
  /** Index into the history array currently displayed, or null when showing the live draft. */
  index: number | null;
  /** The in-progress text saved when navigation began (restored on exit). */
  draft: string;
}

/** Step to an OLDER history entry (Up arrow). Returns the value to show + the next state. */
export function historyPrev(
  history: string[],
  state: InputHistoryState,
  current: string,
): { value: string; state: InputHistoryState } {
  if (history.length === 0) return { value: current, state };
  if (state.index === null) {
    const index = history.length - 1;
    return { value: history[index], state: { index, draft: current } };
  }
  const index = Math.max(0, state.index - 1);
  return { value: history[index], state: { index, draft: state.draft } };
}

/** Step to a NEWER history entry (Down arrow). Past the newest entry, restores the draft. */
export function historyNext(
  history: string[],
  state: InputHistoryState,
  current: string,
): { value: string; state: InputHistoryState } {
  if (state.index === null) return { value: current, state };
  if (state.index >= history.length - 1) {
    return { value: state.draft, state: { index: null, draft: '' } };
  }
  const index = state.index + 1;
  return { value: history[index], state: { index, draft: state.draft } };
}

/** Append a submitted entry to history, collapsing consecutive duplicates. */
export function pushHistory(history: string[], entry: string): string[] {
  if (entry.trim().length === 0) return history;
  if (history[history.length - 1] === entry) return history;
  return [...history, entry];
}

// ── /resume target resolution ──
// `/resume <id>` lets the user jump straight to a session without the picker. The arg may be
// an internal sessionId, a short name (cortex-XXXX), the bare suffix (8cdfbe), or a unique
// sessionId prefix. Resolve it against the known session list to the internal sessionId.

export function matchResumeTarget(
  sessions: Array<{ sessionId: string; name?: string | null }>,
  target: string,
): string | null {
  const t = target.trim();
  if (!t) return null;
  const byId = sessions.find(s => s.sessionId === t);
  if (byId) return byId.sessionId;
  const byName = sessions.find(s => s.name === t);
  if (byName) return byName.sessionId;
  const bySuffix = sessions.find(s => s.name && (s.name.endsWith(t) || s.name.replace(/^cortex-/, '') === t));
  if (bySuffix) return bySuffix.sessionId;
  const byIdPrefix = sessions.find(s => s.sessionId.startsWith(t));
  return byIdPrefix ? byIdPrefix.sessionId : null;
}

// ── Mouse-sequence guard ──
// With SGR mouse tracking enabled (for wheel scrolling), Ink still forwards the raw escape
// residue (e.g. "[<64;30;10M" after it strips the leading ESC) to useInput as printable text.
// This predicate lets the input box drop that residue so it never lands in the message buffer.

export function isMouseSequence(input: string): boolean {
  if (!input) return false;
  // eslint-disable-next-line no-control-regex
  if (/\x1b/.test(input)) return true;
  return /\[?<\d+;\d+;\d+[Mm]/.test(input);
}

// ── Multi-line cursor geometry ──
// The input box holds a single string that may contain '\n' (multi-line entry). The cursor is a
// flat character index; these pure helpers map it to a (row, col) grid and back so vertical
// arrow navigation can move between wrapped logical lines.

/** Map a flat cursor index to its zero-based (row, col) within a newline-delimited value. */
export function cursorToRowCol(value: string, cursor: number): { row: number; col: number } {
  const c = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, c);
  const lastNl = before.lastIndexOf('\n');
  const row = before.length === 0 ? 0 : (before.match(/\n/g)?.length ?? 0);
  const col = c - (lastNl + 1);
  return { row, col };
}

/** Map a (row, col) back to a flat cursor index, clamping row to the line count and col to that line. */
export function rowColToCursor(value: string, row: number, col: number): number {
  const lines = value.split('\n');
  const r = Math.max(0, Math.min(row, lines.length - 1));
  const c = Math.max(0, Math.min(col, lines[r].length));
  let idx = 0;
  for (let i = 0; i < r; i++) idx += lines[i].length + 1;
  return idx + c;
}

/** Move the cursor one logical line up (dir -1) or down (dir +1), preserving the column. */
export function moveCursorVertical(value: string, cursor: number, dir: -1 | 1): number {
  const { row, col } = cursorToRowCol(value, cursor);
  return rowColToCursor(value, row + dir, col);
}

// ── Paste sanitization ──
// With bracketed-paste mode on (?2004h, enabled in index.tsx) a paste arrives wrapped in
// ESC[200~ … ESC[201~. These helpers strip the markers and any escape residue and normalize
// line endings so multi-line pastes insert literally instead of submitting per Enter.

/** Remove bracketed-paste begin/end markers — both ESC[200~/ESC[201~ and the BARE [200~/[201~
 *  form (Ink consumes the leading ESC and forwards the remainder as text, so the markers arrive
 *  without their escape and otherwise leak into the buffer). */
export function stripPasteMarkers(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/(?:\x1b)?\[20[01]~/g, '');
}

/** Collapse CRLF and bare CR to LF so pasted line endings are uniform. */
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** Clean a pasted chunk for literal insertion: drop paste markers + escape sequences, normalize newlines. */
export function sanitizePastedText(s: string): string {
  let t = stripPasteMarkers(s);
  // Strip CSI / SGR / mouse escape sequences (cursor reports etc.) but keep printable text + newlines.
  // eslint-disable-next-line no-control-regex
  t = t.replace(/\x1b\[[0-9;?<>]*[ -/]*[@-~]/g, '');
  // eslint-disable-next-line no-control-regex
  t = t.replace(/\x1b[@-_]?/g, '');
  return normalizeNewlines(t);
}

// ── Backspace vs forward-Delete classification ──
// Ink's keypress parser maps BOTH the Backspace key (\x7f) and the forward-Delete key (\x1b[3~)
// to `key.delete` with an empty `input`, so they're indistinguishable in useInput. The raw stdin
// chunk is the only way to tell them apart — this classifier inspects it so the input box can
// delete the char BEFORE the cursor (backspace) vs AFTER it (forward delete).
export function classifyDeleteChunk(s: string): 'backspace' | 'forward-delete' | null {
  // Forward Delete key: ESC[3~ (optionally with a modifier, e.g. ESC[3;5~ for Ctrl+Delete).
  // eslint-disable-next-line no-control-regex
  if (s === '\x1b[3~' || /^\x1b\[3;\d+~$/.test(s)) return 'forward-delete';
  // Backspace key: DEL (\x7f), BS (\x08), or Alt+Backspace (ESC + DEL).
  if (s === '\x7f' || s === '\x08' || s === '\x1b\x7f') return 'backspace';
  return null;
}

// ── General mouse event parsing ──
// Parse ALL SGR mouse events from raw stdin (press, release, drag, wheel) for text selection,
// right-click, and wheel scroll. SGR mode (?1006h) encodes events as ESC[<b;col;rowM/m where
// b carries button identity + modifier flags, M = press/drag, m = release.

export interface TuiMouseEvent {
  type: 'press' | 'release' | 'drag' | 'wheel';
  button: number; // 0=left, 1=middle, 2=right (for wheel: 64=up, 65=down)
  col: number;    // 0-based column
  row: number;    // 0-based row
}

/** Parse ALL SGR mouse events from a raw stdin chunk (press, release, drag, wheel). */
export function parseAllMouseEvents(chunk: string): TuiMouseEvent[] {
  const out: TuiMouseEvent[] = [];
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const b = parseInt(m[1], 10);
    const col = parseInt(m[2], 10) - 1; // 1-based → 0-based
    const row = parseInt(m[3], 10) - 1;
    const isRelease = m[4] === 'm';

    if ((b & 0x40) !== 0) {
      // Wheel event
      out.push({ type: 'wheel', button: b, col, row });
    } else if (isRelease) {
      out.push({ type: 'release', button: b & 0x03, col, row });
    } else if ((b & 0x20) !== 0) {
      // Motion (drag) — button is in lower 2 bits
      out.push({ type: 'drag', button: b & 0x03, col, row });
    } else {
      out.push({ type: 'press', button: b & 0x03, col, row });
    }
  }
  return out;
}

/** Normalize a selection so start is always before end (top-left to bottom-right). */
export function normalizeSelection(
  startLine: number, startCol: number, endLine: number, endCol: number,
): { startLine: number; startCol: number; endLine: number; endCol: number } {
  if (startLine > endLine || (startLine === endLine && startCol > endCol)) {
    return { startLine: endLine, startCol: endCol, endLine: startLine, endCol: startCol };
  }
  return { startLine, startCol, endLine, endCol };
}

/** Extract selected text from flat display lines given a normalized selection range. Columns are
 *  DISPLAY columns (from the mouse), so slicing is width-aware (CJK safe). */
export function extractSelectionText(
  lines: Array<{ text: string }>,
  sel: { startLine: number; startCol: number; endLine: number; endCol: number },
): string {
  if (sel.startLine < 0 || sel.startLine >= lines.length) return '';
  if (sel.startLine === sel.endLine) {
    return splitByDisplayCols(lines[sel.startLine].text, sel.startCol, sel.endCol).selected;
  }
  const parts: string[] = [];
  // First line: from startCol to end (use a huge endCol to take the remainder).
  parts.push(splitByDisplayCols(lines[sel.startLine].text, sel.startCol, Number.MAX_SAFE_INTEGER).selected);
  // Middle lines: full text
  for (let i = sel.startLine + 1; i < Math.min(sel.endLine, lines.length); i++) {
    parts.push(lines[i].text);
  }
  // Last line: from start to endCol
  if (sel.endLine < lines.length) {
    parts.push(splitByDisplayCols(lines[sel.endLine].text, 0, sel.endCol).selected);
  }
  return parts.join('\n');
}

/** Copy text to the system clipboard via the OSC 52 terminal escape (BEL terminator). */
export function osc52Copy(text: string): void {
  const b64 = Buffer.from(text).toString('base64');
  try { process.stdout.write(`\x1b]52;c;${b64}\x07`); } catch { /* best effort */ }
}

/** Parse SGR mouse wheel events from a raw stdin chunk. 64=up, 65=down (low bit = direction). */
export function parseWheelEvents(chunk: string): Array<'up' | 'down'> {
  const out: Array<'up' | 'down'> = [];
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const b = parseInt(m[1], 10);
    if ((b & 0x40) !== 0) out.push((b & 1) === 0 ? 'up' : 'down');
  }
  return out;
}

// ── Line-level transcript flattening ──
// The transcript renders a bottom-anchored window measured in TERMINAL LINES (not whole
// messages), so a single long message is shown in full across scroll steps instead of being
// truncated. Each message is flattened to wrapped display lines; the viewport slices exactly
// `budget` lines so it can never overflow Ink's fixed-height box.

export interface FlatLine {
  text: string;
  /** Render dimmed (tool/context lines, streamed reply, queued marker). */
  dim: boolean;
  /** Render through InlineMarkdown (false → plain Text, e.g. tool/context lines). */
  markdown: boolean;
  /** A user-message line — rendered with a full-width grey background. */
  user: boolean;
}

export interface FlattenableMessage {
  text?: string;
  richBlocks?: Array<{ type: string; text?: string }>;
  /** Pre-collected streamed text (caller concatenates the stream map). */
  streamText?: string;
  queued?: boolean;
  /** Whether this message is the user's own input (grey-background highlight, no "You:"). */
  user?: boolean;
}

/** The prefix the server/echo uses to encode a user-role message in plain text. */
export const USER_PREFIX = '**You:** ';

/** Detect a user message (by the isUser flag OR the `**You:** ` prefix) and strip the prefix. */
export function detectUserMessage(text: string, isUserFlag?: boolean): { text: string; user: boolean } {
  if (text.startsWith(USER_PREFIX)) return { text: text.slice(USER_PREFIX.length), user: true };
  return { text, user: !!isUserFlag };
}

/** Word-wrap a single logical line to `width` DISPLAY columns, hard-splitting over-wide words.
 *  Measured in terminal columns (CJK aware) so Chinese/full-width text wraps where it actually
 *  reaches the edge — matching what the terminal renders, which the selection mapping relies on. */
export function wrapToWidth(text: string, width: number): string[] {
  const w = Math.max(1, width);
  if (text.length === 0) return [''];
  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  for (const word of text.split(' ')) {
    const wordW = stringWidth(word);
    if (wordW > w) {
      // A single word wider than the line: flush, then hard-split it by display width.
      if (cur) { lines.push(cur); cur = ''; curW = 0; }
      let rest = word;
      while (stringWidth(rest) > w) {
        let [head, tail] = sliceHeadToWidth(rest, w);
        if (head.length === 0) { // a lone char wider than w — force-take it so we make progress
          const chars = [...rest];
          head = chars[0];
          tail = chars.slice(1).join('');
        }
        lines.push(head);
        rest = tail;
      }
      cur = rest; curW = stringWidth(rest);
      continue;
    }
    const sep = cur ? 1 : 0;
    if (curW + sep + wordW > w) { lines.push(cur); cur = word; curW = wordW; }
    else { cur = cur ? `${cur} ${word}` : word; curW += sep + wordW; }
  }
  if (cur || lines.length === 0) lines.push(cur);
  return lines;
}

/** Flatten one message into wrapped display lines. */
export function flattenMessageLines(msg: FlattenableMessage, cols: number): FlatLine[] {
  const out: FlatLine[] = [];
  const isUser = !!msg.user;
  const push = (text: string, dim: boolean, markdown: boolean, user = false) => {
    for (const logical of text.split('\n')) {
      for (const wrapped of wrapToWidth(logical, cols)) out.push({ text: wrapped, dim, markdown, user });
    }
  };
  const hasRich = !!(msg.richBlocks && msg.richBlocks.length > 0);
  // Slack Block-Kit semantics: when richBlocks exist they ARE the content; `text` is only a
  // fallback (rendering both double-prints the sealed status line).
  if (msg.text && !hasRich) push(msg.text, false, !isUser, isUser); // user lines render plain on grey
  if (hasRich) {
    for (const b of msg.richBlocks!) {
      if (b.text) push(String(b.text), b.type === 'context', b.type !== 'context');
    }
  }
  if (msg.streamText) push(msg.streamText, true, true);
  if (msg.queued) out.push({ text: '⏳ queued', dim: true, markdown: false, user: false });
  return out;
}

/** Flatten the whole transcript to display lines, with a blank separator between messages. */
export function flattenTranscript(messages: FlattenableMessage[], cols: number): FlatLine[] {
  const out: FlatLine[] = [];
  messages.forEach((m, i) => {
    if (i > 0) out.push({ text: '', dim: false, markdown: false, user: false });
    out.push(...flattenMessageLines(m, cols));
  });
  return out;
}
