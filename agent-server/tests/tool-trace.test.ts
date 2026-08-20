// input:  Vitest, MockAdapter, OutputStream, runtime settings
// output: tool-trace gating, grouping, ordering, and flush regressions
// pos:    Covers runtime enablement and mutable-tail behavior
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { MockAdapter } from '../src/platform/testing.js';
import {
  SlackOutputStream,
  _testSetRetryDelays,
  _testResetRetryDelays,
} from '../src/platform/adapters/slack-output-stream.js';
import type { Destination, OutputStream } from '../src/platform/index.js';
import { ToolTrace, createToolTrace, isToolTraceEnabled } from '../src/platform/tool-trace.js';
import { resetSettingsForTests } from '../src/core/settings.js';

function testDest(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel, sessionId: '' };
}

async function settle(stream: OutputStream): Promise<void> {
  await stream.flush();
  await new Promise(resolve => setImmediate(resolve));
  await stream.flush();
}

beforeEach(() => { _testSetRetryDelays([0, 0, 0, 0]); });
afterEach(() => { _testResetRetryDelays(); });

test('isToolTraceEnabled: gated by CORTEX_SHOW_TOOL_CALLS', async () => {
  const prev = process.env.CORTEX_SHOW_TOOL_CALLS;
  try {
    delete process.env.CORTEX_SHOW_TOOL_CALLS;
    resetSettingsForTests();
    assert.equal(isToolTraceEnabled(), false);
    process.env.CORTEX_SHOW_TOOL_CALLS = '0';
    resetSettingsForTests();
    assert.equal(isToolTraceEnabled(), false);
    process.env.CORTEX_SHOW_TOOL_CALLS = '1';
    resetSettingsForTests();
    assert.equal(isToolTraceEnabled(), true);
    process.env.CORTEX_SHOW_TOOL_CALLS = 'true';
    resetSettingsForTests();
    assert.equal(isToolTraceEnabled(), true);
    process.env.CORTEX_SHOW_TOOL_CALLS = 'yes';
    resetSettingsForTests();
    assert.equal(isToolTraceEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CORTEX_SHOW_TOOL_CALLS;
    else process.env.CORTEX_SHOW_TOOL_CALLS = prev;
    resetSettingsForTests();
  }
});

test('createToolTrace returns null when disabled or stream missing', async () => {
  const prev = process.env.CORTEX_SHOW_TOOL_CALLS;
  try {
    const adapter = new MockAdapter();
    const stream = new SlackOutputStream(adapter as any, testDest('C1'));
    delete process.env.CORTEX_SHOW_TOOL_CALLS;
    resetSettingsForTests();
    assert.equal(createToolTrace(stream), null);
    process.env.CORTEX_SHOW_TOOL_CALLS = '1';
    resetSettingsForTests();
    assert.equal(createToolTrace(null), null);
    const trace = createToolTrace(stream);
    assert.ok(trace instanceof ToolTrace);
  } finally {
    if (prev === undefined) delete process.env.CORTEX_SHOW_TOOL_CALLS;
    else process.env.CORTEX_SHOW_TOOL_CALLS = prev;
    resetSettingsForTests();
  }
});

test('ToolTrace groups repeated tools through one mutable stream tail', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as any, testDest('C1'));
  const trace = new ToolTrace(stream);

  trace.onToolUse('Read', { file_path: 'a.ts' });
  trace.onToolUse('Read', { file_path: 'b.ts' });
  trace.onToolUse('Read', { file_path: 'c.ts' });
  await settle(stream);

  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.updated.length, 2);
  const final = adapter.updated.at(-1)!.content.text as string;
  assert.match(final, /Read .*×3/);
  assert.match(final, /a\.ts/);
  assert.match(final, /b\.ts/);
  assert.match(final, /c\.ts/);
});

test('ToolTrace preserves tool and assistant event order', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as any, testDest('C1'));
  const trace = new ToolTrace(stream);

  trace.onToolUse('Read', { file_path: 'a.ts' });
  stream.emitText('assistant reply');
  trace.onToolUse('Bash', { command: 'ls' });
  await settle(stream);

  const final = adapter.updated.at(-1)!.content.text as string;
  const readIndex = final.indexOf('Read');
  const textIndex = final.indexOf('assistant reply');
  const bashIndex = final.indexOf('Bash');
  assert.ok(readIndex >= 0 && readIndex < textIndex && textIndex < bashIndex);
});

test('ToolTrace flush starts a new group without creating another post', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as any, testDest('C1'));
  const trace = new ToolTrace(stream);

  trace.onToolUse('Read', { file_path: 'a.ts' });
  await settle(stream);
  trace.flush();
  trace.onToolUse('Read', { file_path: 'b.ts' });
  await settle(stream);

  assert.equal(adapter.posted.length, 1);
  const final = adapter.updated.at(-1)!.content.text as string;
  assert.equal(final.match(/Read .*×1/g)?.length, 2);
  assert.match(final, /a\.ts/);
  assert.match(final, /b\.ts/);
});
