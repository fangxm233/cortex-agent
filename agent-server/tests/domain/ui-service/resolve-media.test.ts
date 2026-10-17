import { expect, test, vi } from 'vitest';
import { createAppRouter } from '../../../src/domain/ui-service/app-router.js';
import { createUiService } from '../../../src/domain/ui-service/ui-service.js';
import { makeUiDeps } from './ui-deps-fixture.js';
import type { ResolveMediaResult } from '../../../src/domain/ui-service/inline-media-types.js';
import type { Session } from '../../../src/store/session-registry-repo.js';

const input = { sessionId: 'session-1', ts: '2026-10-17T00:00:00.000Z', src: '/a.png' };
function setup(result: ResolveMediaResult, exists = true) {
  const resolveMedia = vi.fn().mockResolvedValue(result);
  const deps = makeUiDeps({
    resolveMedia,
    sessionStore: { getById: async () => exists ? { sessionId: input.sessionId } as Session : null },
  });
  const caller = createAppRouter(createUiService(deps)).createCaller({});
  return { caller, resolveMedia };
}

test('resolveMedia mutation returns plain workspace path and forwards stable message identity', async () => {
  const result = { path: 'workspace/outputs/session-1/inline/hash.png', name: 'a.png', kind: 'image' as const };
  const { caller, resolveMedia } = setup(result);
  expect(await caller.sessions.resolveMedia(input)).toEqual(result);
  expect(resolveMedia).toHaveBeenCalledWith(input);
});

test.each(['offline', 'not_found', 'unsupported', 'too_large', 'load_failed'] as const)('returns %s as structured data, not a tRPC exception', async code => {
  const result = { error: { code, reason: 'Media unavailable' } };
  expect(await setup(result).caller.sessions.resolveMedia(input)).toEqual(result);
});

test('missing session returns not_found without reading files', async () => {
  const { caller, resolveMedia } = setup({ error: { code: 'load_failed', reason: 'unused' } }, false);
  expect(await caller.sessions.resolveMedia(input)).toMatchObject({ error: { code: 'not_found' } });
  expect(resolveMedia).not.toHaveBeenCalled();
});

test('unexpected resolver failure is normalized to load_failed', async () => {
  const { caller, resolveMedia } = setup({ error: { code: 'load_failed', reason: 'unused' } });
  resolveMedia.mockRejectedValue(new Error('disk unavailable'));
  expect(await caller.sessions.resolveMedia(input)).toEqual({ error: { code: 'load_failed', reason: 'disk unavailable' } });
});

test.each([{ ...input, sessionId: '../escape' }, { ...input, ts: '' }, { ...input, src: '' }])('validates mutation input before dispatch', async bad => {
  const { caller, resolveMedia } = setup({ error: { code: 'load_failed', reason: 'unused' } });
  await expect(caller.sessions.resolveMedia(bad)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(resolveMedia).not.toHaveBeenCalled();
});
