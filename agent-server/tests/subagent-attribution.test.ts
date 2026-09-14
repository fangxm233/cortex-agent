import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

import { runRegistry } from '../src/core/run-registry.js';
import { EventBus } from '../src/events/event-bus.js';
import { setOrchestrationRuntime } from '../src/orchestration/runtime.js';
import { conversationHistory } from '../src/store/conversation-history-repo.js';
import { parentNoticeSink } from '../src/orchestration/subagent-attribution.js';
import { createTranscriptSink } from '../src/orchestration/transcript-sink.js';
import { isDebugMode } from '../src/core/debug-mode.js';
import { _test } from '../src/domain/agents/subagent/runner.js';
import type { RunEvent } from '../src/domain/runs/events.js';
import type { SubagentNotice } from '../src/agent-adapter/pi/event-parser.js';
import type { SubagentRunRequest } from '../src/domain/agents/subagent/runner.js';

const CHANNEL = 'C-attribution';
const PARENT_SESSION = 'sess-parent';

/**
 * A registered execution whose live run records every event ingested into its stream.
 *
 * The attribution sink is a producer into the run's one stream: it resolves the execution by key
 * and calls `run.ingestExternal(toRunEvent(notice, run.phase))`. `phase` is part of the run shape
 * the sink reads (production tags each notice with whatever phase the parent is in when it lands).
 */
function register(executionId: string, trackSessionId: string | null): RunEvent[] {
  const pushed: RunEvent[] = [];
  const run = {
    phase: 'foreground' as const,
    ingestExternal: (event: RunEvent): boolean => { pushed.push(event); return true; },
    steer: async () => 'refused' as const,
    respondToDialog: () => false,
  };
  runRegistry.register({
    threadId: null, channel: CHANNEL, agentSlotId: null, executionId,
    kind: 'local', kill: () => true, backend: 'test', trackSessionId,
    run,
  });
  return pushed;
}

function notice(text: string): SubagentNotice {
  return {
    ref: 'toolu_parent#0', type: 'general-purpose', description: 'd',
    model: null, backend: 'claude', kind: 'assistant_text', text,
  };
}

function toolNotice(name: string, input: unknown): SubagentNotice {
  return {
    ref: 'toolu_parent#0', type: 'general-purpose', description: 'scout the repo',
    model: 'sonnet', backend: 'claude', kind: 'tool_use',
    toolUseId: 'toolu_parent#0:tu-1', name, input,
  };
}

function endNotice(status: 'completed' | 'failed' | 'killed' = 'completed'): SubagentNotice {
  return {
    ref: 'toolu_parent#0', type: 'general-purpose', description: 'd',
    model: null, backend: 'claude', kind: 'end', status,
  };
}

/** Rows written straight to the store + the session events they were published as. The detached
 *  writer binds the real singletons, so this is the whole observable surface of one notice. */
interface Transcript {
  appended: Array<Record<string, any>>;
  published: Array<Record<string, any>>;
}

function captureTranscript(): Transcript {
  const appended: Array<Record<string, any>> = [];
  const published: Array<Record<string, any>> = [];
  const record = (method: string) => async (sessionId: string, opts: unknown): Promise<void> => {
    appended.push({ method, sessionId, ...(opts as Record<string, any>) });
  };
  vi.spyOn(conversationHistory, 'appendTool').mockImplementation(record('tool') as any);
  vi.spyOn(conversationHistory, 'appendToolResult').mockImplementation(record('toolResult') as any);
  vi.spyOn(conversationHistory, 'appendAssistant').mockImplementation(record('assistant') as any);
  vi.spyOn(conversationHistory, 'appendSubagentEnd').mockImplementation(record('subagentEnd') as any);
  const bus = new EventBus();
  bus.subscribe('session.message', (event) => { published.push(event as any); });
  setOrchestrationRuntime({ bus });
  return { appended, published };
}

/** Timestamps are wall-clock, and the bus stamps its own `ts`; nothing else may differ. */
function shape(row: Record<string, any>): Record<string, any> {
  const { ts, type, ...rest } = row;
  return rest;
}

// The detached writer reads DEBUG the same way `turn/turn.ts` does, so an operator running the
// suite with DEBUG set would otherwise flip the shape of every row asserted below.
beforeEach(() => { vi.stubEnv('DEBUG', ''); });

afterEach(() => {
  for (const exec of runRegistry.getAll()) runRegistry.remove(exec.registryKey);
  setOrchestrationRuntime({ bus: null });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test('the sink pushes into the execution it resolved, and follows it across a retry', () => {
  const parent = register('exec-parent', PARENT_SESSION);
  const sink = parentNoticeSink(PARENT_SESSION, CHANNEL);
  assert.ok(sink, 'a mid-turn parent with an ingest seam must produce a sink');

  sink!(notice('from the child'));
  assert.equal(parent.length, 1);
  const first = parent[0] as Extract<RunEvent, { type: 'assistant_text' }>;
  assert.equal(first.type, 'assistant_text');
  assert.equal(first.text, 'from the child');
  assert.equal(first.phase, 'foreground', 'the notice is re-tagged with the parent run\'s phase');

  // A retry re-registers the same executionId with a fresh run: the sink follows the key.
  const retried = register('exec-parent', PARENT_SESSION);
  sink!(notice('after the retry'));
  assert.equal(retried.length, 1, 'the sink must resolve the key again, not cache the run');
});

test('a row that outlives its parent turn is written straight to the transcript, never into the child', () => {
  const t = captureTranscript();
  register('exec-parent', PARENT_SESSION);
  const sink = parentNoticeSink(PARENT_SESSION, CHANNEL);
  assert.ok(sink);

  // The parent's turn ends; its background child outlives it and is now the only live execution on
  // the channel. Resolving by channel here would hand the child its own events back — the notice →
  // ingestExternal → event → notice loop that starves the daemon's event loop. The frozen
  // sessionId/channel is what the detached writer uses, so the cycle stays closed.
  runRegistry.remove('exec-parent');
  const child = register('exec-child', null);

  assert.doesNotThrow(() => sink!(notice('orphaned child work')));
  assert.equal(child.length, 0, 'a child must never be resolved as its own attribution target');

  assert.equal(t.appended.length, 1, 'the row is no longer dropped');
  assert.equal(t.appended[0].method, 'assistant');
  assert.equal(t.appended[0].sessionId, PARENT_SESSION);
  assert.equal(t.appended[0].text, 'orphaned child work');
  assert.equal(t.published.length, 1);
  assert.equal(t.published[0].subagentId, 'toolu_parent#0');
});

test('a tool call that lands after the parent turn ended keeps its full attribution', () => {
  const t = captureTranscript();
  register('exec-parent', PARENT_SESSION);
  const sink = parentNoticeSink(PARENT_SESSION, CHANNEL);
  assert.ok(sink);
  runRegistry.remove('exec-parent');

  sink!(toolNotice('Bash', { command: 'ls' }));

  assert.equal(t.appended.length, 1);
  assert.equal(t.appended[0].method, 'tool');
  assert.equal(t.appended[0].toolName, 'Bash');
  assert.equal(t.appended[0].toolInput, 'ls');
  assert.deepEqual(t.appended[0].subagent, {
    id: 'toolu_parent#0', type: 'general-purpose', description: 'scout the repo', model: 'sonnet',
  });
  assert.equal(t.appended[0].toolUseId, undefined, 'no DEBUG-only fields with DEBUG off');

  assert.equal(t.published.length, 1);
  assert.equal(t.published[0].role, 'tool');
  assert.equal(t.published[0].channel, CHANNEL);
  assert.equal(t.published[0].subagentId, 'toolu_parent#0');
  assert.equal(t.published[0].subagentType, 'general-purpose');
  assert.equal(t.published[0].subagentDescription, 'scout the repo');
  assert.equal(t.published[0].subagentModel, 'sonnet');
});

test('prose that lands after the parent turn ended keeps its full attribution', () => {
  const t = captureTranscript();
  register('exec-parent', PARENT_SESSION);
  const sink = parentNoticeSink(PARENT_SESSION, CHANNEL);
  assert.ok(sink);
  runRegistry.remove('exec-parent');

  sink!({ ...notice('late working note'), model: 'sonnet', description: 'scout the repo' });

  assert.equal(t.appended.length, 1);
  assert.deepEqual(t.appended[0].subagent, {
    id: 'toolu_parent#0', type: 'general-purpose', description: 'scout the repo', model: 'sonnet',
  });
  assert.equal(t.published.length, 1);
  assert.equal(t.published[0].role, 'assistant');
  assert.equal(t.published[0].text, 'late working note');
  assert.equal(t.published[0].subagentId, 'toolu_parent#0');
  assert.equal(t.published[0].subagentType, 'general-purpose');
  assert.equal(t.published[0].subagentDescription, 'scout the repo');
  assert.equal(t.published[0].subagentModel, 'sonnet');
});

test('a detached row is shaped exactly like the one the live turn would have written', () => {
  const t = captureTranscript();
  const parent = register('exec-parent', PARENT_SESSION);
  const sink = parentNoticeSink(PARENT_SESSION, CHANNEL);
  assert.ok(sink);

  // Same notice twice: once through the live run's stream, once after that run is gone.
  const call = toolNotice('Bash', { command: 'ls' });
  sink!(call);
  assert.equal(parent.length, 1, 'the live path pushes a RunEvent instead of writing');
  assert.equal(t.appended.length, 0, 'while the turn is open the run\'s own sink owns the row');

  runRegistry.remove('exec-parent');
  sink!(call);
  assert.equal(t.appended.length, 1);

  // Drive the RunEvent the live path produced through the sink the live turn installs. Both paths
  // are the same `createTranscriptSink`, so the row and the payload must match field for field.
  const live = captureLive();
  live.sink.onEvent(parent[0]);

  assert.deepEqual(shape(t.appended[0]), shape(live.appended[0]));
  assert.deepEqual(shape(t.published[0]), shape(live.published[0]));
});

function captureLive(): { sink: ReturnType<typeof createTranscriptSink> } & Transcript {
  const appended: Array<Record<string, any>> = [];
  const published: Array<Record<string, any>> = [];
  const record = (method: string) => async (sessionId: string, opts: unknown): Promise<void> => {
    appended.push({ method, sessionId, ...(opts as Record<string, any>) });
  };
  const sink = createTranscriptSink({
    sessionId: PARENT_SESSION, channel: CHANNEL, sessionName: 'cortex-parent', debug: isDebugMode(),
    deps: {
      appendTool: record('tool'), appendToolResult: record('toolResult'),
      appendAssistant: record('assistant'), appendSubagentEnd: record('subagentEnd'),
      publishMessage: (payload) => { published.push(payload as any); },
    },
  });
  return { sink, appended, published };
}

test('a child that settles after its parent turn ended is sealed through that same path', () => {
  // The batch's delivery turn — the user-turn boundary that would otherwise close the block —
  // does not come until the slowest sibling is done, so this child would spin until then.
  const t = captureTranscript();
  register('exec-parent', PARENT_SESSION);
  const sink = parentNoticeSink(PARENT_SESSION, CHANNEL);
  assert.ok(sink);
  runRegistry.remove('exec-parent');

  sink!(endNotice('failed'));

  assert.equal(t.appended.length, 1);
  assert.deepEqual(shape(t.appended[0]), {
    method: 'subagentEnd', sessionId: PARENT_SESSION, subagentId: 'toolu_parent#0', status: 'failed',
  });
  assert.equal(t.published.length, 1);
  assert.equal(t.published[0].subagentId, 'toolu_parent#0');
  assert.equal(t.published[0].subagentEnded, 'failed');
  assert.equal(t.published[0].text, '');
});

test('the detached writer takes DEBUG from the same source the live turn does', () => {
  vi.stubEnv('DEBUG', '1');
  const t = captureTranscript();
  register('exec-parent', PARENT_SESSION);
  const sink = parentNoticeSink(PARENT_SESSION, CHANNEL);
  assert.ok(sink);
  runRegistry.remove('exec-parent');

  sink!(toolNotice('Bash', { command: 'ls' }));

  assert.equal(t.appended[0].toolUseId, 'toolu_parent#0:tu-1');
  assert.deepEqual(t.appended[0].fullInput, { command: 'ls' });
});

test('a child notice observer drops events that already carry subagent attribution', () => {
  const notices: SubagentNotice[] = [];
  const request = {
    ref: 'toolu_parent#0',
    task: { description: 'd', prompt: 'p', subagent_type: 'general-purpose' },
    onNotice: (n: SubagentNotice) => { notices.push(n); },
  } as unknown as SubagentRunRequest;
  const observer = _test.claudeNoticeObserver(request);

  observer.onEvent!({ type: 'assistant_text', text: 'my own prose', phase: 'foreground' });
  assert.equal(notices.length, 1, 'the child\'s own prose is forwarded');

  // Pushed in from outside by parentNoticeSink: forwarding it would send it straight back.
  const subagent = { parentToolUseId: 'toolu_parent#0', type: null, model: null };
  observer.onEvent!({ type: 'assistant_text', text: 'echo', phase: 'foreground', subagent });
  observer.onEvent!({
    type: 'tool_use', toolUseId: 't1', name: 'Bash', input: {}, phase: 'foreground', subagent,
  });
  observer.onEvent!({
    type: 'tool_result', toolUseId: 't1', ok: true, content: 'out', phase: 'foreground', subagent,
  });
  assert.equal(notices.length, 1, 'attributed events must not be re-forwarded');
});
