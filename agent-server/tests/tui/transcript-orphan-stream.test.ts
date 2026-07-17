// input:  src/tui/hooks/useTranscript.js (pure state helpers)
// output: Regression: streamed reply must not be dropped on an empty transcript
// pos:    Verifies orphan stream frames create a synthetic message instead of vanishing

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  _handleStreamText, _handleStreamMutableOpen, _appendUserMessage,
} from '../../src/tui/hooks/useTranscript.js';

const EMPTY = { messages: new Map(), ids: [] as string[] };

test('stream.text on empty transcript creates a synthetic message keyed by streamId', () => {
  const s = _handleStreamText(EMPTY, { type: 'stream.text' as const, streamId: 's1', text: 'hi', seq: 1 });
  assert.equal(s.ids.length, 1, 'a message must exist to hold the stream');
  const msg = s.messages.get(s.ids[0]);
  assert.ok(msg);
  assert.equal(msg.streams.get('s1')?.blocks.map(b => b.text).join(''), 'hi');
});

test('stream.mutableOpen on empty transcript creates a synthetic message', () => {
  const s = _handleStreamMutableOpen(EMPTY, {
    type: 'stream.mutableOpen' as const, streamId: 's1', regionId: 'r1', text: 'pending', seq: 1,
  });
  assert.equal(s.ids.length, 1);
  const msg = s.messages.get(s.ids[0]);
  assert.ok(msg);
  assert.equal(msg.streams.get('s1')?.blocks.find(b => b.kind === 'region' && b.regionId === 'r1')?.text, 'pending');
});

test('_appendUserMessage adds a "**You:** …" row flagged isUser', () => {
  const s = _appendUserMessage(EMPTY, 'hello there');
  assert.equal(s.ids.length, 1);
  const msg = s.messages.get(s.ids[0]);
  assert.ok(msg);
  assert.equal(msg.text, '**You:** hello there');
  assert.equal(msg.isUser, true);
});

test('assistant stream does NOT merge into the last message when it is a user echo', () => {
  const withUser = _appendUserMessage(EMPTY, 'my question');
  const s = _handleStreamText(withUser, { type: 'stream.text' as const, streamId: 's1', text: 'answer', seq: 1 });
  assert.equal(s.ids.length, 2, 'a separate synthetic message holds the reply');
  const userMsg = s.messages.get(s.ids[0]);
  const replyMsg = s.messages.get(s.ids[1]);
  assert.equal(userMsg?.streams.size, 0, 'user bubble has no stream attached');
  assert.equal(replyMsg?.streams.get('s1')?.blocks.map(b => b.text).join(''), 'answer');
});

test('assistant stream DOES attach to a non-user last message (assistant anchor)', () => {
  const prev = {
    messages: new Map([['m1', { messageId: 'm1', text: 'prior', queued: false, streams: new Map() }]]),
    ids: ['m1'],
  };
  const s = _handleStreamText(prev as any, { type: 'stream.text' as const, streamId: 's1', text: 'more', seq: 1 });
  assert.equal(s.ids.length, 1, 'attaches in place, no new message');
  assert.equal(s.messages.get('m1')?.streams.get('s1')?.blocks.map(b => b.text).join(''), 'more');
});
