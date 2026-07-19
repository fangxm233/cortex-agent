// input:  node:test, domain/threads/thread-transcript helpers
// output: unit coverage for createStepTranscriptRecorder (live per-event append + publish)
// pos:    verifies thread steps record conversation-history INCREMENTALLY (per event, shared ts)
//         so the web UI can render a running step's transcript (snapshot) + live stream (delta)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  createStepTranscriptRecorder,
  type HistoryWriter,
  type PersistedTranscriptEvent,
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

test('recorder appends user/assistant/tool incrementally, in order, keyed by the track sessionId', async () => {
  const { writer, calls } = makeFakeHistory();
  const rec = createStepTranscriptRecorder(writer, 'track-1');
  rec.recordUser('the step prompt');
  rec.recordAssistant('thinking...');
  rec.recordTool('Bash', { command: 'ls -la' });
  rec.recordAssistant('done');
  await rec.settle();

  assert.deepEqual(calls.map((c) => c.fn), ['user', 'assistant', 'tool', 'assistant']);
  assert.ok(calls.every((c) => c.sessionId === 'track-1'), 'all keyed by the track sessionId');
  assert.equal(calls[0].arg.text, 'the step prompt');
  assert.equal(calls[1].arg.text, 'thinking...');
  assert.equal(calls[2].arg.toolName, 'Bash');
  assert.equal(calls[2].arg.toolInput, 'ls -la', 'tool input is summarized to its primary field');
  assert.equal(calls[3].arg.text, 'done');
});

test('recorder shares one ts per event between the history append and the live publish (web de-dup contract)', async () => {
  const { writer, calls } = makeFakeHistory();
  const published: PersistedTranscriptEvent[] = [];
  const rec = createStepTranscriptRecorder(writer, 'track-2', (ev) => published.push(ev));
  rec.recordUser('p');
  rec.recordAssistant('a');
  rec.recordTool('Read', { file_path: '/x.ts' });
  await rec.settle();

  assert.equal(published.length, 3);
  assert.deepEqual(published.map((e) => e.role), ['user', 'assistant', 'tool']);
  for (let i = 0; i < 3; i++) {
    assert.ok(published[i].ts, `event ${i} carries a ts`);
    assert.equal(published[i].ts, calls[i].arg.ts, `event ${i} ts matches the persisted ts`);
  }
});

test('recorder publishes live events synchronously in emission order even while history writes are slow', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const writer: HistoryWriter = {
    appendUser: async () => { await gate; },
    appendAssistant: async () => { await gate; },
    appendTool: async () => { await gate; },
  };
  const published: string[] = [];
  const rec = createStepTranscriptRecorder(writer, 'track-3', (ev) => published.push(ev.role));
  rec.recordUser('p');
  rec.recordAssistant('a1');
  rec.recordTool('Grep', { pattern: 'foo' });
  // No await: publishes must have fired already even though no write completed yet.
  assert.deepEqual(published, ['user', 'assistant', 'tool']);
  release();
  await rec.settle();
});

test('a failing history write does not reject settle and later events still append', async () => {
  const calls: Call[] = [];
  const writer: HistoryWriter = {
    appendUser: async (sessionId, opts) => { calls.push({ fn: 'user', sessionId, arg: opts }); },
    appendAssistant: async () => { throw new Error('disk full'); },
    appendTool: async (sessionId, opts) => { calls.push({ fn: 'tool', sessionId, arg: opts }); },
  };
  const rec = createStepTranscriptRecorder(writer, 'track-4');
  rec.recordUser('p');
  rec.recordAssistant('boom');
  rec.recordTool('Bash', { command: 'echo hi' });
  await rec.settle(); // must not throw
  assert.deepEqual(calls.map((c) => c.fn), ['user', 'tool'], 'failed append skipped, later events persisted');
});
