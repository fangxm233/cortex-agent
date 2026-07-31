// input:  Vitest, MockAdapter, OutputStream, runtime settings
// output: tool-trace rendering and legacy env regressions
// pos:    Covers compact tool trace rendering and enablement
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { MockAdapter } from '../src/platform/testing.js';
import { SlackOutputStream, _testSetRetryDelays, _testResetRetryDelays } from '../src/platform/adapters/slack-output-stream.js';
import type { Destination, OutputStream } from '../src/platform/index.js';
import { ToolTrace, _test } from '../src/platform/tool-trace.js';

async function freshToolTrace() {
  vi.resetModules();
  return import('../src/platform/tool-trace.js');
}

function testDest(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel, sessionId: '' };
}

async function settle(stream: OutputStream) {
  // Drain both the stream's queue and any chained tool-trace updates.
  await stream.flush();
  // Give the tool-trace's internal queue a microtask tick to run handlers scheduled
  // after postInteractive resolved.
  await new Promise(resolve => setImmediate(resolve));
  await stream.flush();
}

beforeEach(() => { _testSetRetryDelays([0, 0, 0, 0]); });
afterEach(() => { _testResetRetryDelays(); });

test('isToolTraceEnabled: gated by CORTEX_SHOW_TOOL_CALLS', async () => {
  const prev = process.env.CORTEX_SHOW_TOOL_CALLS;
  try {
    delete process.env.CORTEX_SHOW_TOOL_CALLS;
    assert.equal((await freshToolTrace()).isToolTraceEnabled(), false);
    process.env.CORTEX_SHOW_TOOL_CALLS = '0';
    assert.equal((await freshToolTrace()).isToolTraceEnabled(), false);
    process.env.CORTEX_SHOW_TOOL_CALLS = '1';
    assert.equal((await freshToolTrace()).isToolTraceEnabled(), true);
    process.env.CORTEX_SHOW_TOOL_CALLS = 'true';
    assert.equal((await freshToolTrace()).isToolTraceEnabled(), true);
    process.env.CORTEX_SHOW_TOOL_CALLS = 'yes';
    assert.equal((await freshToolTrace()).isToolTraceEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CORTEX_SHOW_TOOL_CALLS;
    else process.env.CORTEX_SHOW_TOOL_CALLS = prev;
  }
});

test('createToolTrace returns null when disabled or stream missing', async () => {
  const prev = process.env.CORTEX_SHOW_TOOL_CALLS;
  try {
    const adapter = new MockAdapter();
    const stream = new SlackOutputStream(adapter as any, testDest('C1'));
    delete process.env.CORTEX_SHOW_TOOL_CALLS;
    assert.equal((await freshToolTrace()).createToolTrace(stream), null);
    process.env.CORTEX_SHOW_TOOL_CALLS = '1';
    const enabled = await freshToolTrace();
    assert.equal(enabled.createToolTrace(null), null);
    const trace = enabled.createToolTrace(stream);
    assert.ok(trace instanceof enabled.ToolTrace);
  } finally {
    if (prev === undefined) delete process.env.CORTEX_SHOW_TOOL_CALLS;
    else process.env.CORTEX_SHOW_TOOL_CALLS = prev;
  }
});

test('ToolTrace: consecutive same tool — 1 post + N-1 updates on main stream msg', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as any, testDest('C1'));
  const trace = new ToolTrace(stream);

  trace.onToolUse('Read', { file_path: '/repo/src/a.ts' });
  trace.onToolUse('Read', { file_path: '/repo/src/b.ts' });
  trace.onToolUse('Read', { file_path: '/repo/src/c.ts' });
  await settle(stream);

  assert.equal(adapter.posted.length, 1, 'a single message is posted (the main stream msg)');
  assert.equal(adapter.updated.length, 2, 'two in-place updates after the initial post');
  const final = adapter.updated[1].content.text;
  assert.match(final as string, /Read .*×3/);
  assert.match(final as string, /a\.ts/);
  assert.match(final as string, /b\.ts/);
  assert.match(final as string, /c\.ts/);
});

test('ToolTrace: different tool → tail is sealed and new tail opens (still 1 Slack msg)', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as any, testDest('C1'));
  const trace = new ToolTrace(stream);

  trace.onToolUse('Read', { file_path: 'a.ts' });
  trace.onToolUse('Bash', { command: 'ls' });
  trace.onToolUse('Read', { file_path: 'b.ts' });
  await settle(stream);

  assert.equal(adapter.posted.length, 1, 'one Slack post total');
  assert.ok(adapter.updated.length >= 2, 'tail rewritten for each new group');
  const final = adapter.updated[adapter.updated.length - 1].content.text as string;
  assert.match(final, /Read .*×1.*a\.ts/s, 'sealed Read a');
  assert.match(final, /Bash .*×1/s, 'sealed Bash ls');
  assert.match(final, /Read .*×1.*b\.ts/s, 'open Read b tail');
});

test('ToolTrace: flush() then same tool — tool-trace restarts group but stream tail auto-seals', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as any, testDest('C1'));
  const trace = new ToolTrace(stream);

  trace.onToolUse('Read', { file_path: 'a.ts' });
  await settle(stream);
  trace.flush();
  trace.onToolUse('Read', { file_path: 'b.ts' });
  await settle(stream);

  // Both tool lines live in the same Slack message (appended tail → edited tail).
  assert.equal(adapter.posted.length, 1);
  const final = adapter.updated[adapter.updated.length - 1].content.text as string;
  assert.match(final, /a\.ts/);
  assert.match(final, /b\.ts/);
});

test('ToolTrace: tool line is merged into main stream message via updates, not as a new post', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as any, testDest('C1'));
  const trace = new ToolTrace(stream);

  stream.emitText('hello');
  trace.onToolUse('Read', { file_path: 'a.ts' });
  await settle(stream);

  // Only the first `hello` creates a Slack message; the tool line is an update.
  assert.equal(adapter.posted.length, 1);
  assert.ok(adapter.updated.length >= 1);
  const last = adapter.updated[adapter.updated.length - 1].content.text as string;
  assert.match(last, /hello/);
  assert.match(last, /Read .*×1/);
});

test('ToolTrace: assistant text after tool seals the tail, subsequent tool appends new tail', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as any, testDest('C1'));
  const trace = new ToolTrace(stream);

  trace.onToolUse('Read', { file_path: 'a.ts' });
  // Tool-trace callers wrap onAssistantMessage with: trace.flush(); stream.emitText(text).
  trace.flush();
  stream.emitText('ok');
  trace.onToolUse('Bash', { command: 'ls' });
  await settle(stream);

  assert.equal(adapter.posted.length, 1, 'everything accumulates into one Slack message');
  const final = adapter.updated[adapter.updated.length - 1].content.text as string;
  assert.match(final, /Read .*×1.*a\.ts/s, 'Read group sealed as prefix');
  assert.match(final, /ok/, 'assistant text in middle');
  assert.match(final, /Bash .*×1.*ls/s, 'Bash group opened as new tail');
});

test('renderToolLine: strips MCP prefix and truncates', () => {
  const short = _test.renderToolLine('mcp__cortex__remote_read', ['lab:/etc/hostname']);
  assert.match(short, /remote_read/);
  assert.doesNotMatch(short, /mcp__/);

  const many = Array.from({ length: 50 }, (_, i) => `file_${i}.ts`);
  const line = _test.renderToolLine('Read', many);
  assert.ok(line.length <= 130, `line length ${line.length} under truncation cap`);
  assert.match(line, /\+\d+…$/, 'ends with "+N…" tail when truncated');
});

test('summarizeToolInput: Bash takes first line of command', () => {
  const s = _test.summarizeToolInput('Bash', { command: 'echo hi\necho bye' });
  assert.equal(s, 'echo hi');
});

test('ToolTrace: tool_use before text in same tick preserves Slack order', async () => {
  // Regression for the ordering bug: within one assistant event with
  // content = [tool_use, text], the tool line must appear BEFORE the text
  // in the final Slack message content (model emitted the tool first).
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as any, testDest('C1'));
  const trace = new ToolTrace(stream);

  // Simulate claude-bridge's sync block iteration for [tool_use Read a, text "hi"]:
  trace.onToolUse('Read', { file_path: 'a.ts' });
  stream.emitText('hi');
  await settle(stream);

  assert.equal(adapter.posted.length, 1, 'single merged Slack message');
  const final = adapter.updated.length > 0
    ? (adapter.updated[adapter.updated.length - 1].content.text as string)
    : (adapter.posted[0].content.text as string);
  const toolIdx = final.search(/Read/);
  const textIdx = final.indexOf('hi');
  assert.ok(toolIdx >= 0 && textIdx > toolIdx, `tool line must precede text — got: ${JSON.stringify(final)}`);
});
