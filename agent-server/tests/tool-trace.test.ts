// input:  Vitest, MockAdapter, OutputStream, runtime settings
// output: platform prompt visibility, grouping, ordering, and trace tests
// pos:    Covers runtime enablement and mutable-tail behavior
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { MockAdapter, MockOutputStream } from '../src/platform/testing.js';
import {
  SlackOutputStream,
  _testSetRetryDelays,
  _testResetRetryDelays,
} from '../src/platform/adapters/slack-output-stream.js';
import type { Destination, OutputStream } from '../src/platform/index.js';
import { ToolTrace, createToolTrace, isToolTraceEnabled } from '../src/platform/tool-trace.js';
import { resetSettingsForTests } from '../src/core/settings.js';
import { subagentSpawnsFromToolCall } from '../src/agent-adapter/normalize/event-types.js';

function testDest(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel, sessionId: '' };
}

async function settle(stream: OutputStream): Promise<void> {
  await stream.flush();
  await new Promise(resolve => setImmediate(resolve));
  await stream.flush();
}

test('subagent spawn parser preserves exact prompts and backend child ids', () => {
  assert.deepEqual(subagentSpawnsFromToolCall('Agent', {
    description: 'one', prompt: 'line 1\nline 2', subagent_type: 'explore', model: 'model-a',
  }, 'tu_claude'), [{
    id: 'tu_claude', type: 'explore', description: 'one', prompt: 'line 1\nline 2', requestedModel: 'model-a',
  }]);
  assert.deepEqual(subagentSpawnsFromToolCall('agent', {
    chain: [
      { description: 'first', prompt: 'Begin with {previous}', subagent_type: 'explore' },
      { description: 'second', prompt: '{previous}\nfinish', subagent_type: 'reviewer' },
    ],
  }, 'tu_pi').map((spawn) => ({ id: spawn.id, prompt: spawn.prompt })), [
    { id: 'tu_pi#0', prompt: 'Begin with ' },
  ], 'only the definitely-started first chain child is announced at call time');
  assert.deepEqual(subagentSpawnsFromToolCall('agent', { parallel: ['bad', null] }, 'tu_bad'), []);
  assert.deepEqual(
    subagentSpawnsFromToolCall('mcp__third_party__agent', { prompt: 'private MCP input' }, 'tu_mcp'),
    [],
    'an MCP tool named agent is not a native subagent spawn',
  );
});

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

test('ToolTrace folds a subagent\'s calls into one live line per spawning call', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as any, testDest('C1'));
  const trace = new ToolTrace(stream);

  // The main agent spawns two subagents in one batch: both lines appear at zero immediately.
  trace.onToolUse('Agent', { description: 'map the event flow', subagent_type: 'explore' }, undefined, 'tu_a');
  trace.onToolUse('Agent', { description: 'review the diff', subagent_type: 'reviewer' }, undefined, 'tu_b');
  // Their calls interleave, as parallel subagents' calls do.
  trace.onToolUse('Grep', { pattern: 'x' }, { parentToolUseId: 'tu_a', type: 'explore', description: 'map the event flow' });
  trace.onToolUse('Read', { file_path: 'a.ts' }, { parentToolUseId: 'tu_b', type: 'reviewer', description: 'review the diff' });
  trace.onToolUse('Read', { file_path: 'b.ts' }, { parentToolUseId: 'tu_a', type: 'explore', description: 'map the event flow' });
  await settle(stream);

  // One line for the whole batch — interleaving must not tear it into a line per switch.
  assert.equal(adapter.posted.length, 1);
  const final = adapter.updated.at(-1)!.content.text as string;
  assert.match(final, /×2/);
  assert.match(final, /map the event flow 2/);
  assert.match(final, /review the diff 1/);
  // The children's own tool names never reach the chat surface.
  assert.ok(!final.includes('Grep'));
  assert.ok(!final.includes('a.ts'));
});

test('ToolTrace keeps Slack Agent activity compact without emitting prompts', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as any, testDest('C1'));
  const trace = new ToolTrace(stream, { slotPrefix: '*[writer]*' });
  const first = 'First line.\n\n' + 'A'.repeat(180);
  const second = 'Second line.\nKeep this newline.';

  trace.onToolUse('agent', {
    parallel: [
      { description: 'first child', prompt: first, subagent_type: 'explore' },
      { description: 'second child', prompt: second, subagent_type: 'reviewer' },
    ],
  }, undefined, 'tu_batch');
  await settle(stream);

  const all = [
    ...adapter.posted.map((entry) => entry.content.text),
    ...adapter.updated.map((entry) => entry.content.text),
  ].join('\n');
  assert.ok(!all.includes(first));
  assert.ok(!all.includes(second));
  assert.match(all, /Agent .*×2/);
});

test('ToolTrace emits complete Agent prompts only for an opted-in TUI stream', () => {
  const adapter = new MockAdapter();
  const stream = new MockOutputStream(adapter, testDest('T1'));
  Object.assign(stream, { showFullSubagentPrompts: true });
  const trace = new ToolTrace(stream);
  const prompt = 'First line.\n\n' + 'A'.repeat(180);

  trace.onToolUse('Agent', {
    description: 'inspect cards', prompt, subagent_type: 'explore',
  }, undefined, 'tu_tui');

  const text = stream.segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join('\n');
  assert.ok(text.includes(prompt));
  assert.match(text, /Agent prompt — inspect cards/);
});

test('ToolTrace keeps main-agent calls in their own group after a subagent batch', async () => {
  const adapter = new MockAdapter();
  const stream = new SlackOutputStream(adapter as any, testDest('C1'));
  const trace = new ToolTrace(stream);

  trace.onToolUse('Agent', { description: 'go look', subagent_type: 'explore' }, undefined, 'tu_a');
  trace.onToolUse('Grep', { pattern: 'x' }, { parentToolUseId: 'tu_a', type: 'explore', description: 'go look' });
  trace.onToolUse('Read', { file_path: 'main.ts' });
  await settle(stream);

  const final = adapter.updated.at(-1)!.content.text as string;
  const agentIndex = final.indexOf('go look');
  const readIndex = final.indexOf('main.ts');
  assert.ok(agentIndex >= 0 && readIndex > agentIndex);
  assert.match(final, /Read .*×1/);
});
