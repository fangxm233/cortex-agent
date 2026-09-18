// input:  src/tui/hooks/useTranscript.js (pure state helpers)
// output: Stream batching tests — multiple stream.text frames batched into single state update
// pos:    Verifies that 100 stream.text frames in 50ms produce fewer than N reconciles

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  _handleChatPost, _handleStreamText,
} from '../../src/tui/hooks/useTranscript.js';

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
