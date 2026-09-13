// input:  ClaudeAdapter.open driven over one scripted fake CLI process
// output: engine contract: phased RunEvent order/result, failure, cancel/reuse, steer, identity, rate limits
// pos:    Claude EngineSession contract after the legacy spawn() parity half was deleted
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { ClaudeAdapter, claudeCompatibilityIdentity, sameClaudeSpawnCompatibility } from '../../src/agent-adapter/claude/adapter.js';
import type { ClaudeSpawnCompatibility } from '../../src/agent-adapter/claude/adapter.js';
import { toRunEvent, type RunEvent } from '../../src/agent-adapter/run-events.js';
import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';
import type { AgentResult } from '../../src/core/types/agent-types.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';

/** One turn's worth of Claude stream-json: prose, a tool call, its result, then the turn result. */
const TURN_SCRIPT = [
  { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'hello' }] } },
  {
    type: 'assistant',
    message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] },
  },
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a\nb' }] },
  },
  {
    type: 'result', subtype: 'success', is_error: false,
    num_turns: 2, total_cost_usd: 0.25, session_id: 'engine-equiv', result: 'done',
  },
];

/**
 * A fake CLI child. Each write to stdin (a turn prompt, or an injection) consumes the next entry of
 * `scripts` and replays it on stdout; an exhausted queue writes nothing, which is how a test keeps a
 * turn in flight. `emitLines` stages lines by hand, `failWrites` makes the pipe throw so the
 * session takes its EPIPE path.
 */
function scriptedChild(scripts: unknown[][]) {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.kill = () => true;
  child.failWrites = false;
  child.emitLines = (lines: unknown[]) => {
    for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
  };
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = (...args: any[]) => {
    if (child.failWrites) throw new Error('EPIPE');
    return write(...args);
  };
  const queue = [...scripts];
  child.stdin.on('data', () => {
    const next = queue.shift();
    if (next) setImmediate(() => child.emitLines(next));
  });
  return child;
}

function specFor(
  sessionKey: string, scripts: unknown[][], children: any[] = [],
  extra: Record<string, unknown> = {},
) {
  return engineSpecFixture({
    sessionId: 'engine-equiv',
    sessionKey,
    resume: false,
    captureTranscriptLogs: false,
    processSpawner: (() => {
      const child = scriptedChild(scripts);
      children.push(child);
      return { process: child };
    }) as any,
    ...extra,
  });
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

// --- (1) The RunEvent stream is the tapped wire record, phased and terminated -------------------

test('Claude open().run() yields the phased RunEvent stream plus a terminal phase', async () => {
  const adapter = new ClaudeAdapter();
  const engine = adapter.open(specFor('engine-equiv', [TURN_SCRIPT]));

  // The raw protocol record this run forwarded is the authority for the phased stream; tapping the
  // run itself keeps the assertion on the wire rather than on the deleted spawn() surface.
  const raw: NormalizedEvent[] = [];
  const run = engine.run({ text: 'hi' } as any, {
    awaitBackground: 'none',
    onNormalizedEvent: (event) => raw.push(event),
  });
  const runEvents = await drain(run.events);
  const engineResult = await run.result;
  const settled = await run.settled;

  // Literal Claude stream protocol facts (legacy spawn() parity expectations folded in).
  assert.deepEqual(raw.map((event) => event.type), [
    'assistant_text', 'turn_progress', 'tool_use', 'turn_progress', 'tool_result',
    'cost_record', 'turn_complete',
  ]);
  // Non-trivial: the script really did produce a full turn, not an empty stream.
  assert.ok(raw.some((event) => event.type === 'tool_use'), 'script produced no tool_use');
  assert.ok(raw.some((event) => event.type === 'turn_complete'), 'script produced no turn_complete');

  const expectedResult: AgentResult = {
    sessionId: 'engine-equiv',
    total_cost_usd: 0.25,
    num_turns: 2,
    rateLimited: false,
    rateLimitMessage: null,
    planFilePath: null,
    enteredPlanMode: false,
    exitedPlanMode: false,
    askUserQuestions: [],
    finalOutput: 'hello',
    reportedAccounting: {
      usageReported: false,
      inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreationTokens: null,
      promptTokens: null, cachedTokens: null, model: null,
    },
    pendingBackgroundTasks: 0,
    undeliveredBackgroundTasks: 0,
  };

  const expected: RunEvent[] = [
    { type: 'engine_started', backendSessionId: 'engine-equiv' },
    // `turn_complete` is the callback stream's terminal MARKER, not a result: the engine drops it
    // and pushes the authoritative `foreground_result` instead, so a run sees exactly one result
    // event for its turn (and it carries the full AgentResult, not the marker's lossy one).
    ...raw
      .filter((event) => event.type !== 'turn_complete')
      .map((event) => toRunEvent(event, 'foreground')),
    { type: 'foreground_result', result: expectedResult },
    { type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0 },
  ];
  assert.deepEqual(runEvents, expected);
  assert.deepEqual(engineResult, expectedResult);
  assert.deepEqual(settled, expectedResult);

  await engine.close();
});

// --- (2) Failure and cancellation paths ---------------------------------------------------------

test('Claude run(): a failing turn rejects and reports error then phase', async () => {
  const adapter = new ClaudeAdapter();
  const children: any[] = [];
  const engine = adapter.open(specFor('engine-fail', [], children));
  const run = engine.run({ text: 'hi' } as any, { awaitBackground: 'none' });
  // Kill the process with no result line: handleProcessClose settles the turn as a failure.
  setImmediate(() => children[0].emit('close', 1));

  const events = await drain(run.events);
  await assert.rejects(run.result);
  assert.equal(events.at(-1)?.type, 'phase');
  assert.deepEqual(events.at(-1), {
    type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0,
  });
  assert.equal(events.at(-2)?.type, 'error');
  await engine.close();
});

test('Claude run(): cancel() ends the run stream and leaves the session usable', async () => {
  const adapter = new ClaudeAdapter();
  const children: any[] = [];
  const engine = adapter.open(specFor('engine-cancel', [TURN_SCRIPT, TURN_SCRIPT], children));

  const first = engine.run({ text: 'one' } as any, { awaitBackground: 'none' });
  first.cancel();
  // Events already buffered when cancel() lands still drain (RunEventQueue semantics, shared with
  // PI); what cancel() guarantees is that the stream ENDS — no turn events, no terminal phase.
  const cancelled = (await drain(first.events)).map((event) => event.type);
  // Exactly the one event run() pushes synchronously before cancel() lands, and no terminal phase.
  assert.deepEqual(cancelled, ['engine_started']);
  // The turn itself still settles underneath: cancel() ends the run, it does not kill the turn.
  await first.result;
  assert.equal(engine.isAlive(), true, 'cancel() must not tear the session down');

  // The same session serves a second run: one process, two turns.
  const second = engine.run({ text: 'two' } as any, { awaitBackground: 'none' });
  const events = await drain(second.events);
  await second.result;
  assert.equal(children.length, 1, 'the second run must reuse the spawned process');
  assert.equal(events.at(-1)?.type, 'phase');
  assert.ok(
    events.some((event) => event.type === 'tool_use'),
    `the second run replayed the script: ${JSON.stringify(events)}`,
  );
  await engine.close();
});

// --- (3) steer() surfaces acks on the run's stream (D2) -----------------------------------------

test('Claude steer(): a refused injection surfaces injection_rejected on the run stream', async () => {
  const adapter = new ClaudeAdapter();
  const children: any[] = [];
  // No script: the turn stays in flight, so the run's event stream is still open when steer lands.
  const engine = adapter.open(specFor('engine-steer-refused', [[]], children));
  const run = engine.run({ text: 'hi' } as any, { awaitBackground: 'none' });

  // A broken pipe refuses the write, so the engine itself must report the rejection — the ack sink
  // never fires for a message the CLI never received.
  children[0].failWrites = true;
  const steered = engine.steer({ text: 'stop' } as any);
  assert.equal(steered.accepted, false);

  const events = await drain(run.events);
  await run.result.catch(() => undefined);
  const rejected = events.filter((event) => event.type === 'injection_rejected');
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0], {
    type: 'injection_rejected', injectionId: steered.injectionId, reason: 'refused',
  });
  await engine.close();
});

test('Claude steer(): a delivered injection surfaces injection_delivered with the same id', async () => {
  const adapter = new ClaudeAdapter();
  const children: any[] = [];
  // No auto-script: this test drives the lines itself so the echo lands mid-turn.
  const engine = adapter.open(specFor('engine-steer-delivered', [[]], children));
  const run = engine.run({ text: 'hi' } as any, { awaitBackground: 'none' });

  const steered = engine.steer({ text: 'also do this' } as any);
  assert.equal(steered.accepted, true);
  // `--replay-user-messages` echoes the injected text back: that echo is the delivery ack.
  children[0].emitLines([
    { type: 'user', isReplay: true, uuid: 'u-1', session_id: 'engine-equiv', message: { role: 'user', content: 'also do this' } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.1, session_id: 'engine-equiv', result: 'ok' },
  ]);

  const events = await drain(run.events);
  await run.result;
  const delivered = events.filter((event) => event.type === 'injection_delivered');
  assert.equal(delivered.length, 1, `expected one injection_delivered, got ${JSON.stringify(events)}`);
  assert.equal((delivered[0] as any).injectionId, steered.injectionId);
  await engine.close();
});

// --- (4) identity string equality ⟺ the structural compatibility predicate ----------------------

const BASE: ClaudeSpawnCompatibility = {
  cwd: '/w', routeIdentity: 'r1', composition: 'direct', interactionBridge: false,
  commissionTools: false, tools: 'Bash,Read', pluginCapabilityFingerprint: 'fp',
  pluginDirs: ['/a', '/b'], mcpConfigPaths: ['/m1'], mcpToolAllowlist: ['x'],
  supplementalMcpConfigIdentity: 's', browserMcpConfigIdentity: null,
};

const VARIANTS: ClaudeSpawnCompatibility[] = [
  BASE,
  { ...BASE },                                             // structurally identical clone
  { ...BASE, cwd: '/w2' },
  { ...BASE, routeIdentity: 'r2' },
  { ...BASE, composition: 'core' as any },
  { ...BASE, interactionBridge: true },
  { ...BASE, commissionTools: true },
  { ...BASE, tools: 'Bash,Reads' },                        // one-character difference
  { ...BASE, tools: null },
  { ...BASE, pluginCapabilityFingerprint: null },
  { ...BASE, pluginDirs: ['/b', '/a'] },                   // order matters
  { ...BASE, pluginDirs: [] },
  { ...BASE, mcpConfigPaths: ['/m1', '/m2'] },
  { ...BASE, mcpToolAllowlist: null },                     // null and [] are NOT the same
  { ...BASE, mcpToolAllowlist: [] },
  { ...BASE, mcpToolAllowlist: ['x', 'y'] },
  { ...BASE, supplementalMcpConfigIdentity: null },
  { ...BASE, browserMcpConfigIdentity: 'b' },
];

test('claudeCompatibilityIdentity string equality is exactly sameClaudeSpawnCompatibility', () => {
  let agreements = 0;
  for (const left of VARIANTS) {
    for (const right of VARIANTS) {
      const structural = sameClaudeSpawnCompatibility(left, right);
      const byIdentity = claudeCompatibilityIdentity(left) === claudeCompatibilityIdentity(right);
      assert.equal(
        byIdentity, structural,
        `disagreement:\n  ${JSON.stringify(left)}\n  ${JSON.stringify(right)}`,
      );
      agreements += 1;
    }
  }
  assert.equal(agreements, VARIANTS.length * VARIANTS.length);
  // The table must actually contain a same/different mix, or the assertion above proves nothing.
  assert.equal(sameClaudeSpawnCompatibility(VARIANTS[0], VARIANTS[1]), true);
  assert.equal(sameClaudeSpawnCompatibility(VARIANTS[0], VARIANTS[2]), false);
  assert.notEqual(
    claudeCompatibilityIdentity({ ...BASE, mcpToolAllowlist: null }),
    claudeCompatibilityIdentity({ ...BASE, mcpToolAllowlist: [] }),
  );
});

// --- (5) Provider rate-limit signals (P2.5b) ----------------------------------------------------

test('Claude forwards rate_limit_event to the injected reporter, with no turn in flight', async () => {
  const seen: Array<{ info: unknown; origin: unknown }> = [];
  const adapter = new ClaudeAdapter({
    onRateLimit: async (info, origin) => { seen.push({ info, origin }); },
  });
  const children: any[] = [];
  const engine = adapter.open(specFor('engine-ratelimit', [], children, {
    anthropicBaseUrl: 'http://127.0.0.1:9881/m/max20/anthropic',
  }));

  const info = { rateLimitType: 'five_hour', utilization: 0.93, resetsAt: 1786160107 };
  // Staged directly on stdout with no prompt written: this is the case the plan's "emit a
  // rate_limit event" instruction would have dropped, because there is no turn to carry it.
  children[0].emitLines([{ type: 'rate_limit_event', rate_limit_info: info }]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(seen, [{
    info,
    // `mode` is recovered from the gateway sub-path, exactly as the inline call did.
    origin: { provider: 'anthropic', displayName: 'Anthropic', mode: 'max20' },
  }]);
  await engine.close();
});

test('Claude with no reporter injected drops the rate-limit line instead of reaching a throttle', async () => {
  const adapter = new ClaudeAdapter();
  const children: any[] = [];
  const engine = adapter.open(specFor('engine-ratelimit-bare', [], children, {
    anthropicBaseUrl: 'http://127.0.0.1:9881/m/max20/anthropic',
  }));
  children[0].emitLines([
    { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.93, resetsAt: 1 } },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  // No throw, no unhandled rejection: an unwired adapter simply has nowhere to put the reading.
  assert.equal(engine.isAlive(), true);
  await engine.close();
});
