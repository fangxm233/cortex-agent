import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleCreateProject } from '../../../src/domain/ui-service/mutate/projects.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import { makeUiDeps } from './ui-deps-fixture.js';

function makeDeps(createProject: UiServiceDeps['projectStore']['createProject']): UiServiceDeps {
  return makeUiDeps({
    projectStore: {
      list: () => [],
      get: () => undefined,
      exists: () => false,
      getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }),
      createProject,
    },
    approvalsPath: '/tmp/PENDING_APPROVALS.md',
  });
}

test('projects.create returns ok with the new project id on success', async () => {
  const deps = makeDeps((name) => ({
    ok: true,
    project: { id: name, name, kind: 'user', contextDir: `/p/${name}` },
  }));
  const result = await handleCreateProject(deps, { name: 'nimbus' });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data, { id: 'nimbus' });
});

test('projects.create maps invalid-name to an invalid-name Err (not invalid-args)', async () => {
  const deps = makeDeps(() => ({ ok: false, code: 'invalid-name', message: 'bad' }));
  const result = await handleCreateProject(deps, { name: '..' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'invalid-name');
});

test('projects.create maps already-exists to an already-exists Err', async () => {
  const deps = makeDeps(() => ({ ok: false, code: 'already-exists', message: 'dup' }));
  const result = await handleCreateProject(deps, { name: 'orchard' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'already-exists');
});
