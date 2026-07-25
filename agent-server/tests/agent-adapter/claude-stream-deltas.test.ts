// input:  Claude `stream_event` lines (--include-partial-messages), as observed from the real CLI
// output: parseStreamEvent / takeTextBlockId regression tests
// pos:    Token-level assistant streaming — the Claude-side parser contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import {
  createStreamDeltaState,
  parseStreamEvent,
  takeTextBlockId,
} from '../../src/agent-adapter/claude/event-parser.js';
import { _test } from '../../src/agent-adapter/claude/adapter.js';

// Shapes below are verbatim from a live `claude -p --include-partial-messages` run
// (Claude Code 2.1.x, sonnet): one `assistant` event per content block, each block's
// deltas bracketed by content_block_start / content_block_stop.
const messageStart = (id: string) => ({
  type: 'stream_event',
  event: { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [] } },
  session_id: 's',
});
const blockStart = (index: number, blockType: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_start', index, content_block: { type: blockType, text: '' } },
  session_id: 's',
});
const textDelta = (index: number, text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  session_id: 's',
});
const thinkingDelta = (index: number) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 50 } },
  session_id: 's',
});
const jsonDelta = (index: number) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
  session_id: 's',
});
const blockStop = (index: number) => ({ type: 'stream_event', event: { type: 'content_block_stop', index }, session_id: 's' });

describe('parseStreamEvent', () => {
  test('emits text deltas with a blockId of `${messageId}:${contentBlockIndex}`', () => {
    const st = createStreamDeltaState();
    assert.equal(parseStreamEvent(messageStart('msg_1'), st), null);
    assert.equal(parseStreamEvent(blockStart(0, 'text'), st), null);
    assert.deepEqual(parseStreamEvent(textDelta(0, 'Hel'), st), { text: 'Hel', blockId: 'msg_1:0' });
    assert.deepEqual(parseStreamEvent(textDelta(0, 'lo'), st), { text: 'lo', blockId: 'msg_1:0' });
  });

  test('ignores thinking_delta and input_json_delta (v1 streams text only)', () => {
    const st = createStreamDeltaState();
    parseStreamEvent(messageStart('msg_1'), st);
    parseStreamEvent(blockStart(0, 'thinking'), st);
    assert.equal(parseStreamEvent(thinkingDelta(0), st), null);
    parseStreamEvent(blockStart(1, 'tool_use'), st);
    assert.equal(parseStreamEvent(jsonDelta(1), st), null);
  });

  test('ignores every non-stream_event line — the complete events keep their own path', () => {
    const st = createStreamDeltaState();
    assert.equal(parseStreamEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }, st), null);
    assert.equal(parseStreamEvent({ type: 'result', subtype: 'success' }, st), null);
    assert.equal(parseStreamEvent({ type: 'system', subtype: 'init' }, st), null);
    assert.equal(parseStreamEvent(null, st), null);
  });

  test('ignores empty text deltas (nothing to render)', () => {
    const st = createStreamDeltaState();
    parseStreamEvent(messageStart('msg_1'), st);
    parseStreamEvent(blockStart(0, 'text'), st);
    assert.equal(parseStreamEvent(textDelta(0, ''), st), null);
  });

  test('a text delta arriving before message_start is dropped rather than given a bogus blockId', () => {
    const st = createStreamDeltaState();
    assert.equal(parseStreamEvent(textDelta(0, 'orphan'), st), null);
  });

  test('message_start resets block tracking — ids never leak across messages', () => {
    const st = createStreamDeltaState();
    parseStreamEvent(messageStart('msg_1'), st);
    parseStreamEvent(blockStart(0, 'text'), st);
    assert.deepEqual(parseStreamEvent(textDelta(0, 'a'), st), { text: 'a', blockId: 'msg_1:0' });
    parseStreamEvent(messageStart('msg_2'), st);
    assert.equal(takeTextBlockId(st), null, 'the previous message text block must not carry over');
    parseStreamEvent(blockStart(0, 'text'), st);
    assert.deepEqual(parseStreamEvent(textDelta(0, 'b'), st), { text: 'b', blockId: 'msg_2:0' });
  });

  test('two text blocks in one message get distinct blockIds', () => {
    const st = createStreamDeltaState();
    parseStreamEvent(messageStart('msg_1'), st);
    parseStreamEvent(blockStart(0, 'text'), st);
    assert.deepEqual(parseStreamEvent(textDelta(0, 'one'), st), { text: 'one', blockId: 'msg_1:0' });
    parseStreamEvent(blockStop(0), st);
    parseStreamEvent(blockStart(1, 'text'), st);
    assert.deepEqual(parseStreamEvent(textDelta(1, 'two'), st), { text: 'two', blockId: 'msg_1:1' });
  });
});

describe('takeTextBlockId — tying the finalizing assistant event to its streamed block', () => {
  // The CLI emits a SEPARATE `assistant` event per content block (a thinking block and a text
  // block of the same message arrive as two events, each with a single-element `content`), so the
  // block's position inside `message.content` is always 0 and cannot identify the streamed block.
  // The open text block does: the assistant event lands while that block is the current one.
  test('returns the streamed text block id, then clears it (consumed once)', () => {
    const st = createStreamDeltaState();
    parseStreamEvent(messageStart('msg_1'), st);
    parseStreamEvent(blockStart(0, 'text'), st);
    parseStreamEvent(textDelta(0, 'hi'), st);
    assert.equal(takeTextBlockId(st), 'msg_1:0');
    assert.equal(takeTextBlockId(st), null, 'a second assistant event must not reuse a consumed id');
  });

  test('the id survives content_block_stop (assistant event ordering is not guaranteed)', () => {
    const st = createStreamDeltaState();
    parseStreamEvent(messageStart('msg_1'), st);
    parseStreamEvent(blockStart(0, 'text'), st);
    parseStreamEvent(textDelta(0, 'hi'), st);
    parseStreamEvent(blockStop(0), st);
    assert.equal(takeTextBlockId(st), 'msg_1:0');
  });

  test('a thinking-only message yields no id — its assistant event carries no text block', () => {
    const st = createStreamDeltaState();
    parseStreamEvent(messageStart('msg_1'), st);
    parseStreamEvent(blockStart(0, 'thinking'), st);
    parseStreamEvent(thinkingDelta(0), st);
    assert.equal(takeTextBlockId(st), null);
  });

  test('no streaming at all (kill switch / older CLI) yields no id — finalizing path unchanged', () => {
    const st = createStreamDeltaState();
    assert.equal(takeTextBlockId(st), null);
  });

  test('sequential text blocks hand out their ids in order', () => {
    const st = createStreamDeltaState();
    parseStreamEvent(messageStart('msg_1'), st);
    parseStreamEvent(blockStart(0, 'text'), st);
    parseStreamEvent(textDelta(0, 'one'), st);
    assert.equal(takeTextBlockId(st), 'msg_1:0');
    parseStreamEvent(blockStop(0), st);
    parseStreamEvent(blockStart(1, 'text'), st);
    parseStreamEvent(textDelta(1, 'two'), st);
    assert.equal(takeTextBlockId(st), 'msg_1:1');
  });

  test('a text block that streamed no delta still yields its id', () => {
    // content_block_start alone is enough — the block exists even if every delta was empty.
    const st = createStreamDeltaState();
    parseStreamEvent(messageStart('msg_1'), st);
    parseStreamEvent(blockStart(2, 'text'), st);
    assert.equal(takeTextBlockId(st), 'msg_1:2');
  });
});

// ── ClaudeSession.handleLine wiring (no child process — _test.makeSessionForTest) ───────────────

const FAKE_STREAM = { write() {}, end() {} } as any;

function fakeTurn(over: Record<string, unknown> = {}): any {
  return {
    resolve: () => {}, reject: () => {},
    resultData: null, planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
    askUserQuestions: [], finalOutput: null, longestOutput: null, turnCount: 0,
    onProgress: null, onAssistantMessage: null, onToolUse: null, onCompact: null,
    onAssistantDelta: null,
    rawStream: FAKE_STREAM, txtStream: FAKE_STREAM, killed: false,
    ...over,
  };
}

// The exact line sequence the CLI produces for "think, then answer" (live capture).
const L_MSG_START = JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_A', content: [] } } });
const L_THINK_START = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
const L_THINK_DELTA = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } } });
const L_ASSISTANT_THINK = JSON.stringify({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'thinking', thinking: '…' }] } });
const L_THINK_STOP = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
const L_TEXT_START = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
const L_TEXT_D1 = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Tea begins ' } } });
const L_TEXT_D2 = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'as a leaf.' } } });
const L_ASSISTANT_TEXT = JSON.stringify({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: 'Tea begins as a leaf.' }] } });
const L_TEXT_STOP = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });

describe('ClaudeSession.handleLine — delta emission', () => {
  test('emits every text delta through onAssistantDelta, in order, with a stable blockId', (t) => {
    const s: any = _test.makeSessionForTest();
    t.onTestFinished(() => s.close());
    const deltas: Array<[string, string]> = [];
    s.currentTurn = fakeTurn({ onAssistantDelta: (text: string, blockId: string) => deltas.push([text, blockId]) });

    for (const line of [L_MSG_START, L_THINK_START, L_THINK_DELTA, L_ASSISTANT_THINK, L_THINK_STOP, L_TEXT_START, L_TEXT_D1, L_TEXT_D2]) {
      s.handleLine(line);
    }
    assert.deepEqual(deltas, [['Tea begins ', 'msg_A:1'], ['as a leaf.', 'msg_A:1']]);
  });

  test('the finalizing assistant message carries the SAME blockId as its deltas', (t) => {
    const s: any = _test.makeSessionForTest();
    t.onTestFinished(() => s.close());
    const deltas: string[] = [];
    const finals: Array<[string, string | undefined]> = [];
    s.currentTurn = fakeTurn({
      onAssistantDelta: (_text: string, blockId: string) => deltas.push(blockId),
      onAssistantMessage: (text: string, blockId?: string) => finals.push([text, blockId]),
    });

    for (const line of [L_MSG_START, L_THINK_START, L_THINK_DELTA, L_ASSISTANT_THINK, L_THINK_STOP, L_TEXT_START, L_TEXT_D1, L_TEXT_D2, L_ASSISTANT_TEXT, L_TEXT_STOP]) {
      s.handleLine(line);
    }
    assert.deepEqual(finals, [['Tea begins as a leaf.', 'msg_A:1']]);
    assert.equal(deltas[0], 'msg_A:1', 'deltas and the complete message must share the blockId');
  });

  test('the sum of the deltas equals the finalizing text (the UI preview is replaceable in place)', (t) => {
    const s: any = _test.makeSessionForTest();
    t.onTestFinished(() => s.close());
    let streamed = '';
    let final = '';
    s.currentTurn = fakeTurn({
      onAssistantDelta: (text: string) => { streamed += text; },
      onAssistantMessage: (text: string) => { final = text; },
    });
    for (const line of [L_MSG_START, L_TEXT_START, L_TEXT_D1, L_TEXT_D2, L_ASSISTANT_TEXT]) s.handleLine(line);
    assert.equal(streamed, final);
  });

  test('finalizing message without any streaming still fires, with no blockId (kill switch path)', (t) => {
    const s: any = _test.makeSessionForTest();
    t.onTestFinished(() => s.close());
    const finals: Array<[string, string | undefined]> = [];
    s.currentTurn = fakeTurn({ onAssistantMessage: (text: string, blockId?: string) => finals.push([text, blockId]) });
    s.handleLine(L_ASSISTANT_TEXT);
    assert.deepEqual(finals, [['Tea begins as a leaf.', undefined]]);
  });

  test('a turn with no delta callback ignores stream_event lines without throwing', (t) => {
    const s: any = _test.makeSessionForTest();
    t.onTestFinished(() => s.close());
    s.currentTurn = fakeTurn();
    for (const line of [L_MSG_START, L_TEXT_START, L_TEXT_D1]) s.handleLine(line);
    assert.ok(true);
  });

  test('a throwing delta callback cannot break the line loop', (t) => {
    const s: any = _test.makeSessionForTest();
    t.onTestFinished(() => s.close());
    let finalSeen = false;
    s.currentTurn = fakeTurn({
      onAssistantDelta: () => { throw new Error('render blew up'); },
      onAssistantMessage: () => { finalSeen = true; },
    });
    for (const line of [L_MSG_START, L_TEXT_START, L_TEXT_D1, L_ASSISTANT_TEXT]) s.handleLine(line);
    assert.equal(finalSeen, true, 'the complete message must still be delivered');
  });

  test('stream_event lines stay OUT of the per-turn raw jsonl (they are ~75-86% of stdout)', (t) => {
    const s: any = _test.makeSessionForTest();
    t.onTestFinished(() => s.close());
    const raw: string[] = [];
    s.currentTurn = fakeTurn({ rawStream: { write: (l: string) => raw.push(l), end() {} } });

    for (const line of [L_MSG_START, L_TEXT_START, L_TEXT_D1, L_TEXT_D2, L_ASSISTANT_TEXT, L_TEXT_STOP]) s.handleLine(line);
    assert.deepEqual(raw, [L_ASSISTANT_TEXT + '\n'], 'only complete events are recorded');
  });

  test('unparseable lines are still recorded raw (no regression from the parse reorder)', (t) => {
    const s: any = _test.makeSessionForTest();
    t.onTestFinished(() => s.close());
    const raw: string[] = [];
    const txt: string[] = [];
    s.currentTurn = fakeTurn({
      rawStream: { write: (l: string) => raw.push(l), end() {} },
      txtStream: { write: (l: string) => txt.push(l), end() {} },
    });
    s.handleLine('not json at all');
    assert.deepEqual(raw, ['not json at all\n']);
    assert.ok(txt.some((l) => l.includes('[raw] not json at all')));
  });
});
