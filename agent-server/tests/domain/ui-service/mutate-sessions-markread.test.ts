import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  handleMarkReadSession,
  handleMarkManyReadSessions,
} from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

function makeDeps(sink: string[], known = ['sess-1']): UiServiceDeps {
  return {
    sessionStore: {
      getById: async (id: string) => (known.includes(id) ? { sessionId: id, name: 'cortex-x' } : null),
      markRead: async (id: string) => { sink.push(id); },
    },
  } as unknown as UiServiceDeps;
}

test('sessions.markRead stamps the session read and returns ok', async () => {
  const sink: string[] = [];
  const res = await handleMarkReadSession(makeDeps(sink), { sessionId: 'sess-1' });
  assert.equal(res.ok, true);
  assert.deepEqual(sink, ['sess-1']);
});

test('sessions.markRead → not-found for an unknown session', async () => {
  const sink: string[] = [];
  const res = await handleMarkReadSession(makeDeps(sink), { sessionId: 'sess-nope' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
  assert.deepEqual(sink, [], 'no write on unknown session');
});

test('sessions.markManyRead stamps every known session once and reports the count', async () => {
  const sink: string[] = [];
  const res = await handleMarkManyReadSessions(makeDeps(sink, ['sess-1', 'sess-2']), {
    sessionIds: ['sess-1', 'sess-2', 'sess-1'],
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.data, { marked: 2 });
  assert.deepEqual(sink, ['sess-1', 'sess-2'], 'duplicates collapse to one write');
});

test('sessions.markManyRead skips ids that no longer resolve instead of failing the batch', async () => {
  const sink: string[] = [];
  const res = await handleMarkManyReadSessions(makeDeps(sink, ['sess-1']), {
    sessionIds: ['sess-gone', 'sess-1'],
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.data, { marked: 1 });
  assert.deepEqual(sink, ['sess-1']);
});
