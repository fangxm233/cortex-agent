// input:  domain/runs/service.ts startRun plus a fake adapter driven through facade.runWithAdapter
// output: spec for RunEvent fan-out, phase transitions, bookkeeping, cancel and observer safety
// pos:    P1.3 contract — startRun is the single entry point wrapping facade.runAgent
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

import type {
  AgentAdapter, AgentProcess, ContinuationSink, InjectionAckSink, UserMessage,
} from '../../src/agent-adapter/types.js';
import { CAPABILITIES_BY_BACKEND } from '../../src/agent-adapter/capabilities.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';
import type { AgentResult } from '../../src/core/types/agent-types.js';
import type { AgentConfig, RunAgentOptions } from '../../src/domain/agents/spawn-config.js';
import { runRegistry } from '../../src/core/run-registry.js';
import * as executionRegistry from '../../src/domain/executions/registry.js';
import { startRun } from '../../src/domain/runs/service.js';
import type { RunEvent, RunPhase } from '../../src/domain/runs/events.js';
import type { RunObserver, RunRequest } from '../../src/domain/runs/request.js';

// The fake adapter is installed on a hoisted holder so the vi.mock factory (hoisted above imports)
// can reach it. runAgent is routed through the real facade's runWithAdapter, so P1.3 exercises the
// production event tee / observer wiring rather than a re-implementation of it.
const holder = vi.hoisted(() => ({
  adapter: undefined as AgentAdapter | undefined,
  config: { model: 'm', backend: 'claude', mode: null } as AgentConfig,
}));

vi.mock('../../src/domain/agents/facade.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/domain/agents/facade.js')>();
  return {
    ...actual,
    runAgent: (message: string, options: RunAgentOptions) => {
      if (!holder.adapter) throw new Error('service.test: fake adapter not installed');
      return actual._test.runWithAdapter(holder.adapter, message, options, holder.config, undefined);
    },
  };
});

// ── fixtures ─────────────────────────────────────────────────────────────

function defaultResult(sessionId = 'backend-1', overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId,
    total_cost_usd: 0.1,
    num_turns: 1,
    rateLimited: false,
    rateLimitMessage: null,
    planFilePath: null,
    enteredPlanMode: false,
    exitedPlanMode: false,
    finalOutput: 'done',
    ...overrides,
  };
}

interface FakeProcess extends AgentProcess {
  continuationSink?: ContinuationSink;
  readonly killed: boolean;
  resolveSend(result: AgentResult): void;
}

interface FakeProcess extends AgentProcess {
  continuationSink?: ContinuationSink;
  injectionAckSink?: InjectionAckSink;
  readonly killed: boolean;
  readonly dialogCalls: Array<{ id: string; payload: Record<string, unknown> }>;
  sendExtensionUiResponse(id: string, payload: Record<string, unknown>): boolean;
  resolveSend(result: AgentResult): void;
}

interface FakeProcessSpec {
  events?: NormalizedEvent[];
  result?: AgentResult;
  /** Keep send() pending (and the event stream open) until kill()/resolveSend(). */
  hold?: boolean;
  sessionId?: string;
  /** False makes `injectUserMessage` refuse (no live turn / dead process). */
  injectAccepted?: boolean;
  /** False makes `sendExtensionUiResponse` report "no live dialog waits on this id". */
  dialogAccepted?: boolean;
}

/** The fake-process pattern from tests/run-with-adapter.test.ts, extended with a continuation sink
 *  (the P1.3 background path) and a held send (the cancel path). */
function makeFakeProcess(spec: FakeProcessSpec = {}): FakeProcess {
  const buffer: NormalizedEvent[] = [];
  const waiters: Array<(result: IteratorResult<NormalizedEvent>) => void> = [];
  let closed = false;
  let killed = false;
  let rejectSend: ((error: unknown) => void) | null = null;
  let resolveSend: ((result: AgentResult) => void) | null = null;

  const push = (event: NormalizedEvent): void => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else buffer.push(event);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    while (waiters.length) {
      waiters.shift()!({ value: undefined as unknown as NormalizedEvent, done: true });
    }
  };

  const process: FakeProcess = {
    sessionKey: 'fake-key',
    sessionId: spec.sessionId ?? 'backend-1',
    dialogCalls: [],
    get killed() { return killed; },
    send(_message: UserMessage): Promise<AgentResult> {
      for (const event of spec.events ?? []) push(event);
      if (!spec.hold) {
        close();
        return Promise.resolve(spec.result ?? defaultResult(spec.sessionId));
      }
      return new Promise<AgentResult>((resolve, reject) => {
        resolveSend = resolve;
        rejectSend = reject;
      });
    },
    events: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<NormalizedEvent>> {
            if (buffer.length > 0) return Promise.resolve({ value: buffer.shift()!, done: false });
            if (closed) {
              return Promise.resolve({ value: undefined as unknown as NormalizedEvent, done: true });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    },
    setContinuationSink(sink: ContinuationSink): void { process.continuationSink = sink; },
    injectUserMessage(_message: UserMessage): boolean { return spec.injectAccepted !== false; },
    sendExtensionUiResponse(id: string, payload: Record<string, unknown>): boolean {
      process.dialogCalls.push({ id, payload });
      return spec.dialogAccepted !== false;
    },
    setInjectionAckSink(sink: InjectionAckSink): void { process.injectionAckSink = sink; },
    async close(): Promise<void> { close(); },
    kill(): boolean {
      killed = true;
      close();
      rejectSend?.(Object.assign(new Error('Cancelled'), { cancelled: true }));
      rejectSend = null;
      resolveSend = null;
      return true;
    },
    resolveSend(result: AgentResult): void { resolveSend?.(result); resolveSend = null; },
  };
  return process;
}

function makeFakeAdapter(process: AgentProcess): AgentAdapter {
  return {
    backend: 'claude',
    capabilities: CAPABILITIES_BY_BACKEND.claude,
    spawn: () => process,
    async close() {},
    kill() { return false; },
    listSessions() { return []; },
  };
}

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: 'run-1',
    session: {
      sessionId: 'sess-1', backendSessionId: null, engineKey: 'sess-1', sessionName: 'session-1',
    },
    profile: {
      name: 'test', model: 'm', backend: 'claude', mode: 'plan', provider: null,
      extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null, fallback: [],
    },
    spec: {
      systemPrompt: null, directive: null, promptTemplate: null, tools: null, pluginDirs: [],
      mcp: { composition: 'direct', allowlist: null }, backendOptions: {},
    },
    prompt: { text: 'hello' },
    context: {
      channel: 'web:sess-1', project: 'general', trigger: 'user', executionKind: 'local',
      isUserInitiated: true, commissionMode: false, commissionTools: false,
    },
    policy: {
      background: 'hold', recordCost: false, hooks: false, loadRules: false,
      mcpComposition: 'direct', captureTranscripts: false,
    },
    ...overrides,
  };
}

interface Collected {
  observer: RunObserver;
  events: RunEvent[];
  isClosed(): boolean;
}

function collector(required = false): Collected {
  const events: RunEvent[] = [];
  let closed = false;
  return {
    observer: {
      required,
      onEvent: (event) => { events.push(event); },
      onClose: () => { closed = true; },
    },
    events,
    isClosed: () => closed,
  };
}

function phaseEvents(events: RunEvent[]): RunPhase[] {
  return events
    .filter((event): event is Extract<RunEvent, { type: 'phase' }> => event.type === 'phase')
    .map((event) => event.phase);
}

afterEach(() => {
  for (const entry of runRegistry.getAll()) runRegistry.remove(entry.registryKey);
  holder.adapter = undefined;
});

// ── foreground happy path: fan-out order + bookkeeping ───────────────────

test('startRun fans adapter events out in order and closes the execution and registry exactly once', async () => {
  const process = makeFakeProcess({
    events: [
      { type: 'session_started', sessionId: 'backend-1' },
      { type: 'assistant_text', text: 'hi' },
      { type: 'turn_progress', numTurns: 1 },
      { type: 'turn_complete', numTurns: 1, totalCostUsd: 0.1 },
    ],
    result: defaultResult('backend-1'),
  });
  holder.adapter = makeFakeAdapter(process);
  const seen = collector();

  const run = startRun(makeRequest(), [seen.observer]);

  assert.equal(run.status, 'running');
  assert.ok(runRegistry.getById(run.executionId), 'registered while running');
  assert.equal(executionRegistry.getExecution(run.executionId)?.status, 'running');
  assert.equal(run.id, 'run-1');

  const result = await run.settled;
  assert.equal(result.finalOutput, 'done');
  assert.equal(run.status, 'completed');
  assert.equal(run.phase, 'done');
  assert.equal(run.numTurns, 1);
  assert.equal(run.backendSessionId, 'backend-1');
  assert.equal(runRegistry.getById(run.executionId), null, 'removed on terminal');
  assert.equal(executionRegistry.getExecution(run.executionId)?.status, 'completed');

  // turn_complete's *result* is deliberately NOT relayed: the authoritative foreground_result comes
  // from the resolved AgentHandle, and a phase done transition closes the run. Its turn count still
  // is: the legacy dispatcher called onProgress on turn_complete too, so the live turn counter and
  // the status line keep receiving the final value — hence the second turn_progress here.
  assert.deepEqual(seen.events.map((event) => event.type), [
    'engine_started', 'assistant_text', 'turn_progress', 'turn_progress', 'foreground_result', 'phase',
  ]);
  assert.equal((seen.events.at(-1) as Extract<RunEvent, { type: 'phase' }>).phase, 'done');
  assert.equal(seen.isClosed(), true);
});

// ── foreground → background → done ───────────────────────────────────────

test('startRun enters the background phase and settles after the continuation reports done', async () => {
  const process = makeFakeProcess({
    events: [
      { type: 'session_started', sessionId: 'backend-1' },
      { type: 'assistant_text', text: 'foreground' },
      { type: 'turn_complete', numTurns: 1, totalCostUsd: 0.1 },
    ],
    result: defaultResult('backend-1', { pendingBackgroundTasks: 1, finalOutput: 'fg' }),
  });
  holder.adapter = makeFakeAdapter(process);
  const seen = collector();

  const run = startRun(makeRequest(), [seen.observer]);
  const foreground = await run.result;
  assert.equal(foreground.finalOutput, 'fg');
  assert.equal(run.status, 'background');
  assert.equal(run.phase, 'background');
  assert.ok(process.continuationSink, 'continuation sink installed on the process');
  assert.ok(run.legacyProcess(), 'transitional legacyProcess() exposes the raw process');
  assert.ok(runRegistry.getById(run.executionId), 'stays registered through the background phase');

  process.continuationSink!.onAssistantText('bg text', 'model');
  process.continuationSink!.onResult(
    defaultResult('backend-1', { pendingBackgroundTasks: 0, finalOutput: 'bg' }),
  );

  const settled = await run.settled;
  assert.equal(settled.finalOutput, 'bg');
  assert.equal(run.status, 'completed');
  assert.equal(run.phase, 'done');
  assert.equal(runRegistry.getById(run.executionId), null);
  assert.equal(executionRegistry.getExecution(run.executionId)?.status, 'completed');

  assert.deepEqual(seen.events.map((event) => event.type), [
    // turn_complete's count is republished as turn_progress (the legacy onProgress-on-complete).
    'engine_started', 'assistant_text', 'turn_progress', 'foreground_result', 'phase',
    'assistant_text', 'background_result', 'phase',
  ]);
  assert.deepEqual(phaseEvents(seen.events), ['background', 'done']);
});

// ── the background watchdog (P4.1c) ──────────────────────────────────────
//
// The run owns the grace / max-wait bounds. Before P4.1c they lived in each SURFACE's hold, so a
// run whose hold sealed its own status and walked away stayed in `background` forever: execution
// record `running`, registry entry present, session reported busy — with nothing left that could
// ever end it.

const GRACE_MS = 90_000;
const MAX_WAIT_MS = 1_800_000;

async function startHeldRun(result: Partial<AgentResult>) {
  const process = makeFakeProcess({
    events: [{ type: 'session_started', sessionId: 'backend-1' }],
    result: defaultResult('backend-1', { finalOutput: 'fg', ...result }),
  });
  holder.adapter = makeFakeAdapter(process);
  const seen = collector();
  const run = startRun(makeRequest(), [seen.observer]);
  await run.result;
  return { process, seen, run };
}

test('grace: unnotified background work finalizes the run instead of waiting forever', async () => {
  vi.useFakeTimers();
  try {
    const { seen, run } = await startHeldRun({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 });
    assert.equal(run.phase, 'background');
    assert.ok(runRegistry.getById(run.executionId), 'held while waiting');

    await vi.advanceTimersByTimeAsync(GRACE_MS + 1);

    assert.deepEqual(
      seen.events.filter((e) => e.type === 'background_timeout'),
      [{ type: 'background_timeout', reason: 'grace' }],
    );
    assert.equal(run.phase, 'done');
    assert.equal(run.status, 'completed');
    assert.equal(runRegistry.getById(run.executionId), null, 'registry entry released');
    assert.equal(executionRegistry.getExecution(run.executionId)?.status, 'completed');
    assert.equal((await run.settled).finalOutput, 'fg');
  } finally {
    vi.useRealTimers();
  }
});

test('max-wait: a never-ending task stops the wait but NOT the run', async () => {
  vi.useFakeTimers();
  try {
    const { process, seen, run } = await startHeldRun({ pendingBackgroundTasks: 1 });

    await vi.advanceTimersByTimeAsync(GRACE_MS + 1);
    assert.equal(seen.events.some((e) => e.type === 'background_timeout'), false,
      'running work is bounded by the cap, not the grace period');

    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);
    assert.deepEqual(
      seen.events.filter((e) => e.type === 'background_timeout'),
      [{ type: 'background_timeout', reason: 'max-wait' }],
    );
    // The cap releases the WAIT, not the run: a tunnel that finishes an hour later still lands.
    assert.equal(run.phase, 'background');
    assert.ok(runRegistry.getById(run.executionId), 'still registered after the cap');

    process.continuationSink!.onResult(defaultResult('backend-1', { pendingBackgroundTasks: 0, finalOutput: 'late' }));
    assert.equal((await run.settled).finalOutput, 'late');
    assert.equal(run.phase, 'done');
  } finally {
    vi.useRealTimers();
  }
});

test('an open continuation turn pauses the watchdog — its length is unbounded', async () => {
  vi.useFakeTimers();
  try {
    const { process, seen, run } = await startHeldRun({ pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 1 });

    // The spontaneous turn opens just before the grace period would have expired.
    process.continuationSink!.onTurnOpen!();
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS * 2);

    assert.equal(seen.events.some((e) => e.type === 'background_timeout'), false,
      'a watchdog that fires mid-turn would seal a turn that is actively streaming');
    assert.equal(run.phase, 'background');
  } finally {
    vi.useRealTimers();
  }
});

test('chained background work re-arms the watchdog with the new counts', async () => {
  vi.useFakeTimers();
  try {
    const { process, seen, run } = await startHeldRun({ pendingBackgroundTasks: 1 });

    // The continuation turn reports MORE work, of the unnotified kind: the bound changes from the
    // 30-minute cap to the 90-second grace period.
    process.continuationSink!.onTurnOpen!();
    process.continuationSink!.onResult(defaultResult('backend-1', {
      pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 2, finalOutput: 'chained',
    }));
    assert.equal(run.phase, 'background', 'work remains, so the run keeps holding');

    await vi.advanceTimersByTimeAsync(GRACE_MS + 1);
    assert.deepEqual(
      seen.events.filter((e) => e.type === 'background_timeout'),
      [{ type: 'background_timeout', reason: 'grace' }],
    );
    assert.equal(run.phase, 'done');
  } finally {
    vi.useRealTimers();
  }
});

test('an expired wait never re-arms: the cap means stop waiting, not restart the clock', async () => {
  vi.useFakeTimers();
  try {
    const { process, seen, run } = await startHeldRun({ pendingBackgroundTasks: 1 });
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);
    assert.equal(seen.events.filter((e) => e.type === 'background_timeout').length, 1);

    process.continuationSink!.onResult(defaultResult('backend-1', { pendingBackgroundTasks: 3, finalOutput: 'more' }));
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS * 3);
    assert.equal(seen.events.filter((e) => e.type === 'background_timeout').length, 1,
      'one cap per run, not one per report');
    assert.equal(run.phase, 'background');
  } finally {
    vi.useRealTimers();
  }
});

// ── cancel ───────────────────────────────────────────────────────────────

test('cancel() kills the process, closes the record and reaches the cancelled terminal', async () => {
  const process = makeFakeProcess({
    events: [{ type: 'assistant_text', text: 'working' }], hold: true,
  });
  holder.adapter = makeFakeAdapter(process);
  const seen = collector();

  const run = startRun(makeRequest(), [seen.observer]);
  const settledOutcome = run.settled.then(() => 'resolved' as const, (error: unknown) => error);
  const resultOutcome = run.result.then(() => 'resolved' as const, (error: unknown) => error);
  assert.ok(runRegistry.getById(run.executionId));

  run.cancel('user');

  assert.equal(process.killed, true);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.phase, 'done');
  assert.equal(runRegistry.getById(run.executionId), null);
  assert.equal(executionRegistry.getExecution(run.executionId)?.status, 'cancelled');
  assert.ok((await settledOutcome) instanceof Error);
  assert.ok((await resultOutcome) instanceof Error);
  assert.equal(seen.events.at(-1)?.type, 'phase');
  assert.equal((seen.events.at(-1) as Extract<RunEvent, { type: 'phase' }>).phase, 'done');
});

// ── observer safety ──────────────────────────────────────────────────────

test('a throwing non-required observer is logged and the run still completes', async () => {
  const process = makeFakeProcess({
    events: [
      { type: 'assistant_text', text: 'hi' },
      { type: 'turn_complete', numTurns: 1, totalCostUsd: 0 },
    ],
    result: defaultResult('backend-1'),
  });
  holder.adapter = makeFakeAdapter(process);
  const seen = collector();
  const throwing: RunObserver = { onEvent: () => { throw new Error('observer boom'); } };

  const run = startRun(makeRequest(), [throwing, seen.observer]);

  const result = await run.settled;
  assert.equal(result.finalOutput, 'done');
  assert.equal(run.status, 'completed');
  assert.ok(seen.events.some((event) => event.type === 'foreground_result'));
});

test('a throwing required observer fails the run and kills the process', async () => {
  const process = makeFakeProcess({
    events: [{ type: 'assistant_text', text: 'hi' }], hold: true,
  });
  holder.adapter = makeFakeAdapter(process);
  const required: RunObserver = {
    required: true,
    onEvent: () => { throw new Error('required boom'); },
  };

  const run = startRun(makeRequest(), [required]);
  void run.result.catch(() => undefined);
  const outcome = await run.settled.then(() => 'resolved' as const, (error: unknown) => error);

  assert.ok(outcome instanceof Error);
  assert.equal(run.status, 'failed');
  assert.equal(process.killed, true);
  assert.equal(runRegistry.getById(run.executionId), null);
});

// ── P1.8: steer owns the injection ack -> event translation ───────────────

test('steer delivers a message to the live process and fans the ack out as injection_delivered', async () => {
  const process = makeFakeProcess({ hold: true });
  holder.adapter = makeFakeAdapter(process);
  const seen = collector();

  const run = startRun(makeRequest(), [seen.observer]);
  assert.equal(runRegistry.getRunByChannel('web:sess-1'), run, 'the registry exposes the live run');

  assert.deepEqual(await run.steer({ text: 'keep going' }, 'inj-1'), 'folded');
  assert.ok(process.injectionAckSink, 'the run installed the injection ack sink');

  process.injectionAckSink!.onDelivered({ text: 'keep going', foldedIntoTurn: true });

  const event = seen.events.find(
    (candidate): candidate is Extract<RunEvent, { type: 'injection_delivered' }> =>
      candidate.type === 'injection_delivered',
  );
  assert.deepEqual(event, { type: 'injection_delivered', injectionId: 'inj-1', foldedIntoTurn: true });

  run.cancel('user');
  await run.settled.catch(() => undefined);
});

test('steer refuses without a live process and emits no injection event', async () => {
  const process = makeFakeProcess({ hold: true, injectAccepted: false });
  holder.adapter = makeFakeAdapter(process);
  const seen = collector();

  const run = startRun(makeRequest(), [seen.observer]);
  assert.equal(await run.steer({ text: 'nope' }, 'inj-2'), 'refused');
  assert.equal(seen.events.some((event) => event.type.startsWith('injection_')), false);

  run.cancel('user');
  await run.settled.catch(() => undefined);
});

// ── P2.4: respondToDialog is the run's one dialog channel ────────────────

test('respondToDialog forwards to the live process and surfaces its boolean', async () => {
  const refused = makeFakeProcess({ hold: true, dialogAccepted: false });
  holder.adapter = makeFakeAdapter(refused);
  const refusedRun = startRun(makeRequest({ runId: 'run-dialog-refused' }), [collector().observer]);

  assert.equal(refusedRun.respondToDialog('ui-refused', { value: 'no' }), false);
  assert.deepEqual(refused.dialogCalls, [{ id: 'ui-refused', payload: { value: 'no' } }]);
  refusedRun.cancel('user');
  await refusedRun.settled.catch(() => undefined);

  const accepted = makeFakeProcess({ hold: true });
  holder.adapter = makeFakeAdapter(accepted);
  const acceptedRun = startRun(makeRequest({ runId: 'run-dialog-accepted' }), [collector().observer]);

  assert.equal(acceptedRun.respondToDialog('ui-accepted', { value: 'yes' }), true);
  assert.deepEqual(accepted.dialogCalls, [{ id: 'ui-accepted', payload: { value: 'yes' } }]);
  acceptedRun.cancel('user');
  await acceptedRun.settled.catch(() => undefined);
});

test('a post-result injection keeps the run in background until the continuation settles', async () => {
  const process = makeFakeProcess({ hold: true });
  holder.adapter = makeFakeAdapter(process);
  const seen = collector();

  const run = startRun(makeRequest(), [seen.observer]);
  assert.equal(await run.steer({ text: 'after the result' }, 'inj-3'), 'folded');

  process.resolveSend(defaultResult('backend-1', { finalOutput: 'fg' }));
  await process.close();
  const foreground = await run.result;
  assert.equal(foreground.finalOutput, 'fg');
  assert.equal(run.phase, 'background', 'a pending injection holds the run open');

  process.injectionAckSink!.onDelivered({ text: 'after the result', foldedIntoTurn: false });
  process.continuationSink!.onAssistantText('spontaneous reply', 'model');
  process.continuationSink!.onResult(defaultResult('backend-1', { finalOutput: 'spontaneous reply' }));

  const settled = await run.settled;
  assert.equal(settled.finalOutput, 'spontaneous reply');
  assert.equal(run.phase, 'done');
  assert.equal(runRegistry.getById(run.executionId), null);
  assert.deepEqual(
    seen.events
      .filter((event): event is Extract<RunEvent, { type: 'injection_delivered' }> =>
        event.type === 'injection_delivered')
      .map((event) => event.injectionId),
    ['inj-3'],
  );
});
