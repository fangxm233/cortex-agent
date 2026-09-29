import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleProjectsList } from '../../../src/domain/ui-service/query/projects.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import { makeUiDeps } from './ui-deps-fixture.js';

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return makeUiDeps({
    projectStore: {
      list: () => [
        { id: 'cortex-self', name: 'cortex-self', kind: 'user' as const, contextDir: '/projects/cortex-self' },
        { id: 'general', name: 'general', kind: 'general' as const, contextDir: '/projects/general' },
      ],
      get: () => undefined,
      exists: () => false,
      getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/projects/general' }),
      createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }),
    },
    adapter: { getProjectConduits: async () => ({ 'cortex-self': 'C123' }) } as any,
    ...overrides,
  });
}

test('projects.list returns ProjectConduitInfo for each project', async () => {
  const result = await handleProjectsList(makeDeps());
  assert.equal(result.length, 2);

  const selfProject = result.find(p => p.id === 'cortex-self');
  assert.ok(selfProject);
  assert.equal(selfProject.kind, 'research');
  assert.equal(selfProject.contextDir, '/projects/cortex-self');
  assert.equal(typeof selfProject.hasMission, 'boolean');
  assert.deepEqual(selfProject.conduits, { 'cortex-self': 'C123' });

  const general = result.find(p => p.id === 'general');
  assert.ok(general);
  assert.equal(general.kind, 'general');
});

test('projects.list handles conduit lookup failure gracefully', async () => {
  const result = await handleProjectsList(makeDeps({
    adapter: { getProjectConduits: async () => { throw new Error('fail'); } } as any,
  }));
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].conduits, {});
});
