import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  handleWaitpointsList,
  ownsWaitpoint,
  countWaitingOn,
  toWaitpointInfo,
} from '../../../src/domain/ui-service/query/waitpoints.js';
import { handleCancelWaitpoint } from '../../../src/domain/ui-service/mutate/waitpoints.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { Waitpoint } from '../../../src/store/waitpoint-repo.js';

const T0 = Date.UTC(2026, 8, 18, 10, 0, 0);

function wp(overrides: Partial<Waitpoint> = {}): Waitpoint {
  return {
    id: 'wp_aaaaaaaaaaaa',
    secretHash: 'c0ffee'.repeat(10),
    label: 'train-arm2',
    intent: 'wait for the run',
    owner: { sessionId: 's1', channel: 'web:s1', threadId: null, project: 'proj' },
    emitFrom: { kind: 'local' },
    quorum: { need: 1, members: [], got: [] },
    failFast: true,
    maxSignals: 1,
    fires: 0,
    coalesceMs: 3000,
    createdAt: T0,
    expiresAt: T0 + 3600_000,
    resolvedAt: null,
    state: 'armed',
    signals: [],
    delivery: { pending: false, attempts: 0, lastError: null, lastAt: null },
    wakes: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    approvalsPath: '/tmp/nonexistent-approvals.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({} as any),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: { getProjectConduits: async () => ({}) } as any,
    ...overrides,
  };
}

function depsWith(records: Waitpoint[], session: { sessionId: string; channel: string } | null, cancel?: (id: string) => Promise<{ cancelled: boolean; state?: string }>): UiServiceDeps {
  return makeDeps({
    sessionStore: {
      listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [],
      getById: async (id: string) => (session && session.sessionId === id ? (session as any) : null),
    },
    waitpointRegistry: {
      listArmed: async () => records.filter((r) => r.state === 'armed'),
      cancel: cancel ?? (async () => ({ cancelled: true, state: 'cancelled' })),
    },
  });
}

// ── the ownership rule (the thing most likely to be got wrong) ──────────────────

test('a waitpoint belongs to the session that armed it', () => {
  assert.equal(ownsWaitpoint(wp(), 's1', 'web:s1'), true);
});

test('sessionId alone is enough — survives a channel rebind', () => {
  const w = wp({ owner: { sessionId: 's1', channel: 'slack:C123', threadId: null, project: null } });
  assert.equal(ownsWaitpoint(w, 's1', 'web:s1'), true);
});

test('channel alone is enough — the wake will land on whoever holds the channel now', () => {
  // Armed by a session that is gone; the current session owns the same conduit.
  const w = wp({ owner: { sessionId: 'old-session', channel: 'sched:nightly', threadId: null, project: null } });
  assert.equal(ownsWaitpoint(w, 's2', 'sched:nightly'), true);
});

test('an unrelated waitpoint belongs to nobody else', () => {
  assert.equal(ownsWaitpoint(wp(), 's2', 'web:s2'), false);
});

test('a session with no channel still matches on sessionId', () => {
  assert.equal(ownsWaitpoint(wp(), 's1', null), true);
});

test('matching on both clauses counts the waitpoint once', () => {
  const counts = countWaitingOn([wp()], [{ sessionId: 's1', channel: 'web:s1' }]);
  assert.equal(counts.get('s1'), 1);
});

// ── serialisation ──────────────────────────────────────────────────────────────

test('the serialised view never carries the capability secret', () => {
  const view = toWaitpointInfo(wp({ signals: [{ at: T0, status: 'ok', source: 'http', message: 'done', data: { huge: 'x'.repeat(100) } }] }), T0, 12);
  const json = JSON.stringify(view);
  assert.equal(json.includes('secret'), false, 'no secret-shaped key may appear');
  assert.equal(json.includes('c0ffee'), false, 'the hash itself must not leak');
  // signals[].data is dropped on purpose — externally written and capped at 16 KB per signal.
  assert.equal(json.includes('huge'), false);
});

test("a legacy quorum.need of 'all' does not crash the view", () => {
  const w = wp({ quorum: { need: 'all' as any, members: ['a', 'b', 'c'], got: ['a'] } });
  const view = toWaitpointInfo(w, T0, 12);
  assert.equal(view.quorum.need, 3);
  assert.equal(view.quorum.got, 1);
});

test("'all' with no declared members falls back to 1", () => {
  const view = toWaitpointInfo(wp({ quorum: { need: 'all' as any, members: [], got: [] } }), T0, 12);
  assert.equal(view.quorum.need, 1);
});

test('anonymous reporters can outnumber the declared members', () => {
  // Three anonymous signals take synthetic slots #1..#3 while members[] stays empty.
  const w = wp({ quorum: { need: 3, members: [], got: ['#1', '#2', '#3'] } });
  const view = toWaitpointInfo(w, T0, 12);
  assert.equal(view.quorum.got, 3);
  assert.equal(view.quorum.members.length, 0);
});

test('only wakes inside the trailing hour count against the budget', () => {
  const now = T0 + 10 * 60_000;
  const w = wp({ wakes: [T0 - 2 * 3600_000, T0 - 90 * 60_000, T0, T0 + 60_000] });
  assert.equal(toWaitpointInfo(w, now, 12).wakesLastHour, 2);
});

test('the rate-limit latch and delivery retry state are surfaced', () => {
  const w = wp({
    rateLimitNotified: true,
    delivery: { pending: true, attempts: 3, lastError: 'conduit closed', lastAt: T0 },
  });
  const view = toWaitpointInfo(w, T0, 12);
  assert.equal(view.rateLimited, true);
  assert.equal(view.delivery.attempts, 3);
  assert.equal(view.delivery.lastError, 'conduit closed');
});

// ── the list handler ───────────────────────────────────────────────────────────

test('lists only this session, soonest expiry first', async () => {
  const mine = wp({ id: 'wp_mine', expiresAt: T0 + 7200_000 });
  const urgent = wp({ id: 'wp_urgent', expiresAt: T0 + 60_000 });
  const theirs = wp({ id: 'wp_theirs', owner: { sessionId: 'other', channel: 'web:other', threadId: null, project: null } });
  const deps = depsWith([mine, urgent, theirs], { sessionId: 's1', channel: 'web:s1' });
  const out = await handleWaitpointsList(deps, { sessionId: 's1' });
  assert.deepEqual(out.map((w) => w.id), ['wp_urgent', 'wp_mine']);
});

test('settled waitpoints never appear (the transcript already told that story)', async () => {
  const fired = wp({ id: 'wp_fired', state: 'fired', resolvedAt: T0 });
  const deps = depsWith([fired], { sessionId: 's1', channel: 'web:s1' });
  assert.deepEqual(await handleWaitpointsList(deps, { sessionId: 's1' }), []);
});

test('without the waitpoint dep the list is empty rather than broken', async () => {
  const out = await handleWaitpointsList(makeDeps(), { sessionId: 's1' });
  assert.deepEqual(out, []);
});

test('an unknown session resolves no channel and matches on sessionId only', async () => {
  const byChannel = wp({ id: 'wp_ch', owner: { sessionId: 'gone', channel: 'web:s1', threadId: null, project: null } });
  const deps = depsWith([wp(), byChannel], null);
  const out = await handleWaitpointsList(deps, { sessionId: 's1' });
  assert.deepEqual(out.map((w) => w.id), ['wp_aaaaaaaaaaaa']);
});

// ── cancel ─────────────────────────────────────────────────────────────────────

test('cancelling an armed waitpoint succeeds', async () => {
  const deps = depsWith([wp()], { sessionId: 's1', channel: 'web:s1' });
  const res = await handleCancelWaitpoint(deps, { waitpointId: 'wp_aaaaaaaaaaaa' });
  assert.equal(res.ok, true);
  assert.deepEqual((res as any).data, { cancelled: true, state: 'cancelled' });
});

test('cancelling an already-fired waitpoint reports why, and is not an error', async () => {
  const deps = depsWith([], { sessionId: 's1', channel: 'web:s1' }, async () => ({ cancelled: false, state: 'fired' }));
  const res = await handleCancelWaitpoint(deps, { waitpointId: 'wp_x' });
  assert.equal(res.ok, true);
  assert.deepEqual((res as any).data, { cancelled: false, state: 'fired' });
});

test('cancelling an unknown waitpoint is a not-found', async () => {
  const deps = depsWith([], { sessionId: 's1', channel: 'web:s1' }, async () => ({ cancelled: false }));
  const res = await handleCancelWaitpoint(deps, { waitpointId: 'wp_nope' });
  assert.equal(res.ok, false);
  assert.equal((res as any).code, 'not-found');
});

test('without the waitpoint dep cancel fails cleanly', async () => {
  const res = await handleCancelWaitpoint(makeDeps(), { waitpointId: 'wp_x' });
  assert.equal(res.ok, false);
  assert.equal((res as any).code, 'not-available');
});
