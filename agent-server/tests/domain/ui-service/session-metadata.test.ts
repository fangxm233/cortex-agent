import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { TRPCError } from '@trpc/server';
import { createAppRouter } from '../../../src/domain/ui-service/app-router.js';
import { createCallerFactory } from '../../../src/domain/ui-service/trpc.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

function setup(found = true) {
  const setStarred = vi.fn(async (sessionId: string, starred: boolean) => found ? { sessionId, starred } : null);
  const rename = vi.fn(async (sessionId: string, label: string) => found ? { sessionId, label } : null);
  const publish = vi.fn();
  const deps = { sessionStore: { setStarred, rename }, bus: { publish } } as unknown as UiServiceDeps;
  const service = createUiService(deps);
  return { caller: createCallerFactory(createAppRouter(service))({}), service, setStarred, rename, publish };
}

test('star and rename router calls dispatch by stable ID and return normalized metadata', async () => {
  const { caller, setStarred, rename, publish } = setup();
  assert.deepEqual(await caller.sessions.setStarred({ sessionId: 'id', starred: true }), { sessionId: 'id', starred: true });
  assert.deepEqual(await caller.sessions.setStarred({ sessionId: 'id', starred: false }), { sessionId: 'id', starred: false });
  assert.deepEqual(await caller.sessions.rename({ sessionId: 'id', label: '  New title  ' }), { sessionId: 'id', label: 'New title' });
  assert.deepEqual(rename.mock.calls, [['id', 'New title']]);
  assert.deepEqual(setStarred.mock.calls, [['id', true], ['id', false]]);
  assert.equal(publish.mock.calls[2][0].type, 'ui.mutate-invoked');
});

test('rename accepts exactly 60 characters after trimming', async () => {
  const { caller } = setup();
  const label = 'x'.repeat(60);
  assert.deepEqual(await caller.sessions.rename({ sessionId: 'id', label: ` ${label} ` }), { sessionId: 'id', label });
});

test.each(['', '  \n ', 'x'.repeat(61), null, 12])('rename rejects invalid label %j before writing', async label => {
  const { caller, rename } = setup();
  await assert.rejects(() => caller.sessions.rename({ sessionId: 'id', label } as any),
    (error: unknown) => error instanceof TRPCError && error.code === 'BAD_REQUEST');
  assert.equal(rename.mock.calls.length, 0);
});

test.each([undefined, null, 'true', 1])('star rejects nonboolean %j before writing', async starred => {
  const { caller, setStarred } = setup();
  await assert.rejects(() => caller.sessions.setStarred({ sessionId: 'id', starred } as any),
    (error: unknown) => error instanceof TRPCError && error.code === 'BAD_REQUEST');
  assert.equal(setStarred.mock.calls.length, 0);
});

test('both operations reject empty IDs and use the standard not-found mapping', async () => {
  const { caller } = setup(false);
  for (const sessionId of ['', 'missing']) {
    const code = sessionId ? 'NOT_FOUND' : 'BAD_REQUEST';
    await assert.rejects(() => caller.sessions.rename({ sessionId, label: 'Title' }),
      (error: unknown) => error instanceof TRPCError && error.code === code);
    await assert.rejects(() => caller.sessions.setStarred({ sessionId, starred: true }),
      (error: unknown) => error instanceof TRPCError && error.code === code);
  }
});

test('direct service calls also validate and trim metadata', async () => {
  const { service, rename, setStarred } = setup();
  const invalidLabel = await service.mutate('sessions.rename', { sessionId: 'id', label: '  ' });
  const invalidStar = await service.mutate('sessions.setStarred', { sessionId: 'id', starred: 'yes' } as any);
  assert.equal(invalidLabel.ok, false);
  assert.equal(invalidStar.ok, false);
  assert.equal(rename.mock.calls.length, 0);
  assert.equal(setStarred.mock.calls.length, 0);
  assert.deepEqual(await service.mutate('sessions.rename', { sessionId: 'id', label: '  Title  ' }),
    { ok: true, data: { sessionId: 'id', label: 'Title' } });
});

test('read-only fixtures cannot report successful metadata writes', async () => {
  const service = createUiService({ sessionStore: {}, bus: { publish: () => {} } } as unknown as UiServiceDeps);
  const rename = await service.mutate('sessions.rename', { sessionId: 'id', label: 'Title' });
  const star = await service.mutate('sessions.setStarred', { sessionId: 'id', starred: true });
  assert.equal(rename.ok, false);
  assert.equal(star.ok, false);
  if (!rename.ok) assert.equal(rename.code, 'not-available');
  if (!star.ok) assert.equal(star.code, 'not-available');
});

test('storage failures remain errors rather than successful metadata responses', async () => {
  const { caller, rename, setStarred } = setup();
  rename.mockRejectedValueOnce(new Error('write failed'));
  setStarred.mockRejectedValueOnce(new Error('write failed'));
  await assert.rejects(() => caller.sessions.rename({ sessionId: 'id', label: 'Title' }),
    (error: unknown) => error instanceof TRPCError && error.code === 'INTERNAL_SERVER_ERROR');
  await assert.rejects(() => caller.sessions.setStarred({ sessionId: 'id', starred: true }),
    (error: unknown) => error instanceof TRPCError && error.code === 'INTERNAL_SERVER_ERROR');
});
