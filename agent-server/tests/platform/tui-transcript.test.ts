// input:  buildTranscriptReplay (pure formatter) + ports types
// output: unit tests — message-based transcript replay as a pure function
// pos:    verifies TranscriptData (message stream) → TranscriptReplay | null

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildTranscriptReplay } from '../../src/platform/adapters/tui/tui-transcript.js';
import type { TranscriptData, TranscriptMessage } from '../../src/platform/adapters/tui/ports.js';

function makeData(messages: TranscriptMessage[]): TranscriptData {
  return { sessionId: 'sess-1', messages };
}

test('maps user / assistant / tool messages into ChatPost items', () => {
  const data = makeData([
    { role: 'user', text: 'First user message' },
    { role: 'tool', text: '', toolName: 'Read', toolInput: 'foo.ts' },
    { role: 'assistant', text: 'an answer' },
    { role: 'user', text: 'Second' },
    { role: 'assistant', text: 'reply 2' },
  ]);
  const result = buildTranscriptReplay(data)!;

  assert.equal(result.type, 'transcript.replay');
  assert.equal(result.sessionId, 'sess-1');
  assert.equal(result.isCatchUp, true);
  assert.equal(result.items.length, 5);
  assert.equal(result.seqStart, 1);
  assert.equal(result.seqEnd, 5);

  // user → "**You:** ..."
  assert.equal(result.items[0].content.text, '**You:** First user message');
  assert.equal(result.items[0].ref.messageId, 'sess-1-0');
  // tool → dim context block, empty text
  assert.equal(result.items[1].content.text, '');
  assert.equal((result.items[1].content as any).richBlocks[0].type, 'context');
  assert.match((result.items[1].content as any).richBlocks[0].text, /Read/);
  assert.match((result.items[1].content as any).richBlocks[0].text, /foo\.ts/);
  // assistant → plain text (real reply, no placeholder)
  assert.equal(result.items[2].content.text, 'an answer');
  assert.equal(result.items[4].content.text, 'reply 2');
});

test('returns null when there are no messages', () => {
  assert.equal(buildTranscriptReplay(makeData([])), null);
});

test('assistant messages carry their real text (no "(response)" placeholder)', () => {
  const result = buildTranscriptReplay(makeData([
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello **world**' },
  ]))!;
  assert.equal(result.items[1].content.text, 'hello **world**');
  assert.equal((result.items[1].content.text as string).includes('(response)'), false);
});
