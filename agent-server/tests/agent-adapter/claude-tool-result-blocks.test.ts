// input:  `user` stdout lines carrying tool_result blocks whose content is not plain text
// output: the string the turn machine hands every sink (transcript row, subagent notice, capture)
// pos:    tests/agent-adapter — regression for the image-read transcript blowup: a `Read` on an
//         image used to be JSON.stringify'd whole, putting ~0.5 MB of base64 into the tool_result
//         event (and from there into the debug transcript, the parent session's notice stream and
//         the capture log).
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { _test } from '../../src/agent-adapter/claude/adapter.js';

const FAKE_STREAM = { write() {}, end() {} } as any;

function sessionCapturing(results: string[], t: { onTestFinished: (fn: () => void) => void }) {
  const s: any = _test.makeSessionForTest();
  s.createTurnStreams = () => ({ rawStream: FAKE_STREAM, txtStream: FAKE_STREAM });
  t.onTestFinished(() => s.close());
  s.currentTurn = {
    resolve: () => {}, reject: () => {},
    resultData: null, planFilePath: null, enteredPlanMode: false, exitedPlanMode: false,
    askUserQuestions: [], finalOutput: null, longestOutput: null, turnCount: 0, subagentTurnCount: 0,
    onProgress: null, onAssistantMessage: null, onAssistantDelta: null, onToolUse: null,
    onToolResult: (_toolUseId: string, content: string) => { results.push(content); },
    onCompact: null, onContextUsage: null, onSubagentActivity: null,
    rawStream: FAKE_STREAM, txtStream: FAKE_STREAM, killed: false,
  };
  return s;
}

function resultLine(content: unknown): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] },
  });
}

test('an image tool_result is described by mime and size, never serialized', (t) => {
  const results: string[] = [];
  const s = sessionCapturing(results, t);
  const data = 'A'.repeat(400_000); // ~300 KB of "base64"

  s.handleLine(resultLine([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }]));

  assert.equal(results.length, 1);
  assert.equal(results[0], '[image/jpeg, 293 KB]');
  assert.ok(!results[0].includes('AAAA'), 'the payload must not reach the transcript');
});

test('text blocks still pass through, and mix with a described image', (t) => {
  const results: string[] = [];
  const s = sessionCapturing(results, t);

  s.handleLine(resultLine([
    { type: 'text', text: 'Read image file' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(2048) } },
  ]));

  assert.deepEqual(results, ['Read image file\n[image/png, 2 KB]']);
});

test('a plain text tool_result is unchanged, as a string or as text blocks', (t) => {
  const results: string[] = [];
  const s = sessionCapturing(results, t);

  s.handleLine(resultLine('plain output'));
  s.handleLine(resultLine([{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }]));

  assert.deepEqual(results, ['plain output', 'line 1\nline 2']);
});

test('a url-sourced image and a document carry their identity, not their bytes', (t) => {
  const results: string[] = [];
  const s = sessionCapturing(results, t);

  s.handleLine(resultLine([{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }]));
  s.handleLine(resultLine([{
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: 'C'.repeat(1_400_000) },
  }]));

  assert.deepEqual(results, ['[image, https://example.com/a.png]', '[application/pdf, 1.0 MB]']);
});

test('an unknown block is truncated instead of dumped whole', (t) => {
  const results: string[] = [];
  const s = sessionCapturing(results, t);

  s.handleLine(resultLine([{ type: 'mystery', blob: 'D'.repeat(50_000) }]));

  assert.equal(results.length, 1);
  assert.ok(results[0].length < 1200, `expected a truncated line, got ${results[0].length} chars`);
  assert.match(results[0], /more chars\]$/);
});
