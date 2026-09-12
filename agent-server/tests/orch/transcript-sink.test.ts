// input:  createTranscriptSink, RunEvent shapes, injected transcript seams
// output: history/publish side effects, subagent attribution and delta-flush ordering
// pos:    P1.4 transcript-sink contract — one observer replaces the four hand-wired copies
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // first — keep the store singletons off the real data home
import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  createTranscriptSink, type TranscriptSinkDeps,
} from '../../src/orchestration/transcript-sink.js';
import type { ToolUseSubagent } from '../../src/agent-adapter/normalize/event-types.js';
import type { ChatNoticeLevel, NoticeAction, TodoSnapshot } from '../../src/core/types/agent-types.js';

const SESSION = 'sess-sink-1';
const CHANNEL = 'web:sess-sink-1';
const NAME = 'cortex-sink';

const subagent: ToolUseSubagent = {
  parentToolUseId: 'toolu_parent',
  type: 'explore',
  description: 'scout',
  prompt: 'look around',
  model: 'sonnet',
};

const snapshot: TodoSnapshot = {
  items: [{ content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' }],
  total: 1,
  completed: 0,
  activeLabel: 'Running tests',
  updatedAt: 42,
};

interface HistoryCall { method: string; sessionId: string; opts: Record<string, any> }

interface Harness {
  history: HistoryCall[];
  published: Record<string, any>[];
  debug: Record<string, any>[];
  todos: Array<{ sessionId: string; snapshot: TodoSnapshot }>;
  context: Record<string, any>[];
  order: string[];
  assistants: string[];
  sink: ReturnType<typeof createTranscriptSink>;
}

function harness(opts: {
  debug?: boolean;
  deps?: Partial<TranscriptSinkDeps>;
  onTodoUpdate?: (snapshot: TodoSnapshot) => void;
} = {}): Harness {
  const history: HistoryCall[] = [];
  const published: Record<string, any>[] = [];
  const debug: Record<string, any>[] = [];
  const todos: Array<{ sessionId: string; snapshot: TodoSnapshot }> = [];
  const context: Record<string, any>[] = [];
  const order: string[] = [];
  const assistants: string[] = [];

  const deps: Partial<TranscriptSinkDeps> = {
    appendTool: async (sessionId, value) => { history.push({ method: 'tool', sessionId, opts: value as any }); },
    appendToolResult: async (sessionId, value) => { history.push({ method: 'toolResult', sessionId, opts: value as any }); },
    appendSubagentEnd: async (sessionId, value) => { history.push({ method: 'subagentEnd', sessionId, opts: value as any }); },
    appendAssistant: async (sessionId, value) => { history.push({ method: 'assistant', sessionId, opts: value as any }); },
    setTodos: (sessionId, value) => { todos.push({ sessionId, snapshot: value }); },
    publishMessage: (payload) => { order.push('publish'); published.push(payload); },
    publishTodos: (payload) => { published.push({ kind: 'todos', ...payload }); },
    publishDebugUpdated: (payload) => { debug.push(payload); },
    persistContextUsage: async (input) => { context.push(input); },
    ...opts.deps,
  };

  const sink = createTranscriptSink({
    sessionId: SESSION,
    channel: CHANNEL,
    sessionName: NAME,
    debug: opts.debug ?? false,
    onAssistantMessage: (text) => { order.push('assistantMsg'); assistants.push(text); },
    onTodoUpdate: opts.onTodoUpdate,
    flushDelta: (blockId) => { order.push(`flush:${blockId}`); },
    deps,
  });

  return { history, published, debug, todos, context, order, assistants, sink };
}

// ── tool_use ─────────────────────────────────────────────────────────────────

test('tool_use appends a history row and publishes the tool message', () => {
  const h = harness();
  h.sink.onEvent({
    type: 'tool_use', toolUseId: 'tu-1', name: 'Bash', input: { command: 'ls' }, phase: 'foreground',
  });

  assert.deepEqual(h.history.map((c) => c.method), ['tool']);
  assert.equal(h.history[0].sessionId, SESSION);
  assert.equal(h.history[0].opts.toolName, 'Bash');
  assert.equal(h.history[0].opts.toolInput, 'ls');
  assert.equal(h.history[0].opts.toolUseId, undefined, 'no DEBUG fields without debug');
  assert.deepEqual(h.published, [{
    sessionId: SESSION, channel: CHANNEL, role: 'tool', text: '', toolName: 'Bash', toolInput: 'ls',
    ts: h.published[0].ts,
  }]);
  assert.deepEqual(h.debug, []);
});

test('tool_use carries DEBUG toolUseId/fullInput and refreshes the transcript when debug is on', async () => {
  const input = { command: 'ls', nested: { a: 1 } };
  const h = harness({ debug: true });
  h.sink.onEvent({ type: 'tool_use', toolUseId: 'tu-debug', name: 'Bash', input, phase: 'foreground' });

  assert.equal(h.history[0].opts.toolUseId, 'tu-debug');
  assert.deepEqual(h.history[0].opts.fullInput, input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(h.debug, [{ sessionId: SESSION, channel: CHANNEL }]);
});

test('tool_use attributes a subagent call and its spawn prompt', () => {
  const h = harness();
  h.sink.onEvent({
    type: 'tool_use', toolUseId: 'tu-sub', name: 'Read', input: { file_path: '/x' },
    subagent, phase: 'foreground',
  });

  assert.deepEqual(h.history[0].opts.subagent, {
    id: 'toolu_parent', type: 'explore', description: 'scout', model: 'sonnet',
  });
  assert.deepEqual(h.history[0].opts.subagentSpawns, [{
    id: 'toolu_parent', type: 'explore', description: 'scout', prompt: 'look around',
  }]);
  assert.equal(h.published[0].subagentId, 'toolu_parent');
  assert.equal(h.published[0].subagentType, 'explore');
});

// ── tool_result ──────────────────────────────────────────────────────────────

test('tool_result persists the full result and refreshes the transcript only in DEBUG mode', async () => {
  const off = harness();
  off.sink.onEvent({ type: 'tool_result', toolUseId: 'tu-1', ok: true, content: 'out', phase: 'foreground' });
  assert.deepEqual(off.history, [], 'DEBUG-only result is dropped outside debug');
  assert.deepEqual(off.debug, []);

  const on = harness({ debug: true });
  on.sink.onEvent({ type: 'tool_result', toolUseId: 'tu-1', ok: false, content: 'boom', phase: 'foreground' });
  assert.deepEqual(on.history, [{
    method: 'toolResult', sessionId: SESSION,
    opts: { toolUseId: 'tu-1', content: 'boom', isError: true },
  }]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(on.debug, [{ sessionId: SESSION, channel: CHANNEL }]);
});

// ── subagent_end ─────────────────────────────────────────────────────────────

test('subagent_end persists the terminal state and publishes a state correction', () => {
  const h = harness();
  h.sink.onEvent({
    type: 'subagent_end', parentToolUseId: 'toolu_parent', status: 'killed', phase: 'foreground',
  });

  assert.deepEqual(h.history, [{
    method: 'subagentEnd', sessionId: SESSION,
    opts: { subagentId: 'toolu_parent', status: 'killed', ts: h.history[0].opts.ts },
  }]);
  assert.deepEqual(h.published, [{
    sessionId: SESSION, channel: CHANNEL, role: 'assistant', text: '', ts: h.published[0].ts,
    subagentId: 'toolu_parent', subagentEnded: 'killed',
  }]);
});

test('subagent_end without a parent id is a no-op', () => {
  const h = harness();
  h.sink.onEvent({ type: 'subagent_end', parentToolUseId: '', status: 'completed', phase: 'foreground' });
  assert.deepEqual(h.history, []);
  assert.deepEqual(h.published, []);
});

// ── todo_update ──────────────────────────────────────────────────────────────

test('todo_update records the snapshot, publishes it and refreshes the platform status', () => {
  const seen: TodoSnapshot[] = [];
  const h = harness({ onTodoUpdate: (s) => seen.push(s) });
  h.sink.onEvent({ type: 'todo_update', toolUseId: 'tu-todo', snapshot, phase: 'foreground' });

  assert.deepEqual(h.todos, [{ sessionId: SESSION, snapshot }]);
  assert.deepEqual(h.published, [{
    kind: 'todos', sessionId: SESSION, channel: CHANNEL, snapshot,
  }]);
  assert.deepEqual(seen, [snapshot]);
});

// ── context_usage ────────────────────────────────────────────────────────────

test('context_usage persists the snapshot through the context-usage seam', async () => {
  const h = harness();
  await h.sink.onEvent({
    type: 'context_usage', usedTokens: 60000, contextWindow: 200000, percent: 30,
    accuracy: 'estimate', phase: 'foreground',
  });

  assert.deepEqual(h.context, [{
    sessionName: NAME, sessionId: SESSION, channel: CHANNEL,
    usage: { usedTokens: 60000, contextWindow: 200000, percent: 30, accuracy: 'estimate' },
  }]);
});

// ── assistant_text ───────────────────────────────────────────────────────────

test('assistant_text flushes the block, streams to chat, persists and publishes in that order', () => {
  const h = harness();
  h.sink.onEvent({
    type: 'assistant_text', text: 'hello', blockId: 'b1', phase: 'foreground',
  });

  assert.deepEqual(h.assistants, ['hello']);
  assert.deepEqual(h.order, ['flush:b1', 'assistantMsg', 'publish']);
  assert.deepEqual(h.history, [{
    method: 'assistant', sessionId: SESSION,
    opts: { text: 'hello', ts: h.history[0].opts.ts, noticeLevel: undefined, noticeAction: undefined },
  }]);
  assert.deepEqual(h.published, [{
    sessionId: SESSION, channel: CHANNEL, role: 'assistant', text: 'hello',
    ts: h.published[0].ts, blockId: 'b1',
  }]);
});

test('assistant_text carries notice level/action into the persisted and published rows', () => {
  const noticeLevel: ChatNoticeLevel = 'warning';
  const noticeAction: NoticeAction = { kind: 'cancel-resume' };
  const h = harness();
  h.sink.onEvent({
    type: 'assistant_text', text: 'paused', phase: 'foreground', noticeLevel, noticeAction,
  });

  assert.equal(h.history[0].opts.noticeLevel, 'warning');
  assert.deepEqual(h.history[0].opts.noticeAction, { kind: 'cancel-resume' });
  assert.equal(h.published[0].noticeLevel, 'warning');
  assert.deepEqual(h.published[0].noticeAction, { kind: 'cancel-resume' });
});

test('assistant_text with subagent attribution is withheld from chat but persisted and published tagged', () => {
  const h = harness();
  h.sink.onEvent({
    type: 'assistant_text', text: 'subagent notes', blockId: 'b2', subagent, phase: 'foreground',
  });

  assert.deepEqual(h.assistants, [], 'subagent prose never reaches the chat surface');
  assert.deepEqual(h.order, ['flush:b2', 'publish']);
  assert.deepEqual(h.history[0].opts.subagent, {
    id: 'toolu_parent', type: 'explore', description: 'scout', model: 'sonnet',
  });
  assert.deepEqual(h.history[0].opts.subagentSpawns, [{
    id: 'toolu_parent', type: 'explore', description: 'scout', prompt: 'look around',
  }]);
  assert.equal(h.published[0].subagentId, 'toolu_parent');
  assert.equal(h.published[0].subagentDescription, 'scout');
});

test('assistant_text still streams empty text to chat but persists nothing', () => {
  const h = harness();
  h.sink.onEvent({ type: 'assistant_text', text: '', phase: 'foreground' });

  assert.deepEqual(h.assistants, ['']);
  assert.deepEqual(h.history, []);
  assert.deepEqual(h.published, []);
});

test('unrelated RunEvents are ignored without touching any seam', () => {
  const h = harness();
  h.sink.onEvent({ type: 'turn_progress', numTurns: 3 });
  h.sink.onEvent({ type: 'error', message: 'x', fatal: false });
  assert.deepEqual(h.history, []);
  assert.deepEqual(h.published, []);
  assert.deepEqual(h.debug, []);
  assert.deepEqual(h.todos, []);
});
