import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';

import {
  createInjectionObserver, resetInjectionLedger, type InjectionLedgerDeps,
} from '../../src/orchestration/injection-ledger.js';
import { createTranscriptSink, type TranscriptSinkDeps } from '../../src/orchestration/transcript-sink.js';
import type { RunEvent, RunPhase } from '../../src/domain/runs/events.js';
import type { ToolUseSubagent } from '../../src/agent-adapter/normalize/event-types.js';
import type { TodoSnapshot } from '../../src/core/types/agent-types.js';

const SESSION = 'sess-ledger-1';
const CHANNEL = 'web:sess-ledger-1';
const NAME = 'cortex-ledger';

const subagent: ToolUseSubagent = {
  parentToolUseId: 'toolu_parent', type: 'explore', description: 'scout', model: 'sonnet',
};

const snapshot: TodoSnapshot = {
  items: [{ content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' }],
  total: 1, completed: 0, activeLabel: 'Running tests', updatedAt: 42,
};

beforeEach(() => { resetInjectionLedger(); });

interface Recorded { rows: Record<string, any>[]; published: Record<string, any>[] }

/** The transcript sink's store/bus edges, recorded with their timestamps dropped so rows written
 *  at different instants compare equal. */
function recordingSinkDeps(): Recorded & { deps: Partial<TranscriptSinkDeps> } {
  const rows: Record<string, any>[] = [];
  const published: Record<string, any>[] = [];
  const row = (kind: string) => async (sessionId: string, opts: object) => {
    const { ts: _ts, ...rest } = opts as Record<string, unknown>;
    rows.push({ kind, sessionId, ...rest });
  };
  const deps: Partial<TranscriptSinkDeps> = {
    appendAssistant: row('assistant'),
    appendThinking: row('thinking'),
    appendTool: row('tool'),
    appendToolResult: row('toolResult'),
    appendSubagentEnd: row('subagentEnd'),
    appendToolImages: row('toolImages'),
    writeToolImages: async (sessionId, toolUseId, images) => images.map((image, i) => ({
      name: `${toolUseId}-${i}.png`, path: `workspace/tool-images/${sessionId}/${toolUseId}-${i}.png`,
      size: image.data.length, mimeType: image.mimeType, type: 'image' as const,
    })),
    setTodos: (sessionId, value) => { rows.push({ kind: 'todos', sessionId, snapshot: value }); },
    publishMessage: ({ ts: _ts, ...rest }) => { published.push({ kind: 'message', ...rest }); },
    publishTodos: (payload) => { published.push({ kind: 'todos', ...payload }); },
    publishToolImages: (payload) => { published.push({ kind: 'toolImages', ...payload }); },
    publishDebugUpdated: (payload) => { published.push({ kind: 'debug', ...payload }); },
    persistContextUsage: async (input) => { rows.push({ kind: 'context', ...input }); },
  };
  return { rows, published, deps };
}

/** One of every row kind a continuation can produce, tagged with `phase`. */
function continuationEvents(phase: RunPhase): RunEvent[] {
  return [
    { type: 'assistant_thinking', text: 'consider', blockId: 'blk-0', phase },
    { type: 'assistant_text', text: 'looking now', blockId: 'blk-1', phase },
    { type: 'assistant_text', text: 'notes', subagent, phase },
    {
      type: 'assistant_text', text: 'Usage limit reached', noticeLevel: 'warning',
      noticeAction: { kind: 'cancel-resume' }, phase,
    },
    { type: 'tool_use', toolUseId: 'tu-1', name: 'remote_bash', input: { device: 'hub', command: 'ls' }, phase },
    { type: 'tool_use', toolUseId: 'tu-2', name: 'Task', input: { subagent_type: 'explore', description: 'scout', prompt: 'look' }, phase },
    { type: 'tool_use', toolUseId: 'tu-3', name: 'Read', input: { file_path: '/x' }, subagent, phase },
    {
      type: 'tool_result', toolUseId: 'tu-1', ok: true, content: 'out', phase,
      images: [{ mimeType: 'image/png', data: 'AAAA' }],
    },
    { type: 'todo_update', toolUseId: 'tu-todo', snapshot, phase },
    { type: 'subagent_end', parentToolUseId: 'tu-2', status: 'completed', phase },
    { type: 'context_usage', usedTokens: 500, contextWindow: 1000, percent: 50, accuracy: 'exact', phase },
  ];
}

function ledgerDeps(transcript: Partial<TranscriptSinkDeps>, streamed: string[] = []): InjectionLedgerDeps {
  return {
    getStreamingCallback: () => (text) => { streamed.push(text); },
    publishMessage: () => {},
    publishDelivered: () => {},
    publishStatus: () => {},
    persistPending: async () => {},
    commitPending: async () => ({ committedTs: 'T' }),
    track: () => {},
    now: () => 'T',
    captureDebug: true,
    transcript,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('a ledger-written continuation row is the foreground row, field for field', async () => {
  const foreground = recordingSinkDeps();
  const sink = createTranscriptSink({
    sessionId: SESSION, channel: CHANNEL, debug: true, deps: foreground.deps,
  });
  for (const event of continuationEvents('foreground')) await sink.onEvent(event);

  const background = recordingSinkDeps();
  const ledger = createInjectionObserver(ledgerDeps(background.deps), CHANNEL, SESSION);
  for (const event of continuationEvents('background')) await ledger.onEvent(event);
  await settle();

  assert.deepEqual(background.rows, foreground.rows);
  assert.deepEqual(background.published, foreground.published);
  const assistant = background.published.find((p) => p.text === 'looking now');
  assert.equal(assistant?.blockId, 'blk-1');
  const notice = background.rows.find((r) => r.text === 'Usage limit reached');
  assert.equal(notice?.noticeLevel, 'warning');
  assert.deepEqual(notice?.noticeAction, { kind: 'cancel-resume' });
  assert.ok(background.rows.some((r) => r.kind === 'toolImages' && r.toolUseId === 'tu-1'));
  assert.ok(background.rows.some((r) => r.kind === 'todos'));
  assert.ok(background.rows.some((r) => r.kind === 'subagentEnd' && r.subagentId === 'tu-2'));
  const spawn = background.rows.find((r) => r.kind === 'tool' && r.toolUseId === 'tu-2');
  assert.deepEqual(spawn?.subagent, { id: 'tu-2' }, 'the spawning call anchors its own block');
});

test('the ledger streams the agent\'s own continuation prose, never a subagent\'s', async () => {
  const streamed: string[] = [];
  const background = recordingSinkDeps();
  const ledger = createInjectionObserver(ledgerDeps(background.deps, streamed), CHANNEL, SESSION);
  for (const event of continuationEvents('background')) await ledger.onEvent(event);

  assert.deepEqual(streamed, ['looking now', 'Usage limit reached']);
});

test('a held run keeps every continuation row kind to the hold', async () => {
  const background = recordingSinkDeps();
  const ledger = createInjectionObserver(
    ledgerDeps(background.deps), CHANNEL, SESSION, { backgroundTranscriptOwned: true },
  );
  for (const event of continuationEvents('background')) await ledger.onEvent(event);
  await settle();

  assert.deepEqual(background.rows, []);
  assert.deepEqual(background.published, []);
});

test('foreground events are left to the surface\'s own sink', async () => {
  const background = recordingSinkDeps();
  const ledger = createInjectionObserver(ledgerDeps(background.deps), CHANNEL, SESSION);
  for (const event of continuationEvents('foreground')) await ledger.onEvent(event);
  await settle();

  assert.deepEqual(background.rows, []);
});

test('continuation context usage is keyed by the stable session ID', async () => {
  const background = recordingSinkDeps();
  const ledger = createInjectionObserver(
    { ...ledgerDeps(background.deps)}, CHANNEL, SESSION,
  );
  await ledger.onEvent({
    type: 'context_usage', usedTokens: 1, contextWindow: 10, percent: 10, accuracy: 'exact', phase: 'background',
  });

  assert.deepEqual(background.rows, [{
    kind: 'context', sessionId: SESSION, channel: CHANNEL,
    usage: { usedTokens: 1, contextWindow: 10, percent: 10, accuracy: 'exact' },
  }]);
});
