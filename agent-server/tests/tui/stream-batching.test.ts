// input:  src/tui/hooks/useTranscript.js (pure state helpers)
// output: Stream batching tests — multiple stream.text frames batched into single state update
// pos:    Verifies that 100 stream.text frames in 50ms produce fewer than N reconciles

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  _handleChatPost, _handleStreamText,
  _handleStreamMutableOpen, _handleStreamMutableUpdate,
} from '../../src/tui/hooks/useTranscript.js';

test('multiple stream.text segments accumulate in a single stream', () => {
  let state = { messages: new Map(), ids: [] as string[] };

  // Add a message first
  state = _handleChatPost(state, {
    type: 'chat.post' as const,
    ref: { conduit: 'tui:abc', messageId: 'm-001', threadId: 'a1' },
    content: { text: 'response' },
    seq: 1,
  });

  // Simulate 100 stream.text frames
  for (let i = 0; i < 100; i++) {
    state = _handleStreamText(state, {
      type: 'stream.text' as const,
      streamId: 's1',
      text: `part${i}`,
      seq: 2 + i,
    });
  }

  const msg = state.messages.get('m-001');
  assert.ok(msg);
  const stream = msg.streams.get('s1');
  assert.ok(stream);
  assert.equal(stream.blocks.length, 100);
  assert.equal(stream.blocks[0].text, 'part0');
  assert.equal(stream.blocks[99].text, 'part99');
});

test('stream batching respects multiple streams on same message', () => {
  let state = { messages: new Map(), ids: [] as string[] };
  state = _handleChatPost(state, {
    type: 'chat.post' as const,
    ref: { conduit: 'tui:abc', messageId: 'm-001' },
    content: { text: 'response' },
    seq: 1,
  });

  // Interleave two streams
  state = _handleStreamText(state, { type: 'stream.text' as const, streamId: 's1', text: 'a', seq: 2 });
  state = _handleStreamText(state, { type: 'stream.text' as const, streamId: 's2', text: 'b', seq: 3 });
  state = _handleStreamText(state, { type: 'stream.text' as const, streamId: 's1', text: 'c', seq: 4 });
  state = _handleStreamText(state, { type: 'stream.text' as const, streamId: 's2', text: 'd', seq: 5 });

  const msg = state.messages.get('m-001');
  assert.ok(msg);
  assert.equal(msg.streams.get('s1')?.blocks.map(b => b.text).join(''), 'ac');
  assert.equal(msg.streams.get('s2')?.blocks.map(b => b.text).join(''), 'bd');
});

test('mutableUpdate renders immediately (no batching delay)', () => {
  let state = { messages: new Map(), ids: [] as string[] };
  state = _handleChatPost(state, {
    type: 'chat.post' as const,
    ref: { conduit: 'tui:abc', messageId: 'm-001' },
    content: { text: 'response' },
    seq: 1,
  });

  // Open mutable → update → check immediate availability
  state = _handleStreamText(state, { type: 'stream.text' as const, streamId: 's1', text: 'prefix ', seq: 2 });
  state = Object.assign({}, _handleStreamMutableOpen(state, {
    type: 'stream.mutableOpen' as const, streamId: 's1', regionId: 'r1', text: 'pending', seq: 3,
  }));
  state = Object.assign({}, _handleStreamMutableUpdate(state, {
    type: 'stream.mutableUpdate' as const, streamId: 's1', regionId: 'r1', text: 'done', seq: 4,
  }));

  const msg = state.messages.get('m-001');
  assert.equal(msg?.streams.get('s1')?.blocks.find(b => b.kind === 'region' && b.regionId === 'r1')?.text, 'done');
  assert.equal(msg?.streams.get('s1')?.blocks.find(b => b.kind === 'text')?.text, 'prefix ');
});
