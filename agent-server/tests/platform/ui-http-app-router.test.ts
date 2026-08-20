// input:  isolated test home, fake UiService, typed tRPC caller
// output: AppRouter routing incl usage, draft ids, auth flows, and errors
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

test('sessions.createAndSend preserves a valid draft upload id at the runtime boundary', async () => {
  const fake = makeFake({ mutateResult: { ok: true, data: { sessionId: 'session-new' } } });
  const caller = makeCaller(fake);
  const draftUploadId = '11111111-1111-4111-8111-111111111111';

  await caller.sessions.createAndSend({
    projectId: 'project-1', text: 'inspect this', draftUploadId,
  } as any);

  assert.equal(fake.mutateCalls[0].op, 'sessions.createAndSend');
  assert.equal((fake.mutateCalls[0].args as any).draftUploadId, draftUploadId);
});

test('sessions.createAndSend rejects a non-UUID draft upload id', async () => {
  const fake = makeFake();
  const caller = makeCaller(fake);

  await assert.rejects(
    () => caller.sessions.createAndSend({
      projectId: 'project-1', text: 'inspect this', draftUploadId: '../escape',
    } as any),
    (error: unknown) => error instanceof TRPCError && error.code === 'BAD_REQUEST',
  );
  assert.equal(fake.mutateCalls.length, 0);
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
