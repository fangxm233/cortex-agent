import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createUiService } from '../../../src/domain/ui-service/index.js';
import { makeUiDeps } from './ui-deps-fixture.js';

test('sessions.delete maps deleted, busy and missing sessions', async () => {
  const outcomes = {
    a: { ok: true as const, deletedIds: ['a', 'a-worker'] },
    b: { ok: false as const, reason: 'busy' as const, busyIds: ['b'] },
  };
  const service = createUiService(makeUiDeps({
    deleteSession: async (id) => outcomes[id as keyof typeof outcomes] ?? { ok: false, reason: 'not-found' },
  }));
  assert.deepEqual(await service.mutate('sessions.delete', { sessionId: 'a' }), { ok: true, data: { deletedIds: ['a', 'a-worker'] } });
  assert.equal((await service.mutate('sessions.delete', { sessionId: 'b' }) as { code?: string }).code, 'session-running');
  assert.equal((await service.mutate('sessions.delete', { sessionId: 'c' }) as { code?: string }).code, 'not-found');
});

test('projects.delete maps deleted, protected, busy and missing projects', async () => {
  const service = createUiService(makeUiDeps({
    deleteProject: async (id) => {
      if (id === 'p') return { ok: true, sessions: 3, schedules: 1 };
      if (id === 'general') return { ok: false, reason: 'protected' };
      if (id === 'busy') return { ok: false, reason: 'busy', busyIds: ['s'] };
      return { ok: false, reason: 'not-found' };
    },
  }));
  assert.deepEqual(await service.mutate('projects.delete', { projectId: 'p' }), { ok: true, data: { sessions: 3, schedules: 1 } });
  assert.equal((await service.mutate('projects.delete', { projectId: 'general' }) as { code?: string }).code, 'invalid-args');
  assert.equal((await service.mutate('projects.delete', { projectId: 'busy' }) as { code?: string }).code, 'session-running');
  assert.equal((await service.mutate('projects.delete', { projectId: 'x' }) as { code?: string }).code, 'not-found');
});
