// input:  a scripted Claude CLI child (request.isolation.spawner) + a fake PI runtime; run observers
// output: attempt-level event/cost/foreground/settled behaviour + run-level notices and wait policy
// pos:    Backend-neutral run-attempt and run-stage tests over the engine seam
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// This file used to drive the deleted `facade._test.runWithAdapter` with hand-rolled mock
// `AgentProcess`/`AgentAdapter`s. It now drives the two things that replaced it:
//
//   * `startAttempt` — one attempt's pooled engine session, its RunEvent stream, and its two
//     results (`foreground` / `settled`). Protocol facts come from `requiredSinks`, which the
//     attempt forwards to the engine's `onNormalizedEvent` tap (the raw record; the RunEvent
//     stream drops `turn_complete` and appends the terminal `phase`).
//   * `AgentRunImpl` — the run's own stages in `run.ts`: notice synthesis, provider/auth
//     attribution and terminal notices. It is constructed directly (with an in-memory
//     `RunRegistry`) so these unit tests never touch the daemon's execution registry.
//
// Claude runs against a scripted fake CLI child; PI runs against `pi-fake-runtime`. The pooled
// engine is the daemon singleton, so this file replaces `domain/runs/engines.ts` with a
// `SessionEngines` over a real `ClaudeAdapter` and a fake-runtime `PIAdapter`.

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import { startAttempt } from '../src/domain/runs/attempt.js';
import { AgentRunImpl } from '../src/domain/runs/run.js';
import type { RunRequest, RunObserver } from '../src/domain/runs/request.js';
import type { RunEvent } from '../src/agent-adapter/run-events.js';
import type { NormalizedEvent } from '../src/agent-adapter/normalize/event-types.js';
import type { AwaitBackground } from '../src/agent-adapter/continuation-phase.js';
import type { RunAttemptConfig } from '../src/domain/agents/profile-manager.js';
import type { AgentResult } from '../src/core/types/agent-types.js';
import { isRetryableResult } from '../src/domain/runs/fallback.js';
import { getLocale, setLocale } from '../src/core/i18n.js';
import { resetSettingsForTests } from '../src/core/settings.js';
import { costRepo } from '../src/store/cost-repo.js';
import { RunRegistry } from '../src/core/run-registry.js';
import { runRequestFixture, attemptFromFixture, type RunRequestFixtureInput } from './run-request-fixture.js';
import type { makeFakeRuntimeFactory } from './agent-adapter/pi-fake-runtime.js';

type FakeRuntimeFactory = ReturnType<typeof makeFakeRuntimeFactory>;

const CLAUDE: Partial<RunAttemptConfig> = { backend: 'claude', mode: null };
const PI: Partial<RunAttemptConfig> = { backend: 'pi', mode: null };

// `startAttempt` reaches the module singleton, so the fake PI adapter must be installed before
// that import resolves. The delegating factory reads `fixtures.current`, so each test installs its
// own fake runtime (and its own session id) before opening a PI attempt.
const fixtures = vi.hoisted(() => ({
  current: null as unknown as FakeRuntimeFactory,
  engines: null as unknown as import('../src/domain/runs/engines.js').SessionEngines,
}));

vi.mock('../src/domain/runs/engines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/domain/runs/engines.js')>();
  const { tmpdir: dir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdirSync } = await import('node:fs');
  const { PIAdapter } = await import('../src/agent-adapter/pi/adapter.js');
  const { ClaudeAdapter } = await import('../src/agent-adapter/claude/adapter.js');
  const { makeFakeRuntimeFactory: makeFake } = await import('./agent-adapter/pi-fake-runtime.js');
  const sessionDir = join(dir(), `run-with-adapter-sessions-${process.pid}`);
  mkdirSync(sessionDir, { recursive: true });
  const delegating = (request: unknown, callbacks: unknown) =>
    fixtures.current.factory(request as never, callbacks as never);
  fixtures.engines = new actual.SessionEngines({
    pi: new PIAdapter(delegating as never, sessionDir),
    claude: new ClaudeAdapter(),
  });
  return { ...actual, engines: fixtures.engines };
});

// --- scripted Claude child ---------------------------------------------------------------------

const spawnedChildren: any[] = [];

/** A fake `claude` child. Each stdin write (a turn prompt or an injection) consumes the next script
 *  and replays it on stdout; `emitLines` stages a turn by hand (background continuations). */
function scriptedClaudeChild(scripts: unknown[][] = []) {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.writes = [] as string[];
  child.kill = () => { child.killed = true; return true; };
  child.emitLines = (lines: unknown[]) => {
    for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
  };
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = (...args: any[]) => { child.writes.push(String(args[0])); return write(...args); };
  const queue = [...scripts];
  child.stdin.on('data', () => {
    const next = queue.shift();
    if (next) setImmediate(() => child.emitLines(next));
  });
  spawnedChildren.push(child);
  return child;
}

// --- Claude line helpers -----------------------------------------------------------------------

const textLine = (text: string, model = 'claude-opus-5') => ({
  type: 'assistant', message: { model, content: [{ type: 'text', text }] },
});
const toolUseLine = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] },
});
const toolResultLine = (id: string, content: string, isError = false) => ({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});
const resultLine = (overrides: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false,
  num_turns: 1, total_cost_usd: 0, session_id: 'fixture-session', result: 'done', ...overrides,
});

const TASK_STARTED = { type: 'system', subtype: 'task_started', task_id: 'bg-1', task_type: 'local_bash' };
const TASK_NOTIFICATION = { type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed', summary: 'done' };
/** A foreground turn that leaves one background task running. */
const FOREGROUND_BG = [
  TASK_STARTED,
  textLine('started it'),
  resultLine({ total_cost_usd: 0.25, result: 'started it' }),
];
/** The backend's spontaneous continuation once the task finishes. */
const CONTINUATION = [
  TASK_NOTIFICATION,
  textLine('task finished: DONE'),
  resultLine({
    origin: { kind: 'task-notification' }, total_cost_usd: 0.01, result: 'task finished: DONE',
    usage: {
      iterations: [{
        input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300,
        output_tokens: 80,
      }],
    },
    modelUsage: { 'claude-opus-5[1m]': { canonicalModel: 'claude-opus-5', contextWindow: 900000 } },
  }),
];

// --- harness -----------------------------------------------------------------------------------

interface ClaudeHandle {
  request: RunRequest;
  children: any[];
  events: RunEvent[];
  raw: NormalizedEvent[];
  run: ReturnType<typeof startAttempt>;
}

function claudeAttempt(
  partial: RunRequestFixtureInput,
  scripts: unknown[][],
  opts: { background?: AwaitBackground; override?: Partial<RunAttemptConfig> } = {},
): ClaudeHandle {
  const children: any[] = [];
  const override = { ...CLAUDE, ...opts.override };
  const request = runRequestFixture({
    ...partial,
    processSpawner: (() => {
      const child = scriptedClaudeChild(scripts);
      children.push(child);
      return { process: child };
    }) as never,
  }, override);
  if (opts.background) request.policy = { ...request.policy, background: opts.background };
  const events: RunEvent[] = [];
  const raw: NormalizedEvent[] = [];
  const run = startAttempt({
    request,
    attempt: attemptFromFixture(partial, override),
    executionId: null,
    onEvent: (event) => { events.push(event); },
    requiredSinks: [{ onEvent: (event) => { raw.push(event); } }],
  });
  return { request, children, events, raw, run };
}

interface PiHandle {
  request: RunRequest;
  events: RunEvent[];
  raw: NormalizedEvent[];
  run: ReturnType<typeof startAttempt>;
  runtime: Promise<import('./agent-adapter/pi-fake-runtime.js').FakeRuntime>;
}

function piAttempt(
  partial: RunRequestFixtureInput,
  opts: { background?: AwaitBackground; override?: Partial<RunAttemptConfig> } = {},
): PiHandle {
  const index = fixtures.current.runtimes.length;
  const override = { ...PI, ...opts.override };
  const request = runRequestFixture(partial, override);
  if (opts.background) request.policy = { ...request.policy, background: opts.background };
  const events: RunEvent[] = [];
  const raw: NormalizedEvent[] = [];
  const run = startAttempt({
    request,
    attempt: attemptFromFixture(partial, override),
    executionId: null,
    onEvent: (event) => { events.push(event); },
    requiredSinks: [{ onEvent: (event) => { raw.push(event); } }],
  });
  return { request, events, raw, run, runtime: fixtures.current.runtime(index) };
}

function openRun(request: RunRequest, observers: RunObserver[]): AgentRunImpl {
  const run = new AgentRunImpl({
    request, observers, executionId: 'exec-fixture',
    registry: new RunRegistry(), onTerminal: () => {}, startedAt: Date.now(),
  });
  run.start();
  return run;
}

interface Collected {
  observer: RunObserver;
  events: RunEvent[];
  closes(): number;
}

function collector(required = false): Collected {
  const events: RunEvent[] = [];
  let closed = 0;
  return {
    observer: { required, onEvent: (event) => { events.push(event); }, onClose: () => { closed += 1; } },
    events,
    closes: () => closed,
  };
}

function notices(events: RunEvent[]): Array<{ text: string; level?: string }> {
  return events
    .filter((event): event is Extract<RunEvent, { type: 'assistant_text' }> => event.type === 'assistant_text')
    .map((event) => ({ text: event.text, level: event.noticeLevel }));
}

async function waitFor(check: () => boolean, ticks = 300): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition never became true');
}

afterEach(async () => {
  for (const key of fixtures.engines.listKeys()) await fixtures.engines.close(key);
  for (const child of spawnedChildren.splice(0)) child.emit('close', 0);
  resetSettingsForTests();
});

// ── event stream and result flow ─────────────────────────────────────────

test('attempt: the raw protocol events reach the tap in order and the foreground result flows through', async () => {
  const scripts = [[
    textLine('hello'),
    toolUseLine('t1', 'Bash', { command: 'ls' }),
    textLine('done'),
    resultLine({ num_turns: 2, total_cost_usd: 0.01, session_id: 's-happy', result: 'done' }),
  ]];
  const { run, raw, children } = claudeAttempt({ promptText: 'user msg', sessionKey: 'happy' }, scripts, { background: 'none' });

  const foreground = await run.foreground;

  const interesting = raw.filter((event) => ['assistant_text', 'tool_use', 'turn_complete'].includes(event.type));
  assert.deepEqual(interesting.map((event) => event.type),
    ['assistant_text', 'tool_use', 'assistant_text', 'turn_complete'],
    'the foreground wire record preserves source order');
  const toolUse = interesting.find((event) => event.type === 'tool_use') as Extract<NormalizedEvent, { type: 'tool_use' }>;
  assert.equal(toolUse.name, 'Bash');
  assert.deepEqual(toolUse.input, { command: 'ls' });
  assert.equal(toolUse.toolUseId, 't1', 'the correlation id is preserved');

  assert.equal(foreground.finalOutput, 'done', 'the foreground result carries the backend result');
  assert.equal(foreground.sessionId, 's-happy');
  assert.equal(children[0].writes.length, 1, 'one prompt reached the child');
});

test('attempt: PI context_usage reaches the raw tap before the turn_complete marker', async () => {
  fixtures.current = (await import('./agent-adapter/pi-fake-runtime.js')).makeFakeRuntimeFactory({ sessionId: 's-context' });
  const { run, raw, runtime } = piAttempt({ promptText: 'msg', sessionKey: 'context', channel: 'web:context' }, { background: 'none' });
  const live = await runtime;
  await live.nextCall('prompt');
  live.emitAgentStart();
  (live.stats as unknown as { contextUsage: unknown }).contextUsage = { tokens: 60000, contextWindow: 200000, percent: 30 };
  live.emitAgentEnd();

  await run.foreground;

  const seen = raw.filter((event) => event.type === 'context_usage' || event.type === 'turn_complete');
  assert.deepEqual(seen.map((event) => event.type), ['context_usage', 'turn_complete']);
});

// ── run-level notices ────────────────────────────────────────────────────

test('run: a backend model fallback emits one warning and the turn continues', async (t) => {
  const previousLocale = getLocale();
  t.onTestFinished(() => setLocale(previousLocale));
  setLocale('en');

  const scripts = [[
    { type: 'system', subtype: 'model_refusal_fallback', originalModel: 'claude-fable-5[1m]', fallbackModel: 'claude-opus-4-8[1m]' },
    textLine('continued'),
    resultLine({ session_id: 's-fallback' }),
  ]];
  const children: any[] = [];
  const request = runRequestFixture({
    channel: 'web:session', sessionKey: 'fallback-notice',
    processSpawner: (() => { const child = scriptedClaudeChild(scripts); children.push(child); return { process: child }; }) as never,
  }, CLAUDE);
  const seen = collector();
  const run = openRun(request, [seen.observer]);

  const result = await run.settled;
  assert.equal(result.sessionId, 's-fallback');
  assert.deepEqual(notices(seen.events), [
    { text: 'Model fallback: claude-fable-5[1m] → claude-opus-4-8[1m].', level: 'warning' },
    { text: 'continued', level: undefined },
  ]);
});

test('run: context compaction emits one concise info notice', async (t) => {
  const previousFlag = process.env.CORTEX_NOTIFY_COMPACTION;
  const previousLocale = getLocale();
  t.onTestFinished(() => {
    if (previousFlag === undefined) delete process.env.CORTEX_NOTIFY_COMPACTION;
    else process.env.CORTEX_NOTIFY_COMPACTION = previousFlag;
    resetSettingsForTests();
    setLocale(previousLocale);
  });
  process.env.CORTEX_NOTIFY_COMPACTION = '1';
  resetSettingsForTests();
  setLocale('en');

  const scripts = [[
    { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'overflow', pre_tokens: 48000 } },
    resultLine({ session_id: 's-compact' }),
  ]];
  const request = runRequestFixture({
    channel: 'C1', sessionKey: 'compact-notice',
    processSpawner: (() => ({ process: scriptedClaudeChild(scripts) })) as never,
  }, CLAUDE);
  const seen = collector();
  const run = openRun(request, [seen.observer]);
  await run.settled;

  assert.deepEqual(notices(seen.events), [{ text: 'Context auto-compacted.', level: 'info' }]);
});

test('run: a leading API Error becomes an error notice without reclassifying prose', async () => {
  const scripts = [[
    textLine('API Error: Unable to connect to API (ECONNRESET)'),
    textLine('The log mentions API Error: timeout.'),
    resultLine({ session_id: 's-api-error' }),
  ]];
  const request = runRequestFixture({
    channel: 'web:session', sessionKey: 'api-error-notice',
    processSpawner: (() => ({ process: scriptedClaudeChild(scripts) })) as never,
  }, CLAUDE);
  const seen = collector();
  const run = openRun(request, [seen.observer]);
  await run.settled;

  assert.deepEqual(notices(seen.events), [
    { text: 'API Error: Unable to connect to API (ECONNRESET)', level: 'error' },
    { text: 'The log mentions API Error: timeout.', level: undefined },
  ]);
});

test('run: changed PI identity on resume emits one warning, same/fresh starts emit none', async (t) => {
  const previousLocale = getLocale();
  t.onTestFinished(() => setLocale(previousLocale));
  setLocale('en');
  const { makeFakeRuntimeFactory } = await import('./agent-adapter/pi-fake-runtime.js');

  const collect = async (requestedSessionId: string | null, startedSessionId: string, channel = 'web:session') => {
    fixtures.current = makeFakeRuntimeFactory({ sessionId: startedSessionId });
    const request = runRequestFixture({
      channel, sessionKey: `reset-${startedSessionId}-${requestedSessionId ?? 'fresh'}`,
      ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
    }, PI);
    const seen = collector();
    const run = openRun(request, [seen.observer]);
    const runtime = await fixtures.current.runtime(0);
    await runtime.nextCall('prompt');
    runtime.emitAgentStart();
    runtime.emitAgentEnd();
    await run.settled;
    return notices(seen.events);
  };

  assert.deepEqual(await collect('backend-old', 'backend-new'), [{
    text: 'Previous backend session was unavailable; started a fresh session.',
    level: 'warning',
  }]);
  assert.deepEqual(await collect('backend-same', 'backend-same'), []);
  assert.deepEqual(await collect(null, 'backend-new'), []);
  assert.deepEqual(await collect('backend-old', 'backend-new', 'slack:C1'), []);
});

// ── tool events, FIFO and deltas ─────────────────────────────────────────

test('attempt: tool_result preserves full multiline content, error status, and correlation id', async () => {
  const scripts = [[
    toolUseLine('toolu-result', 'Read', { file_path: '/secret/full.ts' }),
    toolResultLine('toolu-result', 'first line\nsecond line\nthird line', true),
    resultLine({ session_id: 's-result' }),
  ]];
  const { run, events } = claudeAttempt({ sessionKey: 'tool-result' }, scripts, { background: 'none' });
  await run.foreground;

  const toolResults = events.filter((event) => event.type === 'tool_result');
  assert.deepEqual(toolResults, [{
    type: 'tool_result', toolUseId: 'toolu-result', ok: false,
    content: 'first line\nsecond line\nthird line', phase: 'foreground',
  }]);
});

test('attempt: tool_use → assistant_text reaches the stream in FIFO order', async () => {
  const scripts = [[
    toolUseLine('t1', 'Read', { file_path: '/a' }),
    textLine('after tool'),
    resultLine({ session_id: 's-fifo' }),
  ]];
  const { run, events } = claudeAttempt({ sessionKey: 'fifo' }, scripts, { background: 'none' });
  await run.foreground;

  const log = events
    .filter((event) => event.type === 'tool_use' || event.type === 'assistant_text')
    .map((event) => event.type === 'tool_use' ? `tool:${event.name}` : `text:${event.text}`);
  assert.deepEqual(log, ['tool:Read', 'text:after tool'], 'FIFO: the tool event fires before later text');
});

test('attempt: deltas reach the stream before the complete assistant_text and stay separate from prose', async () => {
  const scripts = [[
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_A', type: 'message', role: 'assistant', content: [] } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Tea ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'is a leaf.' } } },
    textLine('Tea is a leaf.'),
    resultLine({ session_id: 's-delta' }),
  ]];
  const { run, events } = claudeAttempt({ sessionKey: 'deltas', channel: 'web:abc' }, scripts, { background: 'none' });
  await run.foreground;

  const order: string[] = [];
  const deltas: Array<[string, string]> = [];
  const finals: Array<[string, string | undefined]> = [];
  for (const event of events) {
    if (event.type === 'assistant_delta') { deltas.push([event.text, event.blockId]); order.push('delta'); }
    if (event.type === 'assistant_text') { finals.push([event.text, event.blockId]); order.push('final'); }
  }

  assert.deepEqual(deltas, [['Tea ', 'msg_A:0'], ['is a leaf.', 'msg_A:0']]);
  assert.deepEqual(finals, [['Tea is a leaf.', 'msg_A:0']], 'the complete message carries the streamed blockId');
  assert.deepEqual(order, ['delta', 'delta', 'final'], 'deltas precede the authoritative message');
});

test('attempt: with no delta consumer, partial text never appears as assistant_text', async () => {
  // The stream carries `assistant_delta`; the surface decides whether to render it. What must hold
  // is that a delta is never promoted to a complete `assistant_text` (the Slack/Feishu guarantee).
  const scripts = [[
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_A', type: 'message', role: 'assistant', content: [] } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'par' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tial' } } },
    textLine('partial'),
    resultLine({ session_id: 's-nodelta' }),
  ]];
  const { run, events } = claudeAttempt({ sessionKey: 'no-delta', channel: 'C1' }, scripts, { background: 'none' });
  await run.foreground;

  const texts = events.filter((event) => event.type === 'assistant_text').map((event) => event.text);
  assert.deepEqual(texts, ['partial'], 'exactly one complete message, no partial text');
});

// ── observer safety ──────────────────────────────────────────────────────

test('run: a throwing observer cannot truncate delivery to a later observer', async () => {
  const scripts = [[
    textLine('ok'),
    resultLine({ session_id: 's-observed' }),
  ]];
  const request = runRequestFixture({
    sessionKey: 'observer-throws',
    processSpawner: (() => ({ process: scriptedClaudeChild(scripts) })) as never,
  }, CLAUDE);
  const seen = collector();
  const throwing: RunObserver = { onEvent: () => { throw new Error('legacy callback failed'); } };
  const run = openRun(request, [throwing, seen.observer]);

  await run.settled;
  assert.ok(seen.events.some((event) => event.type === 'assistant_text' && event.text === 'ok'),
    'the second observer still received the prose');
  assert.equal(seen.closes(), 1);
});

test('run: throwing diagnostics observers are logged without breaking other observers', async () => {
  const scripts = [[
    textLine('ok'),
    resultLine({ session_id: 's-diagnostics' }),
  ]];
  const request = runRequestFixture({
    sessionKey: 'observer-diagnostics',
    processSpawner: (() => ({ process: scriptedClaudeChild(scripts) })) as never,
  }, CLAUDE);
  const seen = collector();
  const run = openRun(request, [
    { onEvent: () => { throw new Error('diagnostics failed'); } },
    seen.observer,
  ]);

  const result = await run.settled;
  assert.equal(result.sessionId, 's-diagnostics');
  assert.equal(run.status, 'completed');
  assert.deepEqual(seen.events.map((event) => event.type),
    ['engine_started', 'assistant_text', 'turn_progress', 'cost_record', 'foreground_result', 'phase']);
});

test('run: a required observer write failure kills the engine and rejects the run', async () => {
  const scripts = [[
    textLine('partial'),
    resultLine({ session_id: 's-required' }),
  ]];
  const children: any[] = [];
  const request = runRequestFixture({
    sessionKey: 'required-write',
    processSpawner: (() => { const child = scriptedClaudeChild(scripts); children.push(child); return { process: child }; }) as never,
  }, CLAUDE);
  const sink: RunObserver = {
    required: true,
    onEvent: () => { throw new Error('sink write failed'); },
  };
  const run = openRun(request, [sink]);
  // `result`/`settled` are marked handled by the run; observe the settlement explicitly.
  let completed = false;
  const promise = run.settled.then((result) => { completed = true; return result; });

  await assert.rejects(promise, /sink write failed/);
  assert.equal(completed, false);
  assert.equal(run.status, 'failed');
  assert.equal(children[0].killed, true, 'the required-observer failure killed the engine');
});

test('run: a required observer close failure cannot resurrect a finished run', async () => {
  // The observer contract changed here: `onClose` runs after the run is terminal, so a failure in
  // it is logged, not turned back into a failed run. (The old facade treated a required sink's
  // close failure as fatal; the run layer intentionally does not.)
  const scripts = [[textLine('done'), resultLine({ session_id: 's-required-close' })]];
  const request = runRequestFixture({
    sessionKey: 'required-close',
    processSpawner: (() => ({ process: scriptedClaudeChild(scripts) })) as never,
  }, CLAUDE);
  const sink: RunObserver = {
    required: true,
    onEvent: () => {},
    onClose: async () => { throw new Error('sink close failed'); },
  };
  const run = openRun(request, [sink]);
  const result = await run.settled;

  assert.equal(result.sessionId, 's-required-close');
  assert.equal(run.status, 'completed');
});

// ── terminal results ─────────────────────────────────────────────────────

test('attempt: a rateLimited result passes through so the run fallback can retry', async () => {
  const scripts = [[
    { type: 'result', subtype: 'error', is_error: true, result: 'rate limit exceeded', num_turns: 1, total_cost_usd: 0, session_id: 's-rate' },
  ]];
  const { run } = claudeAttempt({ sessionKey: 'rate-limited' }, scripts, { background: 'none' });
  const result = await run.foreground;

  assert.equal(result.rateLimited, true, 'rateLimited propagates to the resolved result');
  assert.equal(result.rateLimitMessage, 'rate limit exceeded');
  assert.equal(isRetryableResult(result), true, 'isRetryableResult matches the run fallback trigger');
});

test('attempt: a PI dialog request round-trips through respondToDialog', async () => {
  // The deleted facade surfaced `askUserQuestions` on the AgentResult; the engine seam carries the
  // same information as a `dialog_request` RunEvent and answers it through `respondToDialog`.
  const { makeFakeRuntimeFactory } = await import('./agent-adapter/pi-fake-runtime.js');
  fixtures.current = makeFakeRuntimeFactory({ sessionId: 's-ask' });
  const { run, events, runtime } = piAttempt({ promptText: 'msg', sessionKey: 'ask' }, { background: 'none' });
  const live = await runtime;
  await live.nextCall('prompt');
  live.emitAgentStart();
  live.emit({ type: 'extension_ui_request', id: 'q-1', method: 'select', title: 'Q1', options: ['A', 'B'] });
  live.emitAgentEnd();

  await run.foreground;

  const dialog = events.find((event) => event.type === 'dialog_request');
  assert.ok(dialog && dialog.type === 'dialog_request', 'the dialog request reached the run stream');
  assert.equal(dialog.dialogId, 'q-1');
  assert.equal(run.engine.respondToDialog('q-1', { value: 'A' }), true, 'the attempt forwards the answer to the engine');
  assert.deepEqual(live.uiResponses, [{ id: 'q-1', payload: { value: 'A' } }]);
});

test('attempt: a fatal backend error rejects the attempt', async () => {
  const scripts = [[
    textLine('partial'),
    { type: 'result', subtype: 'error', is_error: true, result: 'fatal boom', session_id: 's-fatal' },
  ]];
  const { run, children } = claudeAttempt({ sessionKey: 'fatal' }, scripts, { background: 'none' });

  await assert.rejects(run.foreground, /fatal boom/);
  assert.equal(children[0].killed, false, 'a backend error does not itself kill the pooled session');
});

test('attempt: kill() forwards to the engine session', async () => {
  const scripts: unknown[][] = []; // no script: the turn stays open
  const { run, children } = claudeAttempt({ sessionKey: 'kill' }, scripts, { background: 'hold' });
  await waitFor(() => children.length === 1);

  const killed = run.kill();
  assert.equal(killed, true, 'kill() returns the engine kill result');
  assert.equal(children[0].killed, true, 'the engine killed the Claude child');
});

// ── background phase: hold / inline / none ───────────────────────────────

test('attempt: an inline continuation merges cost, output and turns into settled', async () => {
  const { run, events, children } = claudeAttempt(
    { sessionKey: 'bg-inline' }, [FOREGROUND_BG], { background: 'inline' },
  );
  await waitFor(() => children.length === 1);
  await waitFor(() => events.some((event) => event.type === 'foreground_result'));
  children[0].emitLines(CONTINUATION);

  const settled = await run.settled;
  assert.equal(settled.num_turns, 2, 'the whole run is reported, not one turn');
  assert.equal(settled.finalOutput, 'task finished: DONE');
  assert.equal((settled.total_cost_usd ?? 0), 0.25, 'the continuation cost is merged in');
  const backgroundResult = events.find((event) => event.type === 'background_result');
  assert.ok(backgroundResult && backgroundResult.type === 'background_result');
});

test('attempt: a held background phase stays open until the continuation lands', async () => {
  const { run, events, children } = claudeAttempt(
    { sessionKey: 'bg-hold' },
    [FOREGROUND_BG], { background: 'hold' },
  );
  await waitFor(() => children.length === 1);
  await waitFor(() => events.some((event) => event.type === 'foreground_result'));

  let settled = false;
  void run.settled.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the run holds while the background task runs');

  children[0].emitLines(CONTINUATION);
  const final = await run.settled;
  const foreground = await run.foreground;

  assert.equal(final.finalOutput, 'task finished: DONE');
  // `settled` is the whole attempt; `foreground` is the turn the caller was waiting on.
  assert.equal(foreground.finalOutput, 'started it', 'foreground carries only the waited-on turn');
  assert.equal(foreground.total_cost_usd, 0.25, 'the continuation cost is not in the foreground result');
  assert.deepEqual(
    events.filter((event) => event.type === 'phase').map((event) => (event as Extract<RunEvent, { type: 'phase' }>).phase),
    ['background', 'background', 'done'],
  );
  assert.deepEqual(events.at(-1), { type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0 });
});

test('attempt: the background phase emits its continuation cost_record before background_result', async () => {
  const { run, events, children } = claudeAttempt(
    { sessionKey: 'bg-accounting', project: 'bg-accounting-test', trigger: 'test' },
    [FOREGROUND_BG], { background: 'inline' },
  );
  await waitFor(() => children.length === 1);
  await waitFor(() => events.some((event) => event.type === 'foreground_result'));
  children[0].emitLines(CONTINUATION);
  await run.settled;

  const foregroundCost = events.findIndex((event) => event.type === 'cost_record');
  const foregroundResult = events.findIndex((event) => event.type === 'foreground_result');
  const backgroundResult = events.findIndex((event) => event.type === 'background_result');
  const costs = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'cost_record')
    .map(({ index }) => index);
  assert.ok(foregroundCost < foregroundResult, 'the foreground cost lands before its result');
  assert.ok(costs.some((index) => index > foregroundResult && index < backgroundResult),
    'the continuation cost lands before its background_result');
});

test('attempt: awaitBackground none never waits for a background task', async () => {
  const { run, events } = claudeAttempt({ sessionKey: 'bg-none' }, [FOREGROUND_BG], { background: 'none' });
  await run.settled;

  assert.equal(events.some((event) => event.type === 'background_result'), false);
  assert.equal(
    events.filter((event) => event.type === 'phase').some(
      (event) => (event as Extract<RunEvent, { type: 'phase' }>).phase === 'background',
    ),
    false,
    'no background phase is entered',
  );
});

test('attempt: a hold publishes the foreground result while the background work continues', async () => {
  const { run, events, children } = claudeAttempt({ sessionKey: 'bg-interactive', channel: 'slack:D1' }, [FOREGROUND_BG], { background: 'hold' });
  await waitFor(() => events.some((event) => event.type === 'foreground_result'));

  const foreground = events.find((event) => event.type === 'foreground_result') as Extract<RunEvent, { type: 'foreground_result' }>;
  assert.equal(foreground.result.pendingBackgroundTasks, 1, 'the foreground result reports the outstanding task');

  children[0].emitLines(CONTINUATION);
  const settled = await run.settled;
  assert.equal(settled.finalOutput, 'task finished: DONE');
});

// ── conditional compaction notice ────────────────────────────────────────

test('run: context_compacted notifies only when CORTEX_NOTIFY_COMPACTION=1', async (t) => {
  const prev = process.env.CORTEX_NOTIFY_COMPACTION;
  t.onTestFinished(() => {
    if (prev === undefined) delete process.env.CORTEX_NOTIFY_COMPACTION;
    else process.env.CORTEX_NOTIFY_COMPACTION = prev;
    resetSettingsForTests();
  });

  const script = [[
    { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 37418 } },
    resultLine({ session_id: 's-compact' }),
  ]];
  const request = () => runRequestFixture({
    channel: 'C1', sessionKey: `compact-${Math.random().toString(36).slice(2)}`,
    processSpawner: (() => ({ process: scriptedClaudeChild(script) })) as never,
  }, CLAUDE);

  // OFF (env unset): no notification.
  delete process.env.CORTEX_NOTIFY_COMPACTION;
  resetSettingsForTests();
  const off = collector();
  await openRun(request(), [off.observer]).settled;
  assert.deepEqual(notices(off.events), [], 'no compaction notice when the flag is off');

  // ON: exactly one concise notification; backend trigger/token details stay internal.
  process.env.CORTEX_NOTIFY_COMPACTION = '1';
  resetSettingsForTests();
  const on = collector();
  await openRun(request(), [on.observer]).settled;
  assert.deepEqual(notices(on.events), [{ text: 'Context auto-compacted.', level: 'info' }]);
});

// ── cost persistence (attempt-level) ─────────────────────────────────────

test('attempt: the foreground cost_record is persisted under the attempt attribution', async (t) => {
  const costsFile = pathJoin(tmpdir(), `run-with-adapter-costs-${process.pid}.json`);
  const original = process.env['CORTEX_COSTS_FILE'];
  t.onTestFinished(() => {
    if (original === undefined) delete process.env['CORTEX_COSTS_FILE'];
    else process.env['CORTEX_COSTS_FILE'] = original;
    if (existsSync(costsFile)) unlinkSync(costsFile);
    costRepo._testReset();
  });
  // Earlier tests in this file fire-and-forget their cost writes to the default repo. Drain them
  // before the path switch, or they append to THIS file once the mutex reaches them (the path is
  // resolved lazily at write time), and the row count is no longer this attempt's alone.
  await costRepo.flush();
  process.env['CORTEX_COSTS_FILE'] = costsFile;
  costRepo._testReset();

  const scripts = [[
    textLine('foreground'),
    resultLine({ total_cost_usd: 0.2, session_id: 's-ordered-bg' }),
  ]];
  const { run } = claudeAttempt(
    { sessionKey: 'cost-persist', model: 'foreground-model', project: 'bg-accounting-test', trigger: 'test' },
    scripts, { background: 'none' },
  );
  await run.foreground;
  await costRepo.flush();

  const rows = readFileSync(costsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows.length, 1, 'the attempt bills only the foreground turn it started');
  assert.equal(rows[0].project, 'bg-accounting-test');
  assert.equal(rows[0].model, 'foreground-model');
});
