// A held turn's background phase, end to end through `openTurn`: every background row is written by
// the turn's transcript sink, whichever surface holds the turn, and the chat platform still shows
// only what it showed before (plus correct subagent attribution on the tool trace).
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const { mockStartRun } = vi.hoisted(() => ({ mockStartRun: vi.fn() }));

vi.mock('@domain/runs/service.js', () => ({
  startRun: (...args: unknown[]) => mockStartRun(...args),
}));

import type { AgentResult, TodoSnapshot } from '../../src/core/types/agent-types.js';
import type { AgentRun } from '../../src/domain/runs/run.js';
import type { RunEvent } from '../../src/domain/runs/events.js';
import type { RunObserver } from '../../src/domain/runs/request.js';
import { Capability } from '../../src/agent-adapter/capabilities.js';
import { openTurn, type TurnInput } from '../../src/orchestration/turn/turn.js';
import { getOrchestrationRuntime, setOrchestrationRuntime } from '../../src/orchestration/runtime.js';
import { sessionHolds } from '../../src/core/session-holds.js';
import { activeTurns } from '../../src/orchestration/turn/active-turns.js';
import { MockAdapter } from '../../src/platform/testing.js';
import { CLAUDE_SELECTION, seedSelections } from './selection-fixture.js';

beforeAll(seedSelections);

const subagent = { parentToolUseId: 'toolu_bg', type: 'Explore', description: 'survey' };
const snapshot: TodoSnapshot = {
  items: [{ content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' }],
  total: 1, completed: 0, activeLabel: 'Running tests', updatedAt: 42,
};
const RATE_LIMIT_TEXT =
  "API Error: Server is temporarily limiting requests (not your usage limit) · This request "
  + "would exceed your account's rate limit. Please try again later.";

let restoreBus: unknown;
let restoreTrace: string | undefined;
let bus: any[];

beforeEach(() => {
  mockStartRun.mockReset();
  sessionHolds.clear();
  bus = [];
  restoreBus = getOrchestrationRuntime().bus;
  setOrchestrationRuntime({ bus: {
    publish: (event: any) => { bus.push(event); },
    subscribe: () => ({ unsubscribe() {} }),
  } as never });
  restoreTrace = process.env.CORTEX_SHOW_TOOL_CALLS;
  process.env.CORTEX_SHOW_TOOL_CALLS = '1';
});

afterEach(() => {
  setOrchestrationRuntime({ bus: restoreBus as never });
  if (restoreTrace === undefined) delete process.env.CORTEX_SHOW_TOOL_CALLS;
  else process.env.CORTEX_SHOW_TOOL_CALLS = restoreTrace;
  sessionHolds.clear();
  activeTurns._reset();
  vi.restoreAllMocks();
});

/** A settled run with background work left; every observer (the turn's and the hold's) is fed by
 *  `emit`, as the real run's fan-out does. */
function heldRun(): { emit: (event: RunEvent) => Promise<void> } {
  const observers = new Set<RunObserver>();
  const result = Promise.resolve({
    finalOutput: 'started it', total_cost_usd: 0, num_turns: 1,
    pendingBackgroundTasks: 1, undeliveredBackgroundTasks: 0,
  } as AgentResult);
  const run = {
    id: 'run-bg', executionId: 'exec-bg', status: 'running', phase: 'foreground', numTurns: null,
    backendSessionId: 'backend-bg', capabilities: new Set([Capability.BackgroundContinuation]),
    result, settled: result,
    steer: async () => 'refused', respondToDialog: () => false, cancel: () => {},
    subscribe: (o: RunObserver) => { observers.add(o); return () => { observers.delete(o); }; },
    backgroundTranscriptOwned: false, claimBackgroundTranscript: () => {}, ingestExternal: () => false,
  } as unknown as AgentRun;
  mockStartRun.mockImplementation((_request: unknown, turnObservers: RunObserver[]) => {
    for (const o of turnObservers) observers.add(o);
    return run;
  });
  return {
    emit: async (event) => { for (const o of [...observers]) await o.onEvent(event); },
  };
}

function input(channel: string, adapter: MockAdapter): TurnInput {
  return {
    channel,
    adapter: adapter as never,
    threadAnchorId: null,
    session: {
      sessionId: `track-${channel}`, backendSessionId: null, projectId: 'general', lease: null,
    },
    user: { text: 'run it in the background' },
    ledger: null,
    trigger: 'user',
    prepareRequest: async () => ({
      request: {
        runId: 'run-bg',
        session: { sessionId: 's', backendSessionId: null, engineKey: 'c'},
        selection: CLAUDE_SELECTION, spec: {} as any, prompt: { text: 'hello', attachments: [] },
        context: { channel, project: 'general', trigger: 'user' }, policy: {} as any,
      } as any,
      backendPrompt: 'hello',
    }),
  } as TurnInput;
}

const messages = () => bus.filter((e) => e.type === 'session.message');
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
function platformTexts(adapter: MockAdapter): string[] {
  return [...adapter.posted, ...adapter.updated].map((m: any) => String(m.content?.text ?? ''));
}

test('platform hold: background rows are written like in-turn rows; Slack still shows the reply once', async () => {
  const adapter = new MockAdapter();
  const channel = 'slack:D-bg-rows';
  const run = heldRun();
  await openTurn(input(channel, adapter));
  assert.equal(sessionHolds.hasHoldHandles(`track-${channel}`), true, 'the platform hold took the turn');

  await run.emit({ type: 'tool_use', phase: 'background', name: 'Grep', input: { pattern: 'x' }, toolUseId: 'toolu_child', subagent });
  await run.emit({ type: 'subagent_end', phase: 'background', parentToolUseId: 'toolu_bg', status: 'completed' });
  await run.emit({ type: 'assistant_text', phase: 'background', text: 'the build finished' });
  await run.emit({ type: 'todo_update', phase: 'background', toolUseId: 'toolu_todo', snapshot });
  await settle();

  const tool = messages().find((m) => m.role === 'tool' && m.toolName === 'Grep');
  assert.equal(tool?.subagentId, 'toolu_bg', 'a background subagent call is attributed to its subagent');
  assert.ok(messages().some((m) => m.subagentId === 'toolu_bg' && m.subagentEnded === 'completed'),
    'the subagent end is recorded');
  assert.equal(messages().filter((m) => m.role === 'assistant' && m.text === 'the build finished').length, 1,
    'the continuation answer is a transcript row too');
  assert.ok(bus.some((e) => e.type === 'session.todos'), 'the background task list is published');

  const texts = platformTexts(adapter);
  assert.equal(texts.filter((t) => t.includes('the build finished')).length, 1, 'posted to Slack exactly once');
  assert.ok(texts.some((t) => /Agent ×1/.test(t) && /survey 1/.test(t)),
    'the subagent call counts on the shared subagent trace line');
  assert.ok(!texts.some((t) => /Grep ×/.test(t)), 'not as a main-agent tool line');
  assert.ok(!texts.some((t) => /Running tests/.test(t)), 'a background task list does not rewrite the held status');
});

test('web hold: background prose keeps its blockId, a held rate-limit card stays out, todos publish', async () => {
  const adapter = new MockAdapter();
  const channel = 'web:bg-rows';
  const run = heldRun();
  await openTurn(input(channel, adapter));
  assert.equal(sessionHolds.hasHoldHandles(`track-${channel}`), true, 'the web hold took the turn');

  await run.emit({ type: 'assistant_text', phase: 'background', text: 'background done', blockId: 'blk-bg' });
  await run.emit({ type: 'assistant_text', phase: 'background', text: RATE_LIMIT_TEXT });
  await run.emit({ type: 'tool_use', phase: 'background', name: 'Grep', input: { pattern: 'x' }, toolUseId: 'toolu_child', subagent });
  await run.emit({ type: 'todo_update', phase: 'background', toolUseId: 'toolu_todo', snapshot });
  await settle();

  const prose = messages().filter((m) => m.role === 'assistant' && m.text === 'background done');
  assert.equal(prose.length, 1);
  assert.equal(prose[0].blockId, 'blk-bg');
  assert.ok(!messages().some((m) => m.text === RATE_LIMIT_TEXT), 'the rate-limit card waits for the seal');
  assert.equal(messages().find((m) => m.role === 'tool' && m.toolName === 'Grep')?.subagentId, 'toolu_bg');
  assert.ok(bus.some((e) => e.type === 'session.todos'));
});
