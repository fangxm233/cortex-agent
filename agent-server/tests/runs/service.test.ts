import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { AgentProcessSpawner } from '../../src/agent-adapter/types.js';
import { runRegistry } from '../../src/core/run-registry.js';
import * as executionRegistry from '../../src/domain/executions/registry.js';
import { startRun } from '../../src/domain/runs/service.js';
import { engines } from '../../src/domain/runs/engines.js';
import type { RunEvent, RunPhase } from '../../src/domain/runs/events.js';
import type { RunObserver, RunRequest, RunResult } from '../../src/domain/runs/request.js';

// ── the scripted backend ─────────────────────────────────────────────────
//
// This suite's subject is the run layer, so the run is REAL. `startRun` acquires a pooled
// `ClaudeEngineSession` over the daemon's own adapter; the request's
// `isolation.spawner` hands that session a passive fake CLI child, and the test feeds the
// session line-by-line through `session.handleLine` — exactly the seam
// `tests/agent-adapter/replay-harness.ts` uses. The deleted `AgentProcess`/`BackgroundTurnSink`
// fixtures are gone: the engine installs and owns its continuation/injection sinks now, and the
// only observation surface is the run's `RunEvent` stream plus its result promises.

const CLAUDE_MODEL = 'claude-opus-5';

/** A passive CLI child: it exposes the streams `ClaudeSession` attaches to, and the test — not a
 *  script — feeds the session's readline. `killed` records `kill()` so a test can observe that the
 *  run/engine actually tore the backend down. */
interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  exitCode: number | null;
  killed: boolean;
  kill(): boolean;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

let engineSeq = 0;
const openKeys: string[] = [];

/** Let the run/engine's asynchronous fan-out run before asserting on observer events. */
const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function raw(value: unknown): string { return JSON.stringify(value); }

function assistantLine(text: string): string {
  return raw({ type: 'assistant', message: { model: CLAUDE_MODEL, content: [{ type: 'text', text }] } });
}

function resultLine(overrides: Record<string, unknown> = {}): string {
  return raw({
    type: 'result', subtype: 'success', is_error: false, num_turns: 1,
    total_cost_usd: 0.1, session_id: 'backend-1', result: 'done', ...overrides,
  });
}

function taskStarted(id: string): string {
  return raw({ type: 'system', subtype: 'task_started', task_id: id, task_type: 'local_bash' });
}

function taskCompleted(id: string): string {
  return raw({ type: 'system', subtype: 'task_updated', task_id: id, patch: { status: 'completed' } });
}

function taskNotification(id: string): string {
  return raw({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed', summary: 'done' });
}

interface ScriptedRun {
  run: ReturnType<typeof startRun>;
  session: any;
  engine: any;
  key: string;
  children: FakeChild[];
}

/**
 * Start one run over a fresh pooled engine with a passive fake CLI child, and hand back the
 * Claude session so the test can feed it CLI lines. Each run gets a unique pool key, so a session
 * from a previous test can never be reused (the pool's identity check does not see the spawner).
 */
function startScriptedRun(
  overrides: Partial<RunRequest> = {},
  observers: RunObserver[] = [],
): ScriptedRun {
  const key = `service-run-${++engineSeq}`;
  const children: FakeChild[] = [];
  const request = makeRequest(overrides);
  request.session = { ...request.session, engineKey: key };
  request.isolation = {
    spawner: (() => {
      const child = makeChild();
      children.push(child);
      return { process: child as any };
    }) as AgentProcessSpawner,
  };
  openKeys.push(key);
  const run = startRun(request, observers);
  const engine = engines.get(key) as any;
  assert.ok(engine, 'startRun acquired a pooled engine for the run');
  return { run, session: engine.session, engine, key, children };
}

// ── fixtures ─────────────────────────────────────────────────────────────

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

// The engine owns the background watchdog and reads its two bounds from the environment when a
// run opens. Pin them to small real windows: the run's own timers are observable without faking
// global timers, which the pooled `ClaudeSession` also uses for its 60/65-minute idle timers.
const GRACE_MS = 100;
const MAX_WAIT_MS = 400;
const originalGrace = process.env.CORTEX_BG_GRACE_S;
const originalMaxWait = process.env.CORTEX_BG_WAIT_MAX_S;

beforeEach(() => {
  process.env.CORTEX_BG_GRACE_S = String(GRACE_MS / 1000);
  process.env.CORTEX_BG_WAIT_MAX_S = String(MAX_WAIT_MS / 1000);
});

afterEach(async () => {
  for (const entry of runRegistry.getAll()) runRegistry.remove(entry.registryKey);
  for (const key of openKeys.splice(0)) {
    const engine = engines.get(key) as any;
    // kill() clears the session's real idle/turn timers before the pool close sees it dead.
    try { engine?.session?.kill?.(); } catch {}
    await engines.close(key);
  }
  if (originalGrace === undefined) delete process.env.CORTEX_BG_GRACE_S;
  else process.env.CORTEX_BG_GRACE_S = originalGrace;
  if (originalMaxWait === undefined) delete process.env.CORTEX_BG_WAIT_MAX_S;
  else process.env.CORTEX_BG_WAIT_MAX_S = originalMaxWait;
});

/** Stage a held foreground: the result carries the background counts the scripted CLI produced. */
async function startHeldRun(tasks: 'running' | 'undelivered') {
  const seen = collector();
  const started = startScriptedRun({}, [seen.observer]);
  if (tasks === 'running') started.session.handleLine(taskStarted('bg-1'));
  if (tasks === 'undelivered') {
    started.session.handleLine(taskStarted('bg-1'));
    started.session.handleLine(taskCompleted('bg-1'));
  }
  started.session.handleLine(assistantLine('fg'));
  started.session.handleLine(resultLine({ result: 'fg' }));
  await tick();
  return { ...started, seen };
}

// ── foreground happy path: fan-out order + bookkeeping ───────────────────

test('startRun fans engine events out in order and closes the execution and registry exactly once', async () => {
  const seen = collector();
  const { run, session } = startScriptedRun({}, [seen.observer]);

  assert.equal(run.status, 'running');
  assert.ok(runRegistry.getById(run.executionId), 'registered while running');
  assert.equal(executionRegistry.getExecution(run.executionId)?.status, 'running');
  assert.equal(run.id, 'run-1');

  session.handleLine(assistantLine('done'));
  session.handleLine(resultLine());

  const result = await run.settled;
  assert.equal(result.finalOutput, 'done');
  assert.equal(run.status, 'completed');
  assert.equal(run.phase, 'done');
  assert.equal(run.numTurns, 1);
  assert.equal(run.backendSessionId, 'backend-1');
  assert.equal(runRegistry.getById(run.executionId), null, 'removed on terminal');
  assert.equal(executionRegistry.getExecution(run.executionId)?.status, 'completed');

  // The engine's stream drops `turn_complete` and derives a `cost_record` from the settled turn,
  // so the old double `turn_progress` (the legacy onProgress-on-complete) is now a single live
  // progress event plus accounting. The turn count still reaches the run twice — once from the
  // live event, once from the resolved foreground result — which is what keeps `run.numTurns`.
  assert.deepEqual(seen.events.map((event) => event.type), [
    'engine_started', 'assistant_text', 'turn_progress', 'cost_record', 'foreground_result', 'phase',
  ]);
  assert.equal((seen.events.at(-1) as Extract<RunEvent, { type: 'phase' }>).phase, 'done');
  assert.equal(seen.isClosed(), true);
});

// ── foreground → background → done ───────────────────────────────────────

test('startRun enters the background phase and settles after the continuation reports done', async () => {
  const seen = collector();
  const { run, session, key, engine } = startScriptedRun({}, [seen.observer]);

  session.handleLine(taskStarted('bg-1'));
  session.handleLine(assistantLine('fg'));
  session.handleLine(resultLine({ result: 'fg' }));

  // The engine installs its own background-turn sink on the session (the old single-slot
  // `BackgroundTurnSink` fixture is no longer the observation point).
  assert.ok(session.backgroundTurnSink, 'the engine installed its background-turn sink');
  // `legacyProcess()` is gone: the run holds a live pooled engine session, and its backend
  // session id is recorded from the settled result (asserted below).
  assert.equal(engines.get(key), engine, 'the pooled engine session stays live for the run');
  assert.equal(session.isAlive(), true, 'the run holds a live backend session');
  assert.ok(runRegistry.getById(run.executionId), 'stays registered through the background phase');

  // Let the foreground result settle and the engine enter its background phase before the CLI
  // opens the spontaneous continuation turn. Feeding the notification synchronously would open
  // that turn before `ContinuationPhase.start` runs, so `onTurnOpen` would be a no-op and the
  // second background boundary would never be emitted (see continuation-phase.test.ts).
  await tick();
  session.handleLine(taskNotification('bg-1'));
  session.handleLine(assistantLine('bg'));
  session.handleLine(resultLine({ result: 'bg' }));

  const settled = await run.settled;
  const foreground = await run.result;
  assert.equal(foreground.finalOutput, 'fg');
  assert.equal(settled.finalOutput, 'bg');
  assert.equal(run.backendSessionId, 'backend-1', 'the run exposes its backend session id');
  assert.equal(run.status, 'completed');
  assert.equal(run.phase, 'done');
  assert.equal(runRegistry.getById(run.executionId), null);
  assert.equal(executionRegistry.getExecution(run.executionId)?.status, 'completed');

  // The engine emits the background boundary at the foreground result and again when the
  // spontaneous turn opens, then the background turn's text and result, then the terminal phase.
  // The run's own `foreground_result` is fanned when the attempt's foreground promise resolves;
  // `startAttempt` drains that promise together with the whole event stream, so its position
  // relative to the background events is an artifact of that drain, not a phase fact. Asserting
  // the order with it removed keeps the whole fan-out sequence pinned without pinning the drain.
  assert.deepEqual(phaseEvents(seen.events), ['background', 'background', 'done']);
  assert.deepEqual(
    seen.events.filter((event) => event.type !== 'foreground_result').map((event) => event.type),
    [
      'engine_started', 'assistant_text', 'turn_progress', 'cost_record', 'phase', 'phase',
      'assistant_text', 'background_result', 'phase',
    ],
  );
  assert.ok(seen.events.some((event) => event.type === 'foreground_result'));
});

// ── the caller's foreground await ────────────────────────────────────────
//
// The whole point of `hold`: the surface gets the turn's reply while the run is STILL ALIVE, so it
// can hold its status message open and subscribe to what the backend does next. Binding the
// foreground await to the drained stream instead withholds an interactive reply for the entire
// background window — and a still-running task is capped at 30 minutes whose expiry deliberately
// does not end the run, so the reply could be withheld with no bound at all.

test('hold: the foreground result lands while the background phase is still open', async () => {
  const { run, seen } = await startHeldRun('running');

  const foreground = await Promise.race([
    run.result,
    delay(GRACE_MS + 50).then(() => 'still-waiting' as const),
  ]);
  assert.notEqual(foreground, 'still-waiting', 'the caller is not held for the background phase');
  assert.equal((foreground as RunResult).finalOutput, 'fg');

  assert.equal(run.status, 'background', 'the run says what it is doing');
  assert.equal(run.phase, 'background');
  assert.ok(runRegistry.getById(run.executionId), 'still registered — the run is not over');
  assert.equal(executionRegistry.getExecution(run.executionId)?.status, 'running');

  // The run's own marker is fanned out before the phase it opens, so a transcript reads in order.
  const types = seen.events.map((e) => e.type);
  assert.ok(types.indexOf('foreground_result') < types.indexOf('phase'),
    `foreground_result must precede the background phase: ${types.join(',')}`);
});

test('hold: a surface that subscribes on the foreground result still gets the whole background phase', async () => {
  const { run, session } = await startHeldRun('running');
  await run.result;

  // Exactly what `holdWebSessionForBackground` / `status-renderer` do: subscribe once the turn's
  // reply is in hand. A run that had already gone terminal would accept the observer and then
  // never call it — the hold would publish "background running" with nothing left to seal it.
  const late = collector();
  run.subscribe(late.observer);

  session.handleLine(taskNotification('bg-1'));
  session.handleLine(assistantLine('bg'));
  session.handleLine(resultLine({ result: 'bg' }));
  await run.settled;

  assert.deepEqual(
    late.events.map((e) => e.type),
    ['phase', 'assistant_text', 'background_result', 'phase'],
  );
  assert.equal(late.isClosed(), true, 'the late subscriber is closed with the run');
});

test('inline: the caller waits for the merged result, not the foreground turn', async () => {
  const seen = collector();
  const { run, session } = startScriptedRun(
    { policy: { ...makeRequest().policy, background: 'inline' } }, [seen.observer],
  );
  session.handleLine(taskStarted('bg-1'));
  session.handleLine(assistantLine('fg'));
  session.handleLine(resultLine({ result: 'fg' }));
  await tick();

  const early = await Promise.race([run.result, delay(50).then(() => 'still-waiting' as const)]);
  assert.equal(early, 'still-waiting', 'an inline caller has no status message to hold');

  session.handleLine(taskNotification('bg-1'));
  session.handleLine(assistantLine('bg'));
  session.handleLine(resultLine({ result: 'bg' }));
  assert.equal((await run.result).finalOutput, 'bg', 'the merged result reaches the caller');
});

// ── the background watchdog ──────────────────────────────────────────────
//
// The engine owns the grace / max-wait bounds. Before the engine path they lived in each
// SURFACE's hold, so a run whose hold sealed its own status and walked away stayed in
// `background` forever: execution record `running`, registry entry present, session reported
// busy — with nothing left that could ever end it.

test('grace: unnotified background work finalizes the run instead of waiting forever', async () => {
  const { run, seen } = await startHeldRun('undelivered');
  assert.ok(
    seen.events.some((event) => event.type === 'phase' && event.phase === 'background'),
    'entered the background phase',
  );
  assert.ok(runRegistry.getById(run.executionId), 'held while waiting');

  await delay(GRACE_MS + 50);

  assert.deepEqual(
    seen.events.filter((e) => e.type === 'background_timeout'),
    [{ type: 'background_timeout', reason: 'grace' }],
  );
  assert.equal(run.phase, 'done');
  assert.equal(run.status, 'completed');
  assert.equal(runRegistry.getById(run.executionId), null, 'registry entry released');
  assert.equal(executionRegistry.getExecution(run.executionId)?.status, 'completed');
  assert.equal((await run.settled).finalOutput, 'fg');
});

test('max-wait: a never-ending task stops the wait but NOT the run', async () => {
  const { session, seen, run } = await startHeldRun('running');

  await delay(GRACE_MS + 50);
  assert.equal(seen.events.some((e) => e.type === 'background_timeout'), false,
    'running work is bounded by the cap, not the grace period');

  await delay(MAX_WAIT_MS);
  assert.deepEqual(
    seen.events.filter((e) => e.type === 'background_timeout'),
    [{ type: 'background_timeout', reason: 'max-wait' }],
  );
  // The cap releases the WAIT, not the run: a tunnel that finishes an hour later still lands.
  assert.ok(runRegistry.getById(run.executionId), 'still registered after the cap');

  session.handleLine(taskNotification('bg-1'));
  session.handleLine(assistantLine('late'));
  session.handleLine(resultLine({ result: 'late' }));
  assert.equal((await run.settled).finalOutput, 'late');
  assert.equal(run.phase, 'done');
});

test('an open continuation turn pauses the watchdog — its length is unbounded', async () => {
  const { session, seen, run } = await startHeldRun('undelivered');

  // The spontaneous turn opens just before the grace period would have expired.
  session.handleLine(taskNotification('bg-1'));
  session.handleLine(assistantLine('streaming'));
  await delay(MAX_WAIT_MS * 2);

  assert.equal(seen.events.some((e) => e.type === 'background_timeout'), false,
    'a watchdog that fires mid-turn would seal a turn that is actively streaming');
  assert.ok(
    seen.events.some((event) => event.type === 'phase' && event.phase === 'background'),
    'still streaming the background phase',
  );
});

test('chained background work re-arms the watchdog with the new counts', async () => {
  const { session, seen, run } = await startHeldRun('running');

  // The continuation turn reports MORE work, of the unnotified kind: the bound changes from the
  // max-wait cap to the grace period.
  session.handleLine(taskNotification('bg-1'));
  session.handleLine(taskStarted('bg-2'));
  session.handleLine(taskStarted('bg-3'));
  session.handleLine(taskCompleted('bg-2'));
  session.handleLine(taskCompleted('bg-3'));
  session.handleLine(assistantLine('chained'));
  session.handleLine(resultLine({ result: 'chained' }));
  await tick();
  const background = seen.events.find(
    (event): event is Extract<RunEvent, { type: 'background_result' }> =>
      event.type === 'background_result',
  );
  assert.equal(background?.result.undeliveredBackgroundTasks, 2, 'chained work remains');

  await delay(GRACE_MS + 50);
  assert.deepEqual(
    seen.events.filter((e) => e.type === 'background_timeout'),
    [{ type: 'background_timeout', reason: 'grace' }],
  );
  assert.equal(run.phase, 'done');
});

test('an expired wait never re-arms: the cap means stop waiting, not restart the clock', async () => {
  const { session, seen } = await startHeldRun('running');
  await delay(MAX_WAIT_MS + 50);
  assert.equal(seen.events.filter((e) => e.type === 'background_timeout').length, 1);

  session.handleLine(taskNotification('bg-1'));
  session.handleLine(taskStarted('bg-2'));
  session.handleLine(taskStarted('bg-3'));
  session.handleLine(taskStarted('bg-4'));
  session.handleLine(assistantLine('more'));
  session.handleLine(resultLine({ result: 'more' }));
  await delay(MAX_WAIT_MS * 3);

  assert.equal(seen.events.filter((e) => e.type === 'background_timeout').length, 1,
    'one cap per run, not one per report');
  assert.ok(
    seen.events.some((event) => event.type === 'phase' && event.phase === 'background'),
    'still in the background phase',
  );
});

// ── cancel ───────────────────────────────────────────────────────────────

test('cancel() kills the process, closes the record and reaches the cancelled terminal', async () => {
  const seen = collector();
  const { run, session, children } = startScriptedRun({}, [seen.observer]);
  const settledOutcome = run.settled.then(() => 'resolved' as const, (error: unknown) => error);
  const resultOutcome = run.result.then(() => 'resolved' as const, (error: unknown) => error);
  assert.ok(runRegistry.getById(run.executionId));

  session.handleLine(assistantLine('working'));
  run.cancel('user');

  assert.equal(children[0].killed, true);
  assert.equal(session.isAlive(), false, 'the engine session was torn down');
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
  const seen = collector();
  const throwing: RunObserver = { onEvent: () => { throw new Error('observer boom'); } };
  const { run, session } = startScriptedRun({}, [throwing, seen.observer]);

  session.handleLine(assistantLine('done'));
  session.handleLine(resultLine());

  const result = await run.settled;
  assert.equal(result.finalOutput, 'done');
  assert.equal(run.status, 'completed');
  assert.ok(seen.events.some((event) => event.type === 'foreground_result'));
});

test('a throwing required observer fails the run and kills the process', async () => {
  const required: RunObserver = {
    required: true,
    onEvent: () => { throw new Error('required boom'); },
  };
  const { run, children } = startScriptedRun({}, [required]);
  void run.result.catch(() => undefined);
  // The required observer throws on the engine's first event; no foreground line is needed.
  const outcome = await run.settled.then(() => 'resolved' as const, (error: unknown) => error);

  assert.ok(outcome instanceof Error);
  assert.equal(run.status, 'failed');
  assert.equal(children[0].killed, true);
  assert.equal(runRegistry.getById(run.executionId), null);
});

// ── steer owns the injection ack translation in the engine ───────────────

test('steer delivers a message to the live engine and fans the ack out as injection_delivered', async () => {
  const seen = collector();
  const { run, session } = startScriptedRun({}, [seen.observer]);
  assert.equal(runRegistry.getRunByChannel('web:sess-1'), run, 'the registry exposes the live run');

  session.handleLine(assistantLine('working'));
  assert.deepEqual(await run.steer({ text: 'keep going' }, 'inj-1'), 'folded');

  // The engine owns the ack translation now: the CLI's `--replay-user-messages` echo is the
  // delivery, and the caller's injectionId is what the fanned event is correlated by.
  session.handleLine(raw({
    type: 'user', isReplay: true, session_id: 'backend-1',
    message: { role: 'user', content: 'keep going' },
  }));
  await tick();

  const event = seen.events.find(
    (candidate): candidate is Extract<RunEvent, { type: 'injection_delivered' }> =>
      candidate.type === 'injection_delivered',
  );
  assert.deepEqual(event, { type: 'injection_delivered', injectionId: 'inj-1', foldedIntoTurn: true });

  run.cancel('user');
  await run.settled.catch(() => undefined);
});

test('steer refuses without a live engine and reports the refusal as injection_rejected', async () => {
  const seen = collector();
  const { run, session } = startScriptedRun({}, [seen.observer]);
  session.kill(); // no live backend to write to

  assert.equal(await run.steer({ text: 'nope' }, 'inj-2'), 'refused');
  await tick();

  // The engine owns the refusal translation: an accepted-but-unknown state is a
  // `injection_rejected` event carrying the caller's id and the reason.
  const rejected = seen.events.find(
    (event): event is Extract<RunEvent, { type: 'injection_rejected' }> =>
      event.type === 'injection_rejected',
  );
  assert.deepEqual(rejected, { type: 'injection_rejected', injectionId: 'inj-2', reason: 'refused' });

  run.cancel('user');
  await run.settled.catch(() => undefined);
});

// ── respondToDialog is the run's one dialog channel ──────────────────────

test('respondToDialog forwards to the live engine and surfaces its boolean', async () => {
  // Claude exposes no extension-UI dialog channel (`respondToDialog` is always false), so the
  // run-layer contract under test is the forwarding itself: the real engine's method is observed
  // while everything else stays a real run.
  const refusedCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const refused = startScriptedRun({ runId: 'run-dialog-refused' }, [collector().observer]);
  refused.engine.respondToDialog = (id: string, payload: Record<string, unknown>) => {
    refusedCalls.push({ id, payload });
    return false;
  };

  assert.equal(refused.run.respondToDialog('ui-refused', { value: 'no' }), false);
  assert.deepEqual(refusedCalls, [{ id: 'ui-refused', payload: { value: 'no' } }]);
  refused.run.cancel('user');
  await refused.run.settled.catch(() => undefined);

  const acceptedCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const accepted = startScriptedRun({ runId: 'run-dialog-accepted' }, [collector().observer]);
  accepted.engine.respondToDialog = (id: string, payload: Record<string, unknown>) => {
    acceptedCalls.push({ id, payload });
    return true;
  };

  assert.equal(accepted.run.respondToDialog('ui-accepted', { value: 'yes' }), true);
  assert.deepEqual(acceptedCalls, [{ id: 'ui-accepted', payload: { value: 'yes' } }]);
  accepted.run.cancel('user');
  await accepted.run.settled.catch(() => undefined);
});

test('a post-result injection keeps the run open until the spontaneous turn settles', async () => {
  const seen = collector();
  const { run, session } = startScriptedRun({}, [seen.observer]);
  session.handleLine(assistantLine('working'));

  assert.equal(await run.steer({ text: 'after the result' }, 'inj-3'), 'folded');

  session.handleLine(resultLine({ result: 'fg' }));
  await tick();
  // The injection obligation keeps the ENGINE's background phase open after the foreground
  // result; the run's own mirrored phase tracks background *tasks*, so the authoritative signal
  // here is the background phase event and the still-live registry entry.
  assert.ok(
    seen.events.some((event) => event.type === 'phase' && event.phase === 'background'),
    'a pending injection holds the run open',
  );
  assert.ok(runRegistry.getById(run.executionId), 'still registered while the injection is pending');

  // The CLI drains the queue after the result: the echo acks with foldedIntoTurn=false and opens
  // a spontaneous turn, whose reply reaches the run through the engine's continuation phase. The
  // run ends by itself once that reply lands — nothing has to cancel it.
  session.handleLine(raw({
    type: 'user', isReplay: true, session_id: 'backend-1',
    message: { role: 'user', content: 'after the result' },
  }));
  session.handleLine(assistantLine('spontaneous reply'));
  session.handleLine(resultLine({ result: 'spontaneous reply' }));

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
