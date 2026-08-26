// input:  transcript recorder, fake history, DEBUG gate
// output: prompt, ownership, notice, tool, and result tests
// pos:    Thread-step transcript recorder tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

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
    appendToolResult: async (sessionId, opts) => { calls.push({ fn: 'tool-result', sessionId, arg: opts }); },
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

test('DEBUG recorder preserves the complete step prompt, tool input, result, and update ordering', async (t) => {
  const previous = process.env.DEBUG;
  process.env.DEBUG = '1';
  t.onTestFinished(() => {
    if (previous === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = previous;
  });
  const { writer, calls } = makeFakeHistory();
  const debugUpdates: string[] = [];
  const rec = createStepTranscriptRecorder(writer, 'track-debug', undefined, () => debugUpdates.push('updated'));
  rec.recordUser('full step prompt\nwith context');
  rec.recordTool('Bash', { command: 'echo complete', timeout: 120000 }, 'toolu-thread');
  rec.recordToolResult('toolu-thread', 'complete\nresult', true);
  await rec.settle();

  assert.equal(calls[0].arg.agentMessage, 'full step prompt\nwith context');
  assert.deepEqual(calls[1].arg.fullInput, { command: 'echo complete', timeout: 120000 });
  assert.equal(calls[1].arg.toolUseId, 'toolu-thread');
  assert.deepEqual(calls[2].arg, { toolUseId: 'toolu-thread', content: 'complete\nresult', isError: true });
  assert.deepEqual(debugUpdates, ['updated', 'updated', 'updated'], 'prompt, tool input, and result refresh only after each DEBUG append settles');
});

test('recorder preserves subagent spawns and child ownership in history and live publish', async () => {
  const { writer, calls } = makeFakeHistory();
  const published: PersistedTranscriptEvent[] = [];
  const rec = createStepTranscriptRecorder(writer, 'track-subagent', (ev) => published.push(ev));
  const prompt = 'Map the thread path.\nKeep all details.';

  rec.recordTool('Agent', {
    description: 'Map thread path', prompt, subagent_type: 'explore',
  }, 'toolu-parent');
  rec.recordAssistant('child notes', undefined, {
    parentToolUseId: 'toolu-parent', type: 'explore', description: 'Map thread path', model: 'model-x',
  });
  await rec.settle();

  assert.deepEqual(calls[0].arg.subagentSpawns, [{
    id: 'toolu-parent', type: 'explore', description: 'Map thread path', prompt,
  }]);
  assert.deepEqual(published[0].subagentSpawns, calls[0].arg.subagentSpawns);
  assert.equal(calls[0].arg.subagent.id, 'toolu-parent', 'old clients retain the single-spawn anchor id');
  assert.equal(published[0].subagentId, 'toolu-parent');
  assert.equal(calls[1].arg.subagent.id, 'toolu-parent');
  assert.equal(published[1].subagentId, 'toolu-parent');
  assert.equal(published[1].subagentModel, 'model-x');
});

test('recorder preserves warning level in history and live publish', async () => {
  const { writer, calls } = makeFakeHistory();
  const published: PersistedTranscriptEvent[] = [];
  const rec = createStepTranscriptRecorder(writer, 'track-warning', (ev) => published.push(ev));

  rec.recordAssistant('Model fallback: from → to.', 'warning');
  rec.recordAssistant('continued');
  await rec.settle();

  assert.equal(calls[0].arg.noticeLevel, 'warning');
  assert.equal(calls[1].arg.noticeLevel, undefined);
  assert.equal(published[0].noticeLevel, 'warning');
  assert.equal(published[1].noticeLevel, undefined);
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
    appendToolResult: async () => { await gate; },
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
    appendToolResult: async (sessionId, opts) => { calls.push({ fn: 'tool-result', sessionId, arg: opts }); },
  };
  const rec = createStepTranscriptRecorder(writer, 'track-4');
  rec.recordUser('p');
  rec.recordAssistant('boom');
  rec.recordTool('Bash', { command: 'echo hi' });
  await rec.settle(); // must not throw
  assert.deepEqual(calls.map((c) => c.fn), ['user', 'tool'], 'failed append skipped, later events persisted');
});
