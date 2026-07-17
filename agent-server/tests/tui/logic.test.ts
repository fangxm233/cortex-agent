// input:  src/tui/logic.js (pure helpers)
// output: Unit tests for TUI pure logic — focus zone, response-frame detection,
//         stream text collection, visible-window computation
// pos:    Guards the behavioral fixes for input/focus/scroll defects

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  computeFocusZone,
  isAgentResponseFrame,
  collectStreamText,
  computeVisibleWindow,
  computeFocusWindow,
  estimateLines,
  computeLineWindow,
  historyPrev,
  historyNext,
  pushHistory,
  matchResumeTarget,
  isMouseSequence,
  parseWheelEvents,
  wrapToWidth,
  flattenMessageLines,
  flattenTranscript,
  detectUserMessage,
  cursorToRowCol,
  rowColToCursor,
  moveCursorVertical,
  stripPasteMarkers,
  normalizeNewlines,
  sanitizePastedText,
  classifyDeleteChunk,
  parseAllMouseEvents,
  normalizeSelection,
  extractSelectionText,
  osc52Copy,
  padToWidth,
  splitByDisplayCols,
} from '../../src/tui/logic.js';

// ── estimateLines ──

test('estimateLines: wraps by width and counts newlines', () => {
  assert.equal(estimateLines('', 80), 0);
  assert.equal(estimateLines('short', 80), 1);
  assert.equal(estimateLines('a'.repeat(81), 80), 2);
  assert.equal(estimateLines('line1\nline2', 80), 2);
  assert.equal(estimateLines('a'.repeat(160) + '\nx', 80), 3);
});

// ── computeLineWindow ──

test('computeLineWindow: fits as many bottom rows as the budget allows', () => {
  // five rows, 2 lines each = 10 lines; budget 5 → last 2 rows (4 lines), 3rd would overflow
  const counts = [2, 2, 2, 2, 2];
  const w = computeLineWindow(counts, 5, 0);
  assert.equal(w.end, 5);
  assert.equal(w.start, 3); // rows 3,4 fit (4 lines); row 2 would make 6 > 5
});

test('computeLineWindow: always includes at least the last row even if taller than budget', () => {
  const w = computeLineWindow([3, 20], 5, 0);
  assert.deepEqual(w, { start: 1, end: 2 });
});

test('computeLineWindow: scrollOffset hides rows from the bottom', () => {
  const counts = [1, 1, 1, 1, 1];
  const w = computeLineWindow(counts, 2, 2); // offset 2 → end=3
  assert.equal(w.end, 3);
  assert.equal(w.start, 1);
});

test('computeLineWindow: empty list', () => {
  assert.deepEqual(computeLineWindow([], 10, 0), { start: 0, end: 0 });
});

// ── computeFocusWindow ──

test('computeFocusWindow: short list renders fully, nothing hidden', () => {
  const w = computeFocusWindow(3, 0, 8);
  assert.deepEqual(w, { start: 0, end: 3, hiddenAbove: 0, hiddenBelow: 0 });
});

test('computeFocusWindow: empty list is a no-op', () => {
  assert.deepEqual(computeFocusWindow(0, 0, 8), { start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0 });
});

test('computeFocusWindow: long list caps the slice and reports hidden counts', () => {
  const w = computeFocusWindow(20, 0, 6);
  assert.equal(w.end - w.start, 6, 'window is capped at maxVisible');
  assert.equal(w.start, 0);
  assert.equal(w.hiddenAbove, 0);
  assert.equal(w.hiddenBelow, 14);
});

test('computeFocusWindow: focused row stays inside the window when scrolled down', () => {
  const w = computeFocusWindow(20, 15, 6);
  assert.ok(15 >= w.start && 15 < w.end, 'focused index is visible');
  assert.equal(w.end - w.start, 6);
});

test('computeFocusWindow: window clamps to the end (no overscroll past last row)', () => {
  const w = computeFocusWindow(20, 19, 6);
  assert.equal(w.end, 20);
  assert.equal(w.start, 14);
  assert.equal(w.hiddenBelow, 0);
  assert.equal(w.hiddenAbove, 14);
});

// ── computeFocusZone ──

test('computeFocusZone: modal wins over everything', () => {
  assert.equal(computeFocusZone({ modalOpen: true, sidePanelVisible: true }), 'modal');
  assert.equal(computeFocusZone({ modalOpen: true, sidePanelVisible: false }), 'modal');
});

test('computeFocusZone: dashboard when side panel visible and no modal', () => {
  assert.equal(computeFocusZone({ modalOpen: false, sidePanelVisible: true }), 'dashboard');
});

test('computeFocusZone: input by default', () => {
  assert.equal(computeFocusZone({ modalOpen: false, sidePanelVisible: false }), 'input');
});

// ── isAgentResponseFrame ──

test('isAgentResponseFrame: true for agent reply / stream frames', () => {
  for (const type of [
    'chat.post', 'chat.update', 'interactive.post',
    'stream.text', 'stream.mutableOpen', 'stream.mutableUpdate', 'transcript.replay',
  ]) {
    assert.equal(isAgentResponseFrame({ type } as any), true, `expected true for ${type}`);
  }
});

test('isAgentResponseFrame: false for non-response frames', () => {
  for (const type of [
    'notification', 'ui.event', 'ui.queryResult', 'chat.markQueued',
    'pong', 'session.switched', 'handshake.ack', 'msg.user', 'error',
  ]) {
    assert.equal(isAgentResponseFrame({ type } as any), false, `expected false for ${type}`);
  }
});

// ── collectStreamText ──

test('collectStreamText: joins blocks one per line, in order', () => {
  const streams = new Map<string, { blocks: Array<{ kind: 'text' | 'region'; regionId?: string; text: string }> }>();
  streams.set('s1', { blocks: [{ kind: 'text', text: 'Hello,' }, { kind: 'text', text: 'world' }, { kind: 'region', regionId: 'r1', text: '!' }] });
  assert.equal(collectStreamText(streams), 'Hello,\nworld\n!');
});

test('collectStreamText: empty streams → empty string', () => {
  assert.equal(collectStreamText(new Map()), '');
});

test('collectStreamText: multiple streams joined per line in insertion order', () => {
  const streams = new Map<string, { blocks: Array<{ kind: 'text' | 'region'; regionId?: string; text: string }> }>();
  streams.set('s1', { blocks: [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }] });
  streams.set('s2', { blocks: [{ kind: 'text', text: 'c' }] });
  assert.equal(collectStreamText(streams), 'a\nb\nc');
});

// ── computeVisibleWindow ──

test('computeVisibleWindow: empty list', () => {
  assert.deepEqual(computeVisibleWindow(0, 10, 0), { start: 0, end: 0 });
});

test('computeVisibleWindow: list shorter than viewport shows all', () => {
  assert.deepEqual(computeVisibleWindow(5, 10, 0), { start: 0, end: 5 });
});

test('computeVisibleWindow: anchored to bottom when offset 0', () => {
  assert.deepEqual(computeVisibleWindow(5, 3, 0), { start: 2, end: 5 });
});

test('computeVisibleWindow: scroll up reveals earlier messages', () => {
  assert.deepEqual(computeVisibleWindow(5, 3, 2), { start: 0, end: 3 });
});

test('computeVisibleWindow: offset clamped so window never goes past top', () => {
  assert.deepEqual(computeVisibleWindow(5, 3, 99), { start: 0, end: 1 });
});

// ── input history navigation ──

test('historyPrev: empty history is a no-op', () => {
  const r = historyPrev([], { index: null, draft: '' }, 'typing');
  assert.deepEqual(r, { value: 'typing', state: { index: null, draft: '' } });
});

test('historyPrev: first Up shows newest entry and saves the live draft', () => {
  const r = historyPrev(['a', 'b', 'c'], { index: null, draft: '' }, 'half-typed');
  assert.equal(r.value, 'c');
  assert.deepEqual(r.state, { index: 2, draft: 'half-typed' });
});

test('historyPrev: successive Up steps to older entries and stops at the oldest', () => {
  const hist = ['a', 'b', 'c'];
  let s = historyPrev(hist, { index: null, draft: '' }, 'd');
  assert.equal(s.value, 'c');
  s = historyPrev(hist, s.state, s.value);
  assert.equal(s.value, 'b');
  s = historyPrev(hist, s.state, s.value);
  assert.equal(s.value, 'a');
  s = historyPrev(hist, s.state, s.value); // clamps at oldest
  assert.equal(s.value, 'a');
  assert.equal(s.state.index, 0);
  assert.equal(s.state.draft, 'd'); // draft preserved through navigation
});

test('historyNext: not navigating is a no-op', () => {
  const r = historyNext(['a', 'b'], { index: null, draft: '' }, 'typing');
  assert.deepEqual(r, { value: 'typing', state: { index: null, draft: '' } });
});

test('historyNext: Down steps to newer entries then restores the draft past the newest', () => {
  const hist = ['a', 'b', 'c'];
  // navigate up to 'a' (index 0) with draft 'd'
  let s = { value: 'a', state: { index: 0, draft: 'd' } as { index: number | null; draft: string } };
  s = historyNext(hist, s.state, s.value);
  assert.equal(s.value, 'b');
  s = historyNext(hist, s.state, s.value);
  assert.equal(s.value, 'c');
  s = historyNext(hist, s.state, s.value); // past newest → restore draft, exit nav
  assert.equal(s.value, 'd');
  assert.equal(s.state.index, null);
  assert.equal(s.state.draft, '');
});

test('pushHistory: appends, skips blanks and consecutive duplicates', () => {
  assert.deepEqual(pushHistory([], 'a'), ['a']);
  assert.deepEqual(pushHistory(['a'], 'a'), ['a']); // dup collapsed
  assert.deepEqual(pushHistory(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(pushHistory(['a'], '   '), ['a']); // blank ignored
  assert.deepEqual(pushHistory(['a', 'b'], 'a'), ['a', 'b', 'a']); // non-consecutive dup kept
});

// ── matchResumeTarget ──

const SESSIONS = [
  { sessionId: 'sid-aaaa1111', name: 'cortex-8cdfbe' },
  { sessionId: 'sid-bbbb2222', name: 'cortex-99ffaa' },
];

test('matchResumeTarget: exact sessionId, exact name, suffix, and bare suffix', () => {
  assert.equal(matchResumeTarget(SESSIONS, 'sid-aaaa1111'), 'sid-aaaa1111');
  assert.equal(matchResumeTarget(SESSIONS, 'cortex-8cdfbe'), 'sid-aaaa1111');
  assert.equal(matchResumeTarget(SESSIONS, '8cdfbe'), 'sid-aaaa1111'); // bare short id
  assert.equal(matchResumeTarget(SESSIONS, 'sid-bbbb'), 'sid-bbbb2222'); // id prefix
});

test('matchResumeTarget: no match and empty target → null', () => {
  assert.equal(matchResumeTarget(SESSIONS, 'nope'), null);
  assert.equal(matchResumeTarget(SESSIONS, '   '), null);
  assert.equal(matchResumeTarget([], 'cortex-8cdfbe'), null);
});

// ── isMouseSequence / parseWheelEvents ──

test('isMouseSequence: detects raw ESC and SGR residue, passes normal text', () => {
  assert.equal(isMouseSequence('\x1b[<64;1;1M'), true);
  assert.equal(isMouseSequence('[<64;30;10M'), true); // ESC already stripped by Ink
  assert.equal(isMouseSequence('hello'), false);
  assert.equal(isMouseSequence(''), false);
});

test('parseWheelEvents: extracts up/down from SGR wheel codes', () => {
  assert.deepEqual(parseWheelEvents('\x1b[<64;10;5M'), ['up']);
  assert.deepEqual(parseWheelEvents('\x1b[<65;10;5M'), ['down']);
  assert.deepEqual(parseWheelEvents('\x1b[<0;10;5M'), []); // plain click, not a wheel
  assert.deepEqual(parseWheelEvents('\x1b[<64;1;1M\x1b[<65;1;1M'), ['up', 'down']);
});

// ── wrapToWidth ──

test('wrapToWidth: word-wraps and hard-splits over-long words', () => {
  assert.deepEqual(wrapToWidth('', 10), ['']);
  assert.deepEqual(wrapToWidth('hello world', 5), ['hello', 'world']);
  assert.deepEqual(wrapToWidth('abcdefghijk', 5), ['abcde', 'fghij', 'k']);
  assert.deepEqual(wrapToWidth('hi there friend', 8), ['hi there', 'friend']);
});

// ── flattenMessageLines / flattenTranscript ──

test('flattenMessageLines: text message wraps into markdown lines (no truncation)', () => {
  const lines = flattenMessageLines({ text: 'a'.repeat(25) }, 10);
  assert.equal(lines.length, 3); // 25 chars / 10 → 3 lines, all kept
  assert.ok(lines.every(l => l.markdown && !l.dim));
  assert.equal(lines.map(l => l.text).join(''), 'a'.repeat(25));
});

test('flattenMessageLines: context rich blocks render dim and non-markdown', () => {
  const lines = flattenMessageLines({ richBlocks: [{ type: 'context', text: '🔧 Bash' }] }, 80);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].dim, true);
  assert.equal(lines[0].markdown, false);
});

test('flattenMessageLines: streamed text is dim, queued marker appended', () => {
  const lines = flattenMessageLines({ streamText: 'reply', queued: true }, 80);
  assert.deepEqual(lines.map(l => l.text), ['reply', '⏳ queued']);
  assert.ok(lines[0].dim);
});

test('flattenTranscript: inserts a blank separator line between messages', () => {
  const lines = flattenTranscript([{ text: 'one' }, { text: 'two' }], 80);
  assert.deepEqual(lines.map(l => l.text), ['one', '', 'two']);
});

// ── detectUserMessage ──

test('detectUserMessage: strips the "**You:** " prefix and marks user', () => {
  assert.deepEqual(detectUserMessage('**You:** hi there'), { text: 'hi there', user: true });
});

test('detectUserMessage: honours the isUser flag without a prefix', () => {
  assert.deepEqual(detectUserMessage('hello', true), { text: 'hello', user: true });
});

test('detectUserMessage: plain assistant text is not a user message', () => {
  assert.deepEqual(detectUserMessage('some answer'), { text: 'some answer', user: false });
});

// ── user-message flattening ──

test('flattenMessageLines: user message marks lines user + plain (no markdown)', () => {
  const lines = flattenMessageLines({ text: 'my question', user: true }, 80);
  assert.ok(lines.length >= 1);
  assert.ok(lines.every(l => l.user === true), 'all user lines flagged');
  assert.ok(lines.every(l => l.markdown === false), 'user lines render plain (grey bg, no markdown)');
});

test('flattenMessageLines: non-user message lines are not flagged user', () => {
  const lines = flattenMessageLines({ text: 'assistant reply' }, 80);
  assert.ok(lines.every(l => l.user === false));
});

// ── multi-line cursor navigation ──

test('cursorToRowCol: maps a flat index to row/col across newlines', () => {
  const v = 'ab\ncde\nf';
  assert.deepEqual(cursorToRowCol(v, 0), { row: 0, col: 0 });
  assert.deepEqual(cursorToRowCol(v, 2), { row: 0, col: 2 });       // end of first line
  assert.deepEqual(cursorToRowCol(v, 3), { row: 1, col: 0 });       // just after first newline
  assert.deepEqual(cursorToRowCol(v, 6), { row: 1, col: 3 });       // end of "cde"
  assert.deepEqual(cursorToRowCol(v, 8), { row: 2, col: 1 });       // end of "f"
});

test('rowColToCursor: inverse of cursorToRowCol, clamps out-of-range col', () => {
  const v = 'ab\ncde\nf';
  assert.equal(rowColToCursor(v, 0, 0), 0);
  assert.equal(rowColToCursor(v, 1, 0), 3);
  assert.equal(rowColToCursor(v, 1, 3), 6);
  // col clamps to the target line's length (line "f" has length 1)
  assert.equal(rowColToCursor(v, 2, 9), 8);
  // row clamps to last line
  assert.equal(rowColToCursor(v, 99, 0), 7);
});

test('moveCursorVertical: down/up preserve column where possible', () => {
  const v = 'abcd\nef\nghij';
  // From row0 col3 (index 3) moving down → row1, but "ef" has length 2 so col clamps to 2 (index 7)
  assert.equal(moveCursorVertical(v, 3, 1), 7);
  // From row2 col2 (index 12... actually g=8,h=9,i=10,j=11; col2 → index 10) moving up → row1 clamps col2→2 (index 7)
  assert.equal(moveCursorVertical(v, 10, -1), 7);
  // Up from the first row is a no-op (stays on row 0)
  assert.equal(cursorToRowCol(v, moveCursorVertical(v, 2, -1)).row, 0);
});

// ── paste sanitization ──

test('stripPasteMarkers: removes bracketed-paste begin/end markers', () => {
  assert.equal(stripPasteMarkers('\x1b[200~hello\x1b[201~'), 'hello');
  assert.equal(stripPasteMarkers('no markers'), 'no markers');
});

test('stripPasteMarkers: removes BARE markers (ESC already stripped by ink)', () => {
  // Ink consumes the leading ESC and forwards the remainder as text, so the markers arrive as
  // bare "[200~"/"[201~" — these must be stripped too or they leak into the buffer.
  assert.equal(stripPasteMarkers('[200~hello[201~'), 'hello');
  assert.equal(stripPasteMarkers('[201~'), '');
});

test('normalizeNewlines: collapses CRLF and bare CR to LF', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('sanitizePastedText: strips markers + escape residue, normalizes newlines', () => {
  assert.equal(sanitizePastedText('\x1b[200~line1\r\nline2\x1b[201~'), 'line1\nline2');
  // pure escape residue sanitizes to empty
  assert.equal(sanitizePastedText('\x1b[2J'), '');
  // plain multi-line text passes through with normalized newlines
  assert.equal(sanitizePastedText('a\r\nb'), 'a\nb');
});

test('sanitizePastedText: strips BARE bracketed-paste markers (the [201~ leak)', () => {
  assert.equal(sanitizePastedText('[200~hello world[201~'), 'hello world');
  assert.equal(sanitizePastedText('[201~'), '');
  assert.equal(sanitizePastedText('[200~line1\r\nline2[201~'), 'line1\nline2');
});

// ── classifyDeleteChunk (Backspace vs forward-Delete) ──
// Ink lumps \x7f (Backspace) and \x1b[3~ (forward Delete) both into key.delete, so the raw
// stdin chunk is the only way to tell them apart.

test('classifyDeleteChunk: \\x7f and \\x08 are backspace (delete the char before the cursor)', () => {
  assert.equal(classifyDeleteChunk('\x7f'), 'backspace');
  assert.equal(classifyDeleteChunk('\x08'), 'backspace');
  assert.equal(classifyDeleteChunk('\x1b\x7f'), 'backspace'); // alt+backspace
});

test('classifyDeleteChunk: \\x1b[3~ (and modified) is forward-delete (delete the char after)', () => {
  assert.equal(classifyDeleteChunk('\x1b[3~'), 'forward-delete');
  assert.equal(classifyDeleteChunk('\x1b[3;5~'), 'forward-delete'); // ctrl+delete
});

test('classifyDeleteChunk: anything else is null', () => {
  assert.equal(classifyDeleteChunk('a'), null);
  assert.equal(classifyDeleteChunk(''), null);
  assert.equal(classifyDeleteChunk('\x1b[D'), null);   // left arrow
  assert.equal(classifyDeleteChunk('hello'), null);    // a paste
});

// ── parseAllMouseEvents ──

test('parseAllMouseEvents: parses left press + release (SGR)', () => {
  // button 0 (left), col 10, row 5, M = press
  const events = parseAllMouseEvents('\x1b[<0;10;5M');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'press', button: 0, col: 9, row: 4 }); // 1-based → 0-based
});

test('parseAllMouseEvents: parses release (lowercase m)', () => {
  const events = parseAllMouseEvents('\x1b[<0;10;5m');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'release', button: 0, col: 9, row: 4 });
});

test('parseAllMouseEvents: parses drag events (button bit 0x20 set)', () => {
  // button code 32 = 0x20 (motion flag) | 0 (left button)
  const events = parseAllMouseEvents('\x1b[<32;15;8M');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'drag', button: 0, col: 14, row: 7 });
});

test('parseAllMouseEvents: parses wheel events (button bit 0x40 set)', () => {
  // 64 = wheel up, 65 = wheel down
  const events = parseAllMouseEvents('\x1b[<64;1;1M\x1b[<65;1;1M');
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'wheel');
  assert.equal(events[0].button, 64);
  assert.equal(events[1].type, 'wheel');
  assert.equal(events[1].button, 65);
});

test('parseAllMouseEvents: parses right-click (button 2)', () => {
  const events = parseAllMouseEvents('\x1b[<2;20;10M');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'press', button: 2, col: 19, row: 9 });
});

test('parseAllMouseEvents: handles multiple events in one chunk', () => {
  // left press then drag then release
  const chunk = '\x1b[<0;5;3M\x1b[<32;10;3M\x1b[<0;10;3m';
  const events = parseAllMouseEvents(chunk);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'press');
  assert.equal(events[1].type, 'drag');
  assert.equal(events[2].type, 'release');
});

test('parseAllMouseEvents: returns empty array for non-mouse input', () => {
  assert.deepEqual(parseAllMouseEvents('hello'), []);
  assert.deepEqual(parseAllMouseEvents(''), []);
});

// ── normalizeSelection ──

test('normalizeSelection: already normalized (start before end) is returned as-is', () => {
  const s = normalizeSelection(2, 5, 4, 10);
  assert.deepEqual(s, { startLine: 2, startCol: 5, endLine: 4, endCol: 10 });
});

test('normalizeSelection: swaps when start is after end (backward drag)', () => {
  const s = normalizeSelection(4, 10, 2, 5);
  assert.deepEqual(s, { startLine: 2, startCol: 5, endLine: 4, endCol: 10 });
});

test('normalizeSelection: same line, swaps columns when startCol > endCol', () => {
  const s = normalizeSelection(3, 15, 3, 5);
  assert.deepEqual(s, { startLine: 3, startCol: 5, endLine: 3, endCol: 15 });
});

test('normalizeSelection: same point is a no-op', () => {
  const s = normalizeSelection(3, 5, 3, 5);
  assert.deepEqual(s, { startLine: 3, startCol: 5, endLine: 3, endCol: 5 });
});

// ── extractSelectionText ──

test('extractSelectionText: single-line selection', () => {
  const lines = [
    { text: 'Hello, world!' },
    { text: 'Second line' },
  ];
  assert.equal(extractSelectionText(lines, { startLine: 0, startCol: 7, endLine: 0, endCol: 12 }), 'world');
});

test('extractSelectionText: multi-line selection', () => {
  const lines = [
    { text: 'line zero' },
    { text: 'line one' },
    { text: 'line two' },
    { text: 'line three' },
  ];
  const text = extractSelectionText(lines, { startLine: 1, startCol: 5, endLine: 3, endCol: 4 });
  assert.equal(text, 'one\nline two\nline');
});

test('extractSelectionText: out-of-range startLine returns empty', () => {
  const lines = [{ text: 'only' }];
  assert.equal(extractSelectionText(lines, { startLine: 5, startCol: 0, endLine: 5, endCol: 3 }), '');
  assert.equal(extractSelectionText(lines, { startLine: -1, startCol: 0, endLine: 0, endCol: 3 }), '');
});

test('extractSelectionText: endLine clamped to lines length', () => {
  const lines = [{ text: 'alpha' }, { text: 'beta' }];
  // endLine beyond array length — only first line from startCol
  const text = extractSelectionText(lines, { startLine: 0, startCol: 2, endLine: 5, endCol: 2 });
  assert.equal(text, 'pha\nbeta');
});

// ── osc52Copy ──

test('osc52Copy: writes the correct OSC 52 escape to stdout', () => {
  // Capture what osc52Copy writes to stdout
  const written: string[] = [];
  const origWrite = process.stdout.write;
  process.stdout.write = ((chunk: string) => { written.push(chunk); return true; }) as any;
  try {
    osc52Copy('hello');
    assert.equal(written.length, 1);
    const b64 = Buffer.from('hello').toString('base64');
    assert.equal(written[0], `\x1b]52;c;${b64}\x07`);
  } finally {
    process.stdout.write = origWrite;
  }
});

// ── Display-width-aware helpers (CJK / full-width support) ──
// Terminal columns are display cells; CJK chars occupy 2 columns but 1 JS char. These helpers
// keep wrapping / padding / selection aligned to what the terminal actually shows.

test('padToWidth: pads to display columns, accounting for full-width chars', () => {
  assert.equal(padToWidth('ab', 5), 'ab   ');        // 2 cols + 3 spaces
  assert.equal(padToWidth('你好', 6), '你好  ');      // 4 cols + 2 spaces
  assert.equal(padToWidth('你好', 4), '你好');        // already 4 cols, no pad
  assert.equal(padToWidth('你好', 3), '你好');        // wider than target → unchanged
});

test('splitByDisplayCols: splits a line by display columns (CJK aware)', () => {
  // "a你b" → cols: a@0, 你@1-2, b@3
  assert.deepEqual(splitByDisplayCols('a你b', 1, 3), { before: 'a', selected: '你', after: 'b' });
  assert.deepEqual(splitByDisplayCols('你好世界', 2, 6), { before: '你', selected: '好世', after: '界' });
  assert.deepEqual(splitByDisplayCols('hello', 1, 3), { before: 'h', selected: 'el', after: 'lo' });
});

test('wrapToWidth: wraps CJK by display width, not char count', () => {
  assert.deepEqual(wrapToWidth('你好世界', 4), ['你好', '世界']); // each char 2 cols → 2 per line
  assert.deepEqual(wrapToWidth('你好世界', 5), ['你好', '世界']); // 你好=4 cols, +世=6 > 5 → wrap
  // ASCII behaviour unchanged
  assert.deepEqual(wrapToWidth('abcdef', 3), ['abc', 'def']);
});

test('extractSelectionText: uses display columns for CJK lines', () => {
  // single line, select the middle two full-width chars (cols 2..6)
  assert.equal(extractSelectionText([{ text: '你好世界' }], { startLine: 0, startCol: 2, endLine: 0, endCol: 6 }), '好世');
});
