// input:  TUI frame fixtures and protocol codec
// output: round-trip, validation, and representative guard tests
// pos:    Verifies TUI wire parsing and encoding behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  encodeFrame, parseFrame,
  HANDSHAKE_HELLO, HANDSHAKE_ACK, SESSION_SWITCH, SESSION_SWITCHED,
  PING, PONG, CLOSE,
  CHAT_POST, CHAT_UPDATE, CHAT_DELETE, CHAT_MARK_QUEUED,
  MSG_USER, MSG_EDIT,
  STREAM_TEXT, STREAM_MUTABLE_OPEN, STREAM_MUTABLE_UPDATE, STREAM_FLUSH,
  INTERACTIVE_POST, MODAL_OPEN, MODAL_ACK, ACTION_CLICK, MODAL_SUBMIT,
  TRANSCRIPT_REPLAY, NOTIFICATION,
  UI_QUERY, UI_QUERY_RESULT, UI_MUTATE, UI_MUTATE_RESULT,
  UI_SUBSCRIBE, UI_EVENT, UI_UNSUBSCRIBE,
  ERROR,
  isHandshakeHello, isChatPost, isNotification, isModalOpen, isErrorFrame,
} from '../../src/platform/tui/protocol.js';
import type {
  TuiFrame,
  HandshakeHello, HandshakeAck, SessionSwitch, SessionSwitched,
  Ping, Pong, Close,
  ChatPost, ChatUpdate, ChatDelete, ChatMarkQueued,
  MsgUser, MsgEdit,
  StreamText, StreamMutableOpen, StreamMutableUpdate, StreamFlush,
  InteractivePost, ModalOpen, ModalAck, ActionClick, ModalSubmit,
  TranscriptReplay, Notification,
  UiQuery, UiQueryResult, UiMutate, UiMutateResult,
  UiSubscribe, UiEvent, UiUnsubscribe,
  ErrorFrame,
} from '../../src/platform/tui/protocol.js';

// ── Representative frames (one per variant, all fields populated) ──

// Reusable MessageRef fixture (matches platform/types.ts shape)
const REF = { conduit: 'tui:abc-123', messageId: 'm-001', threadId: 'anchor-1' } as const;

// Children of TranscriptReplay (defined separately so we can reference them)
const REPLAY_CHILD_POST: ChatPost = {
  type: CHAT_POST, ref: REF, content: { text: 'hi' }, seq: 10,
};
const REPLAY_CHILD_UPDATE: ChatUpdate = {
  type: CHAT_UPDATE, ref: REF, content: { text: 'hi (edited)' }, seq: 11,
};
const REPLAY_CHILD_INTERACTIVE: InteractivePost = {
  type: INTERACTIVE_POST, ref: REF,
  content: { text: 'choose:' },
  actions: [{ type: 'button', text: 'Go', actionId: 'go', value: '1' }],
  seq: 12,
};

const REPRESENTATIVE_FRAMES: TuiFrame[] = [
  // --- Lifecycle ---
  {
    type: HANDSHAKE_HELLO, protocolVersion: PROTOCOL_VERSION,
    clientName: 'cortex-tui', clientVersion: '0.1.0',
    resume: { sessionId: 'sess-prev' }, project: 'cortex-self',
  } satisfies HandshakeHello,
  {
    type: HANDSHAKE_ACK, protocolVersion: PROTOCOL_VERSION,
    serverVersion: '1.2.3', conduitId: 'tui:abc-123',
    defaultProjectId: 'general', seq: 0,
  } satisfies HandshakeAck,
  {
    type: SESSION_SWITCH, id: 'req-1', projectId: 'cortex-self', sessionId: 'sess-001',
  } satisfies SessionSwitch,
  {
    type: SESSION_SWITCHED, id: 'req-1', projectId: 'cortex-self',
    sessionId: 'sess-001', sessionName: 'cortex-AB12',
    isFresh: false, seq: 1,
  } satisfies SessionSwitched,
  { type: PING, ts: 1700000000000 } satisfies Ping,
  { type: PONG, ts: 1700000000000 } satisfies Pong,
  { type: CLOSE, reason: 'user-quit' } satisfies Close,

  // --- Chat outbound (S→C, with seq + ref) ---
  {
    type: CHAT_POST, ref: REF,
    content: { text: 'hello', richBlocks: [{ type: 'markdown', text: '**bold**' }] },
    threadAnchorId: 'anchor-1', seq: 2,
  } satisfies ChatPost,
  {
    type: CHAT_UPDATE, ref: REF, content: { text: 'updated' }, seq: 3,
  } satisfies ChatUpdate,
  { type: CHAT_DELETE, ref: REF, seq: 4 } satisfies ChatDelete,
  { type: CHAT_MARK_QUEUED, ref: REF, seq: 5 } satisfies ChatMarkQueued,

  // --- Chat inbound (C→S, with id + attachments) ---
  {
    type: MSG_USER, id: 'msg-req-1', text: 'hello',
    threadAnchorId: 'anchor-1',
    attachments: [{ path: '/tmp/a.png', mimeType: 'image/png', name: 'a.png' }],
  } satisfies MsgUser,
  { type: MSG_EDIT, id: 'edit-req-1', ref: REF, newText: 'edited' } satisfies MsgEdit,

  // --- Streaming (S→C, with seq) ---
  { type: STREAM_TEXT, streamId: 's1', text: 'part1', seq: 6 } satisfies StreamText,
  {
    type: STREAM_MUTABLE_OPEN, streamId: 's1', regionId: 'r1',
    text: 'initial', seq: 7,
  } satisfies StreamMutableOpen,
  {
    type: STREAM_MUTABLE_UPDATE, streamId: 's1', regionId: 'r1',
    text: 'updated', seq: 8,
  } satisfies StreamMutableUpdate,
  { type: STREAM_FLUSH, streamId: 's1', seq: 9 } satisfies StreamFlush,

  // --- Interactive ---
  {
    type: INTERACTIVE_POST, ref: REF,
    content: { text: 'choose:' },
    actions: [{ type: 'button', text: 'Go', actionId: 'go', value: '1' }],
    threadAnchorId: 'anchor-1', seq: 12,
  } satisfies InteractivePost,
  {
    type: MODAL_OPEN, triggerId: 'tui:abc-123:trig-1',
    modal: {
      callbackId: 'cb1', title: 'Form',
      fields: [{ type: 'text_input', blockId: 'b1', label: 'Name', actionId: 'a1' }],
    },
    seq: 13,
  } satisfies ModalOpen,
  { type: MODAL_ACK, id: 'sub-req-1', errors: { b1: 'required' }, seq: 14 } satisfies ModalAck,
  {
    type: ACTION_CLICK, id: 'act-req-1', actionId: 'btn_go', value: '1',
    triggerId: 'tui:abc-123:trig-1', messageRef: REF, userId: 'cortex-tui',
  } satisfies ActionClick,
  {
    type: MODAL_SUBMIT, id: 'sub-req-1', callbackId: 'cb1',
    privateMetadata: '{"groupId":"grp-1"}',
    values: { q_0: { selection: { selectedOption: { value: '0' } } } },
    userId: 'cortex-tui',
  } satisfies ModalSubmit,

  // --- Transcript replay (S→C, no own seq) ---
  {
    type: TRANSCRIPT_REPLAY, sessionId: 'sess-001',
    items: [REPLAY_CHILD_POST, REPLAY_CHILD_UPDATE, REPLAY_CHILD_INTERACTIVE],
    seqStart: 10, seqEnd: 12, isCatchUp: true,
  } satisfies TranscriptReplay,

  // --- Notification (S→C) ---
  {
    type: NOTIFICATION, kind: 'project-report',
    projectId: 'cortex-self', sessionId: 'sess-other',
    title: 'Scheduled report', body: 'Daily scan complete',
    ref: REF, seq: 15,
  } satisfies Notification,

  // --- UI side-channel ---
  {
    type: UI_QUERY, id: 'q1', scope: 'projects.list', params: { resumable: true },
  } satisfies UiQuery,
  {
    type: UI_QUERY_RESULT, id: 'q1', ok: true, data: [{ id: 'cortex-self' }],
  } satisfies UiQueryResult,
  {
    type: UI_QUERY_RESULT, id: 'q2', ok: false,
    error: { code: 'invalid-args', message: 'bad scope' },
  } satisfies UiQueryResult,
  {
    type: UI_MUTATE, id: 'm1', op: 'schedules.pause', args: { scheduleId: 'sch-1' },
  } satisfies UiMutate,
  {
    type: UI_MUTATE_RESULT, id: 'm1', ok: true, data: { paused: true },
  } satisfies UiMutateResult,
  {
    type: UI_MUTATE_RESULT, id: 'm2', ok: false,
    error: { code: 'task-lock-busy', message: 'held by another agent' },
  } satisfies UiMutateResult,
  {
    type: UI_SUBSCRIBE, id: 'sub1',
    filter: { events: ['task.completed', 'thread.completed'], projectId: 'cortex-self' },
  } satisfies UiSubscribe,
  {
    type: UI_EVENT, id: 'sub1',
    event: { type: 'task.completed', ts: '2026-05-26T05:00:00Z', payload: { taskId: 'abcd' } },
    seq: 16,
  } satisfies UiEvent,
  { type: UI_UNSUBSCRIBE, id: 'sub1' } satisfies UiUnsubscribe,

  // --- Error (S→C, no seq) ---
  {
    type: ERROR, code: 4002, message: 'unknown frame type',
    refId: 'msg-req-99', closeAfter: false,
  } satisfies ErrorFrame,
];

// ── Group 1: Round-trip per frame type ──

for (const frame of REPRESENTATIVE_FRAMES) {
  // Disambiguate the two UiQueryResult / UiMutateResult variants by `ok`
  const tag = ('ok' in frame) ? `${frame.type} (ok=${(frame as { ok: boolean }).ok})` : frame.type;
  test(`round-trip: ${tag}`, () => {
    const encoded = encodeFrame(frame);
    const decoded = parseFrame(encoded);
    assert.ok(decoded !== null, `parseFrame returned null for ${tag}`);
    assert.deepEqual(decoded, frame);
  });
}

// ── Group 2: Negative tests ──

test('parseFrame returns null for empty string', () => {
  assert.equal(parseFrame(''), null);
});

test('parseFrame returns null for malformed JSON', () => {
  assert.equal(parseFrame('{not json}'), null);
});

test('parseFrame returns null for non-object JSON', () => {
  assert.equal(parseFrame('null'), null);
  assert.equal(parseFrame('"string"'), null);
  assert.equal(parseFrame('42'), null);
});

test('parseFrame returns null when type field is missing', () => {
  assert.equal(parseFrame('{}'), null);
  assert.equal(parseFrame('{"protocolVersion":1}'), null);
});

test('parseFrame returns null when type is not a string', () => {
  assert.equal(parseFrame('{"type":123}'), null);
  assert.equal(parseFrame('{"type":null}'), null);
});

test('parseFrame returns null for unknown discriminator', () => {
  assert.equal(parseFrame('{"type":"unknown.type"}'), null);
  assert.equal(parseFrame('{"type":"handshake.unknown"}'), null);
});

test('parseFrame returns null when required field is missing', () => {
  // ChatPost requires ref, content, seq
  assert.equal(parseFrame('{"type":"chat.post"}'), null);
  assert.equal(parseFrame('{"type":"chat.post","ref":{}}'), null);
  assert.equal(parseFrame('{"type":"chat.post","ref":{},"content":{"text":"x"}}'), null);
  // ModalOpen requires triggerId, modal, seq
  assert.equal(parseFrame('{"type":"modal.open"}'), null);
  assert.equal(parseFrame('{"type":"modal.open","triggerId":"t"}'), null);
  // HandshakeHello requires protocolVersion + clientName + clientVersion
  assert.equal(parseFrame('{"type":"handshake.hello"}'), null);
  assert.equal(parseFrame('{"type":"handshake.hello","protocolVersion":1}'), null);
  // MsgUser requires id + text (attachments / threadAnchorId optional)
  assert.equal(parseFrame('{"type":"msg.user"}'), null);
  assert.equal(parseFrame('{"type":"msg.user","id":"x"}'), null);
  // Error requires code + message
  assert.equal(parseFrame('{"type":"error"}'), null);
  // UiSubscribe requires id + filter
  assert.equal(parseFrame('{"type":"ui.subscribe","id":"x"}'), null);
});

test('parseFrame rejects null on required nullable fields (treats null as absent)', () => {
  // 'ref' is required; explicitly null should fail (matches "not present" semantics)
  assert.equal(parseFrame('{"type":"chat.post","ref":null,"content":{"text":"x"},"seq":0}'), null);
});

// ── Group 3: Modal submit values round-trip (matches ModalSubmitContext.values shape) ──

test('modal.submit values round-trip matches ModalSubmitContext.values shape', () => {
  const frame: ModalSubmit = {
    type: MODAL_SUBMIT,
    id: 'sub-1',
    callbackId: 'ask_user_question_modal_submit',
    values: {
      q_0: { selection: { selectedOption: { value: '0' } } },
      b_text: { input: { value: 'some text' } },
      b_multi: { picks: { selectedOptions: [{ value: 'a' }, { value: 'b' }] } },
    },
    privateMetadata: JSON.stringify({ groupId: 'grp-1' }),
    userId: 'cortex-tui',
  };

  const encoded = encodeFrame(frame);
  const decoded = parseFrame(encoded);
  assert.ok(decoded !== null, 'parseFrame returned null for modal.submit');
  assert.equal(decoded.type, MODAL_SUBMIT);

  const submit = decoded as ModalSubmit;
  assert.equal(submit.id, 'sub-1');
  assert.equal(submit.callbackId, 'ask_user_question_modal_submit');
  assert.equal(submit.userId, 'cortex-tui');
  assert.equal(submit.values.q_0.selection.selectedOption?.value, '0');
  assert.equal(submit.values.b_text.input.value, 'some text');
  assert.equal(submit.values.b_multi.picks.selectedOptions?.[0]?.value, 'a');
  assert.equal(submit.values.b_multi.picks.selectedOptions?.[1]?.value, 'b');
  assert.equal(submit.privateMetadata, JSON.stringify({ groupId: 'grp-1' }));
});

// ── Group 4: Guard discrimination ──

test('specific guard narrowing (type narrowing safety under --strict)', () => {
  const f: TuiFrame = {
    type: HANDSHAKE_HELLO, protocolVersion: 1,
    clientName: 'c', clientVersion: '0.1',
  };

  assert.ok(isHandshakeHello(f));
  assert.ok(!isChatPost(f));
  assert.ok(!isErrorFrame(f));
  assert.ok(!isNotification(f));
  assert.ok(!isModalOpen(f));

  if (isHandshakeHello(f)) {
    // After narrowing, the compiler knows f.clientName / f.protocolVersion exist
    assert.equal(f.protocolVersion, 1);
    assert.equal(f.clientName, 'c');
  } else {
    assert.fail('should have narrowed to HandshakeHello');
  }
});
