// input:  isolated test home, fake UiService, typed tRPC caller
// output: AppRouter routing including auth flows and errors
// pos:    Transport-contract regression coverage for UI routes
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // MUST be first import: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TRPCError } from '@trpc/server';
import { createAppRouter } from '@domain/ui-service/app-router.js';
import { createCallerFactory } from '@domain/ui-service/trpc.js';
import type {
  UiService,
  QueryScope,
  MutateOp,
  Result,
  UiEvent,
  SubscribeFilter,
} from '@domain/ui-service/index.js';

// ── Fake UiService ────────────────────────────────────────────────────────────────
interface QueryCall { scope: QueryScope; params: unknown; }
interface MutateCall { op: MutateOp; args: unknown; }

interface FakeOpts {
  queryResult?: Result<any>;
  mutateResult?: Result<any>;
  events?: UiEvent[];
}

function makeFake(opts: FakeOpts = {}) {
  const queryCalls: QueryCall[] = [];
  const mutateCalls: MutateCall[] = [];
  let subscribeFilter: SubscribeFilter | null = null;
  let subscribeExecutionLogId: string | null = null;
  let subscribeClosed = false;

  const uiService: UiService = {
    async query(scope: any, params: any) {
      queryCalls.push({ scope, params });
      return (opts.queryResult ?? { ok: true, data: { scope } }) as any;
    },
    async mutate(op: any, args: any) {
      mutateCalls.push({ op, args });
      return (opts.mutateResult ?? { ok: true, data: undefined }) as any;
    },
    subscribe(filter: SubscribeFilter) {
      subscribeFilter = filter;
      const events = opts.events ?? [];
      const iterable: AsyncIterable<UiEvent> & { close(): void } = {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev;
        },
        close() { subscribeClosed = true; },
      };
      return iterable;
    },
    subscribeExecutionLog(executionId: string) {
      subscribeExecutionLogId = executionId;
      const events = opts.events ?? [];
      const iterable: AsyncIterable<UiEvent> & { close(): void } = {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev;
        },
        close() { subscribeClosed = true; },
      };
      return iterable;
    },
  };

  return {
    uiService,
    queryCalls,
    mutateCalls,
    getSubscribeFilter: () => subscribeFilter,
    getSubscribeExecutionLogId: () => subscribeExecutionLogId,
    wasSubscribeClosed: () => subscribeClosed,
  };
}

function makeCaller(fake: ReturnType<typeof makeFake>) {
  return createCallerFactory(createAppRouter(fake.uiService))({});
}

// ── Query routing + Result unwrap ──────────────────────────────────────────────────

const QUERY_CASES: Array<{ scope: QueryScope; call: (c: any) => Promise<unknown>; input: any }> = [
  { scope: 'projects.list', call: (c) => c.projects.list({}), input: {} },
  { scope: 'sessions.list', call: (c) => c.sessions.list({}), input: {} },
  { scope: 'sessions.transcript', call: (c) => c.sessions.transcript({ sessionId: 's1' }), input: {} },
  { scope: 'threads.list', call: (c) => c.threads.list({}), input: {} },
  { scope: 'tasks.list', call: (c) => c.tasks.list({}), input: {} },
  { scope: 'schedules.list', call: (c) => c.schedules.list({}), input: {} },
  { scope: 'executions.list', call: (c) => c.executions.list({}), input: {} },
  { scope: 'executions.get', call: (c) => c.executions.get({ executionId: 'e1' }), input: {} },
  { scope: 'cost.summary', call: (c) => c.cost.summary({}), input: {} },
  { scope: 'auth.status', call: (c) => c.auth.status({}), input: {} },
  { scope: 'auth.flowState', call: (c) => c.auth.flowState({ flowId: 'flow-1' }), input: {} },
  { scope: 'skills.list', call: (c) => c.skills.list({}), input: {} },
  { scope: 'system.rateLimitStatus', call: (c) => c.system.rateLimitStatus({}), input: {} },
];

test('every query routes to the correct scope and unwraps Result.data', async () => {
  for (const tc of QUERY_CASES) {
    const fake = makeFake({ queryResult: { ok: true, data: { routed: tc.scope } } });
    const caller = makeCaller(fake);
    const out = await tc.call(caller);
    assert.equal(fake.queryCalls.length, 1, `${tc.scope} should call query once`);
    assert.equal(fake.queryCalls[0].scope, tc.scope, `routed scope for ${tc.scope}`);
    assert.deepEqual(out, { routed: tc.scope }, `unwrapped data for ${tc.scope}`);
  }
});

// ── Mutation routing + Result unwrap ────────────────────────────────────────────────

const MUTATE_CASES: Array<{ op: MutateOp; call: (c: any) => Promise<unknown>; }> = [
  { op: 'projects.create', call: (c) => c.projects.create({ name: 'nimbus' }) },
  { op: 'sessions.send', call: (c) => c.sessions.send({ sessionId: 's1', text: 'hi' }) },
  { op: 'sessions.cancel', call: (c) => c.sessions.cancel({ sessionId: 's1' }) },
  { op: 'sessions.compact', call: (c) => c.sessions.compact({ sessionId: 's1' }) },
  { op: 'auth.startLogin', call: (c) => c.auth.startLogin({ backend: 'claude', provider: 'anthropic', authType: 'api_key' }) },
  { op: 'auth.respondPrompt', call: (c) => c.auth.respondPrompt({ flowId: 'flow-1', value: 'secret' }) },
  { op: 'auth.cancelFlow', call: (c) => c.auth.cancelFlow({ flowId: 'flow-1' }) },
  { op: 'threads.cancel', call: (c) => c.threads.cancel({ threadId: 't1' }) },
  { op: 'executions.cancel', call: (c) => c.executions.cancel({ executionId: 'e1' }) },
  { op: 'schedules.pause', call: (c) => c.schedules.pause({ scheduleId: 's1' }) },
  { op: 'schedules.resume', call: (c) => c.schedules.resume({ scheduleId: 's1' }) },
  { op: 'schedules.remove', call: (c) => c.schedules.remove({ scheduleId: 's1' }) },
  { op: 'schedules.add', call: (c) => c.schedules.add({ type: 'once', message: 'm', delay: 1000 }) },
  { op: 'tasks.claim', call: (c) => c.tasks.claim({ projectId: 'p', taskId: 'a1b2' }) },
  { op: 'tasks.unclaim', call: (c) => c.tasks.unclaim({ projectId: 'p', taskId: 'a1b2' }) },
  { op: 'tasks.complete', call: (c) => c.tasks.complete({ projectId: 'p', taskId: 'a1b2' }) },
  { op: 'tasks.block', call: (c) => c.tasks.block({ projectId: 'p', taskId: 'a1b2', reason: 'x' }) },
  { op: 'tasks.unblock', call: (c) => c.tasks.unblock({ projectId: 'p', taskId: 'a1b2' }) },
];

test('every mutation routes to the correct op and unwraps Result.data', async () => {
  for (const tc of MUTATE_CASES) {
    const fake = makeFake({ mutateResult: { ok: true, data: { routed: tc.op } } });
    const caller = makeCaller(fake);
    const out = await tc.call(caller);
    assert.equal(fake.mutateCalls.length, 1, `${tc.op} should call mutate once`);
    assert.equal(fake.mutateCalls[0].op, tc.op, `routed op for ${tc.op}`);
    assert.deepEqual(out, { routed: tc.op }, `unwrapped data for ${tc.op}`);
  }
});


// ── Err → TRPCError mapping ──────────────────────────────────────────────────────────

test('query Err maps to a TRPCError with the mapped code', async () => {
  const fake = makeFake({ queryResult: { ok: false, code: 'not-found', message: 'nope' } });
  const caller = makeCaller(fake);
  await assert.rejects(
    () => caller.tasks.list({}),
    (e: unknown) => e instanceof TRPCError && e.code === 'NOT_FOUND' && e.message === 'nope',
  );
});

test('mutation Err maps to a TRPCError with the mapped code', async () => {
  const fake = makeFake({ mutateResult: { ok: false, code: 'invalid-args', message: 'bad' } });
  const caller = makeCaller(fake);
  await assert.rejects(
    () => caller.threads.cancel({ threadId: 't1' }),
    (e: unknown) => e instanceof TRPCError && e.code === 'BAD_REQUEST',
  );
});

test('unknown Err code falls back to INTERNAL_SERVER_ERROR', async () => {
  const fake = makeFake({ mutateResult: { ok: false, code: 'weird-code', message: 'huh' } });
  const caller = makeCaller(fake);
  await assert.rejects(
    () => caller.tasks.claim({ projectId: 'p', taskId: 'a1b2' }),
    (e: unknown) => e instanceof TRPCError && e.code === 'INTERNAL_SERVER_ERROR',
  );
});

// ── Subscription ──────────────────────────────────────────────────────────────────────

test('subscription yields the injected events and passes the filter through', async () => {
  const events: UiEvent[] = [
    { type: 'a.happened', ts: '2026-07-06T00:00:00.000Z', payload: { n: 1 } },
    { type: 'b.happened', ts: '2026-07-06T00:00:01.000Z', payload: { n: 2 } },
  ];
  const fake = makeFake({ events });
  const caller = makeCaller(fake);

  const iter = await caller.subscribe({ events: ['a.happened', 'b.happened'], projectId: 'proj' });

  const received: UiEvent[] = [];
  for await (const ev of iter) {
    received.push(ev as UiEvent);
    if (received.length >= 2) break;
  }

  assert.deepEqual(received, events);
  assert.deepEqual(fake.getSubscribeFilter(), { events: ['a.happened', 'b.happened'], projectId: 'proj' });
});

test('subscription passes a sessionId filter through (session.message live stream)', async () => {
  const fake = makeFake({ events: [] });
  const caller = makeCaller(fake);
  const iter = await caller.subscribe({ events: ['session.message'], sessionId: 'sess-1' });
  for await (const _ of iter) break;
  assert.deepEqual(fake.getSubscribeFilter(), { events: ['session.message'], sessionId: 'sess-1' });
});
