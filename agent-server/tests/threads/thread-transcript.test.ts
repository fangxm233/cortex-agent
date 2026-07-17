// input:  node:test, domain/threads/thread-transcript helpers
// output: unit coverage for createStepTranscriptBuffer + flushStepTranscript
// pos:    verifies thread steps record a full conversation-history transcript (buffer→flush)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  createStepTranscriptBuffer,
  flushStepTranscript,
  type HistoryWriter,
} from '../../src/domain/threads/thread-transcript.js';

interface Call { fn: string; sessionId: string; arg: any }

function makeFakeHistory(): { writer: HistoryWriter; calls: Call[] } {
  const calls: Call[] = [];
  const writer: HistoryWriter = {
    appendUser: async (sessionId, opts) => { calls.push({ fn: 'user', sessionId, arg: opts }); },
    appendAssistant: async (sessionId, opts) => { calls.push({ fn: 'assistant', sessionId, arg: opts }); },
    appendTool: async (sessionId, opts) => { calls.push({ fn: 'tool', sessionId, arg: opts }); },
  };
  return { writer, calls };
}

test('createStepTranscriptBuffer accumulates assistant + tool events in emission order', () => {
  const buf = createStepTranscriptBuffer();
  buf.recordAssistant('thinking...');
  buf.recordTool('Bash', { command: 'ls -la' });
  buf.recordAssistant('done');
  assert.equal(buf.events.length, 3);
  assert.deepEqual(buf.events[0], { role: 'assistant', text: 'thinking...' });
  assert.equal(buf.events[1].role, 'tool');
  assert.equal(buf.events[1].toolName, 'Bash');
  assert.equal(buf.events[1].toolInput, 'ls -la', 'tool input is summarized to its primary field');
  assert.deepEqual(buf.events[2], { role: 'assistant', text: 'done' });
});

test('flushStepTranscript writes the prompt as the opening user turn then the buffer in order', async () => {
  const { writer, calls } = makeFakeHistory();
  const buf = createStepTranscriptBuffer();
  buf.recordAssistant('a1');
  buf.recordTool('Read', { file_path: '/x.ts' });
  await flushStepTranscript(writer, 'sess-1', 'the step prompt', buf);

  assert.deepEqual(calls.map((c) => c.fn), ['user', 'assistant', 'tool']);
  assert.ok(calls.every((c) => c.sessionId === 'sess-1'), 'all keyed by the step sessionId');
  assert.equal(calls[0].arg.text, 'the step prompt');
  assert.equal(calls[1].arg.text, 'a1');
  assert.equal(calls[2].arg.toolName, 'Read');
  assert.equal(calls[2].arg.toolInput, '/x.ts');
});

test('flushStepTranscript records the user prompt even when the buffer is empty', async () => {
  const { writer, calls } = makeFakeHistory();
  const buf = createStepTranscriptBuffer();
  await flushStepTranscript(writer, 'sess-2', 'lonely prompt', buf);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'user');
  assert.equal(calls[0].arg.text, 'lonely prompt');
});

test('flushStepTranscript fires onEvent for every persisted event (live UI publish)', async () => {
  const { writer } = makeFakeHistory();
  const buf = createStepTranscriptBuffer();
  buf.recordAssistant('hi');
  buf.recordTool('Grep', { pattern: 'foo' });
  const published: string[] = [];
  await flushStepTranscript(writer, 'sess-3', 'p', buf, (ev) => published.push(ev.role));
  assert.deepEqual(published, ['user', 'assistant', 'tool']);
});
