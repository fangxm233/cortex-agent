import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mutateInputSchemas } from '../../../src/domain/ui-service/input-schemas.js';
import { createAppRouter } from '../../../src/domain/ui-service/app-router.js';
import type { UiService } from '../../../src/domain/ui-service/types.js';

const selection = { backend: 'claude', provider: null, model: 'opus', thinking: null, mode: 'plan' };

test('session mutation requires a complete selection and rejects retired fields', () => {
  const schema = mutateInputSchemas['sessions.setSelection'];
  assert.deepEqual(schema.parse({ sessionId: 's', selection }), { sessionId: 's', selection });
  for (const input of [{ sessionId: 's' }, { sessionId: 's', selection: {} }, { sessionId: 's', profileName: 'plan', selection }]) {
    assert.equal(schema.safeParse(input).success, false);
  }
  for (const key of Object.keys(selection)) {
    const partial = { ...selection };
    delete partial[key];
    assert.equal(schema.safeParse({ sessionId: 's', selection: partial }).success, false, key);
  }
});

test('createAndSend and schedule inputs use the same complete choice', () => {
  assert.deepEqual(mutateInputSchemas['sessions.createAndSend'].parse({ projectId: 'p', text: 'hi', selection }).selection, selection);
  assert.deepEqual(mutateInputSchemas['schedules.add'].parse({ type: 'once', message: 'hi', delay: 1000, selection }).selection, selection);
  assert.deepEqual(mutateInputSchemas['schedules.update'].parse({ scheduleId: 's', selection }).selection, selection);
  assert.equal(mutateInputSchemas['schedules.add'].safeParse({ type: 'once', message: 'hi', delay: 1000, selection: {} }).success, false);
});

test('retired operations and config section have no compatibility aliases', () => {
  const schemas = mutateInputSchemas as Record<string, unknown>;
  for (const op of ['sessions.setProfile', 'profiles.create', 'profiles.update', 'profiles.remove']) assert.equal(schemas[op], undefined);
  assert.equal(mutateInputSchemas['config.set'].safeParse({ section: 'profiles', value: { defaultProfile: 'plan' } }).success, false);
});

test('tRPC routes dispatch the exact model operations and preserve null selection fields', async () => {
  const calls: unknown[] = [];
  const service = { mutate: async (op, args) => { calls.push([op, args]); return { ok: true, data: { changed: true } }; } } as UiService;
  const caller = createAppRouter(service).createCaller({});
  await caller.models.favorites.add({ backend: 'claude', model: 'opus' });
  await caller.models.favorites.remove({ backend: 'pi', provider: 'deepseek', model: 'flash' });
  await caller.models.setDefault({ selection: selection as any });
  await caller.models.setThinking({ ref: { backend: 'claude', provider: null, model: 'opus' }, thinking: null });
  assert.deepEqual(calls, [
    ['models.favorites.add', { backend: 'claude', model: 'opus' }],
    ['models.favorites.remove', { backend: 'pi', provider: 'deepseek', model: 'flash' }],
    ['models.setDefault', { selection }],
    ['models.setThinking', { ref: { backend: 'claude', provider: null, model: 'opus' }, thinking: null }],
  ]);
});
