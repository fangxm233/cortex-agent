// input:  the background half of the `agent` tool — session hold, delivery, and both entry points
// output: hold/release invariants, re-assertion, abort wiring, delivery text, PI's own flag
// pos:    Tests backgrounded subagent runs
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { EventBus } from '../src/events/event-bus.js';
import { bgHeldSessions } from '../src/core/bg-held-sessions.js';
import { busyTracker } from '../src/orchestration/busy-tracker.js';
import { ctx as jobCtx } from '../src/domain/scheduling/job-registry.js';
import { publishSessionStatus } from '../src/orchestration/session-events.js';
import {
  deliverBackgroundSubagentResult, holdSessionForBackgroundRun, setSubagentTurnSender,
  startBackgroundSubagentRun,
} from '../src/orchestration/subagent-delivery.js';
import {
  _resetSubagentRuns, startSubagentRun, waitForSubagentRun,
} from '../src/domain/agents/subagent/registry.js';
import { emptyUsage } from '../src/domain/agents/subagent/usage.js';
import type { SubagentToolResult } from '../src/domain/agents/subagent/orchestrate.js';
import type { SubagentRunStatus } from '../src/domain/agents/subagent/registry.js';
import type { Invocation } from '../src/domain/agents/subagent/types.js';

const SESSION = 'sess-bg';
const CHANNEL = 'web:7';

let bus: EventBus;
let delivered: Array<{ channel: string; text: string }>;
/** The busy tracker signals the supervisor over IPC. Under Vitest's fork pool `process.send` is
 *  the worker's own channel, and an unrecognised frame kills the run — so it is muted here. */
let originalSend: typeof process.send;

/** `Promise.withResolvers` is newer than this package's `lib` target. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function invocation(description = 'dig'): Invocation {
  return {
    mode: 'single',
    tasks: [{ description, prompt: 'p', subagent_type: 'general-purpose' }],
  };
}

function toolResult(text: string): SubagentToolResult {
  return {
    content: [{ type: 'text', text }],
    details: { mode: 'single', results: [], usage: emptyUsage() },
  };
}

/** Every `session.status` seen for our session, in order. */
let statuses: Array<{ running: boolean; backgroundRunning?: boolean }>;

beforeEach(() => {
  originalSend = process.send;
  (process as { send?: unknown }).send = undefined;
  bus = new EventBus();
  jobCtx.bus = bus;
  busyTracker.setBus(bus);
  bgHeldSessions.clear();
  _resetSubagentRuns();
  statuses = [];
  bus.subscribe('session.status', (event: any) => {
    if (event.sessionId === SESSION) {
      statuses.push({ running: event.running, backgroundRunning: event.backgroundRunning });
    }
    bgHeldSessions.onSessionStatus(event);
  });
  delivered = [];
  setSubagentTurnSender(opts => { delivered.push(opts); });
});

afterEach(() => {
  process.send = originalSend;
  setSubagentTurnSender(null);
  _resetSubagentRuns();
  bgHeldSessions.clear();
  jobCtx.bus = null;
});

function view(overrides: Partial<Parameters<typeof holdSessionForBackgroundRun>[0]> = {}) {
  return {
    id: 'sa_x', status: 'running' as SubagentRunStatus, background: true, mode: 'single' as const,
    descriptions: ['dig'], sessionId: SESSION, startedAt: 0, endedAt: null, error: null,
    ...overrides,
  };
}

// --- the hold ---

test('the hold marks the session busy-in-background and brackets the busy counter', () => {
  const before = busyTracker.count;
  const release = holdSessionForBackgroundRun(view(), CHANNEL);
  assert.equal(busyTracker.count, before + 1);
  assert.deepEqual(statuses[0], { running: true, backgroundRunning: true });
  assert.ok(bgHeldSessions.has(SESSION));

  release();
  assert.equal(busyTracker.count, before);
  assert.deepEqual(statuses.at(-1), { running: false, backgroundRunning: false });
  assert.equal(bgHeldSessions.has(SESSION), false);
});

test('releasing twice is a no-op — the busy bracket cannot go negative', () => {
  const before = busyTracker.count;
  const release = holdSessionForBackgroundRun(view(), CHANNEL);
  release();
  release();
  assert.equal(busyTracker.count, before);
});

test('the hold re-asserts itself when the parent turn publishes running:false', () => {
  const release = holdSessionForBackgroundRun(view(), CHANNEL);
  // The foreground turn ending. Without the re-assert this would drop the hold and the Stop
  // button would go dead while the children kept spending tokens.
  publishSessionStatus({ sessionId: SESSION, channel: CHANNEL, running: false });
  assert.ok(bgHeldSessions.has(SESSION), 'still held after the parent turn ends');
  assert.deepEqual(statuses.at(-1), { running: true, backgroundRunning: true });
  release();
  assert.equal(bgHeldSessions.has(SESSION), false);
});

test('a released hold stops re-asserting, and stops listening at all', () => {
  const release = holdSessionForBackgroundRun(view(), CHANNEL);
  release();
  const after = statuses.length;
  publishSessionStatus({ sessionId: SESSION, channel: CHANNEL, running: false });
  assert.equal(statuses.length, after + 1, 'only the event we just published');
  assert.equal(bgHeldSessions.has(SESSION), false);
});

test('another session\'s status never touches this hold', () => {
  const release = holdSessionForBackgroundRun(view(), CHANNEL);
  const before = statuses.length;
  publishSessionStatus({ sessionId: 'someone-else', channel: CHANNEL, running: false });
  assert.equal(statuses.length, before, 'no re-assert for a session that is not ours');
  release();
});

test('the Stop path can reach a background run through the hold\'s abort handle', async () => {
  const run = startSubagentRun({
    invocation: invocation(),
    sessionId: SESSION,
    background: true,
    execute: (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const release = holdSessionForBackgroundRun(view({ id: run.id }), CHANNEL);
  assert.equal(bgHeldSessions.abort(SESSION), true);
  const outcome = await waitForSubagentRun(run.id, 1000);
  assert.equal(outcome!.view.status, 'stopped');
  release();
});

test('a run with no session still takes the busy bracket, so a restart cannot kill it', () => {
  const before = busyTracker.count;
  const release = holdSessionForBackgroundRun(view({ sessionId: null }), CHANNEL);
  assert.equal(busyTracker.count, before + 1);
  assert.equal(bgHeldSessions.has(SESSION), false);
  release();
  assert.equal(busyTracker.count, before);
});

// --- start + settle ---

test('startBackgroundSubagentRun holds for the run and releases when it settles', async () => {
  const before = busyTracker.count;
  const gate = deferred<SubagentToolResult>();
  const started = startBackgroundSubagentRun(onSettled => startSubagentRun({
    invocation: invocation('long job'),
    sessionId: SESSION,
    background: true,
    onSettled,
    execute: () => gate.promise,
  }), CHANNEL);

  assert.equal(busyTracker.count, before + 1);
  assert.ok(bgHeldSessions.has(SESSION));

  gate.resolve(toolResult('the findings'));
  await waitForSubagentRun(started.id, 1000);
  await vi.waitFor(() => assert.equal(busyTracker.count, before));

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channel, CHANNEL);
  assert.match(delivered[0].text, new RegExp(`Background agent ${started.id} — long job`));
  assert.match(delivered[0].text, /the findings/);
});

test('a run that settles before the hold is installed still releases it', async () => {
  const before = busyTracker.count;
  // Synchronous rejection: `settle` runs inside the same tick, before the hold exists.
  const started = startBackgroundSubagentRun(onSettled => startSubagentRun({
    invocation: invocation(),
    sessionId: SESSION,
    background: true,
    onSettled,
    execute: () => Promise.reject(new Error('no such model')),
  }), CHANNEL);
  await waitForSubagentRun(started.id, 1000);
  await vi.waitFor(() => assert.equal(busyTracker.count, before, 'hold was not left standing'));
  assert.equal(bgHeldSessions.has(SESSION), false);
  assert.match(delivered.at(-1)!.text, /Failed: no such model/);
});

// --- delivery ---

test('delivery reports the outcome rather than instructing the model what to do with it', () => {
  deliverBackgroundSubagentResult(
    view({ id: 'sa_1', status: 'completed', descriptions: ['a', 'b'] }), toolResult('out'), CHANNEL,
  );
  assert.match(delivered[0].text, /^\[Background agent sa_1 — a; b\]\n\nout$/);

  deliverBackgroundSubagentResult(view({ id: 'sa_2', status: 'stopped' }), null, CHANNEL);
  assert.match(delivered[1].text, /Stopped before it finished\. No result\./);

  deliverBackgroundSubagentResult(
    view({ id: 'sa_3', status: 'failed', error: 'boom' }), null, CHANNEL,
  );
  assert.match(delivered[2].text, /Failed: boom/);
});

test('delivery with nowhere to go is dropped, not queued for hours later', () => {
  deliverBackgroundSubagentResult(view(), toolResult('out'), undefined);
  setSubagentTurnSender(null);
  deliverBackgroundSubagentResult(view(), toolResult('out'), CHANNEL);
  assert.equal(delivered.length, 0);
});

test('a sender that throws does not take the settle hook down with it', () => {
  setSubagentTurnSender(() => { throw new Error('adapter gone'); });
  assert.doesNotThrow(() => deliverBackgroundSubagentResult(view(), toolResult('out'), CHANNEL));
});

// --- PI's own entry ---

const { createSubagentStopTool, createSubagentTool } = await import(
  '../src/agent-adapter/pi/subagent.js'
);

/** The shared role table, seeded once — resolution happens before the background branch. */
const piRolesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bg-roles-'));
fs.writeFileSync(
  path.join(piRolesDir, 'general-purpose.md'),
  '---\nname: general-purpose\ndescription: d\n---\nbody',
);

/** The SDK's content blocks are a union; every result these tools return is text. */
function textOf(result: { content: ReadonlyArray<{ type: string }> }): string {
  const block = result.content[0] as { type: string; text?: unknown };
  return block.type === 'text' ? String(block.text) : '';
}

function piDeps(overrides: Record<string, unknown> = {}) {
  return {
    agentDir: '/tmp/agents',
    rolesDir: piRolesDir,
    ensureRoles: () => {},
    createSession: (() => { throw new Error('no child should be created'); }) as any,
    childExtensions: () => [],
    parentEnv: { CORTEX_SESSION_ID: SESSION, SLACK_CHANNEL: CHANNEL } as NodeJS.ProcessEnv,
    ...overrides,
  } as any;
}

test('PI\'s agent tool hands a backgrounded call to the shared registry, session and all', async () => {
  const calls: any[] = [];
  const tool = createSubagentTool(piDeps({
    startBackgroundSubagent: async (request: any) => { calls.push(request); return { id: 'sa_pi' }; },
  }));
  const result = await tool.execute('call-1', {
    description: 'd', prompt: 'p', subagent_type: 'general-purpose', run_in_background: true,
  } as any, undefined, () => {}, {} as any);

  assert.match(textOf(result), /Agent sa_pi started in the background/);
  assert.match(textOf(result), /agent_stop\("sa_pi"\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, SESSION);
  assert.equal(calls[0].conduit, CHANNEL);
  assert.equal(calls[0].invocation.mode, 'single');
  assert.equal(typeof calls[0].runChild, 'function');
});

test('PI refuses run_in_background rather than silently blocking when it cannot background', async () => {
  const tool = createSubagentTool(piDeps());
  await assert.rejects(
    () => tool.execute('call-2', {
      description: 'd', prompt: 'p', subagent_type: 'general-purpose', run_in_background: true,
    } as any, undefined, () => {}, {} as any),
    /run_in_background is unavailable/,
  );
});

test('PI registers agent_stop only when it can actually background a run', async () => {
  assert.equal(createSubagentStopTool(piDeps()), null);
  const tool = createSubagentStopTool(piDeps({ stopBackgroundSubagent: async () => 'stopped' }))!;
  assert.equal(tool.name, 'agent_stop');
  const result = await tool.execute('call-3', { agent_id: 'sa_pi' } as any, undefined, () => {}, {} as any);
  assert.match(textOf(result), /sa_pi/);

  const missing = createSubagentStopTool(piDeps({ stopBackgroundSubagent: async () => null }))!;
  const nothing = await missing.execute('call-4', { agent_id: 'ghost' } as any, undefined, () => {}, {} as any);
  assert.match(textOf(nothing), /No such agent run: ghost\./);
});
