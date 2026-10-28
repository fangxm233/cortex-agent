import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionRegistryRepo } from '../../../src/store/session-registry-repo.js';
import { ConversationHistoryRepo } from '../../../src/store/conversation-history-repo.js';
import { SessionTotalsCarryRepo } from '../../../src/store/session-totals-repo.js';
import { ProjectStore } from '../../../src/domain/projects/project-store.js';
import { deleteProject, type ProjectDeleteDeps } from '../../../src/domain/projects/project-delete.js';

async function makeHarness(busy: string[] = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-project-delete-'));
  const projectsDir = path.join(root, 'projects');
  await fs.mkdir(projectsDir, { recursive: true });
  const projects = new ProjectStore({ projectsDir, watchEnabled: false });
  await projects.initialize();
  const registry = new SessionRegistryRepo(path.join(root, 'session-registry.jsonl'));
  const calls: string[] = [];
  const schedules = new Map([['s1', 'alpha'], ['s2', 'beta']]);
  const deps: ProjectDeleteDeps = {
    projects,
    sessions: {
      registry,
      historyRepo: new ConversationHistoryRepo(path.join(root, 'history')),
      sessionTotals: new SessionTotalsCarryRepo(path.join(root, 'totals.json')),
      busySessionIds: () => busy,
      paths: { historyDir: path.join(root, 'history'), piSessionsDir: path.join(root, 'pi'), claudeCaptureDir: root, claudeProjectDir: root },
    },
    listProjectSessions: (id) => registry.listByProject(id),
    schedules: {
      listIds: async (id) => [...schedules].filter(([, project]) => project === id).map(([sid]) => sid),
      remove: async (sid) => { calls.push(`schedule:${sid}`); schedules.delete(sid); },
    },
    unbindConduits: async (id) => { calls.push(`unbind:${id}`); },
    forgetProject: async (id) => { calls.push(`forget:${id}`); },
  };
  return { projects, registry, deps, calls };
}

function opts(id: string, projectId: string) {
  return { sessionId: id, channel: `web:${id}`, backend: 'claude', kind: 'local' as const, projectId, label: id };
}

test('deleting a project removes its schedules, bindings, sessions, records and directory', async () => {
  const h = await makeHarness();
  assert.equal(h.projects.createProject('alpha').ok, true);
  assert.equal(h.projects.createProject('beta').ok, true);
  await h.registry.registerSession(opts('a1', 'alpha'));
  await h.registry.registerSession(opts('a2', 'alpha'));
  await h.registry.registerSession(opts('b1', 'beta'));

  assert.deepEqual(await deleteProject(h.deps, 'alpha'), { ok: true, sessions: 2, schedules: 1 });
  assert.deepEqual(h.calls, ['schedule:s1', 'unbind:alpha', 'forget:alpha']);
  assert.equal(h.projects.get('alpha'), undefined);
  assert.equal(await fs.stat(path.join(h.projects.get('beta')!.contextDir, '..', 'alpha')).then(() => true, () => false), false);
  assert.deepEqual((await h.registry.listRecentSessions(10)).map(s => s.sessionId), ['b1']);
});

test('general and unknown projects are refused; a busy session keeps the whole project', async () => {
  const h = await makeHarness(['a1']);
  assert.deepEqual(await deleteProject(h.deps, 'general'), { ok: false, reason: 'protected' });
  assert.deepEqual(await deleteProject(h.deps, 'nope'), { ok: false, reason: 'not-found' });
  h.projects.createProject('alpha');
  await h.registry.registerSession(opts('a1', 'alpha'));
  assert.deepEqual(await deleteProject(h.deps, 'alpha'), { ok: false, reason: 'busy', busyIds: ['a1'] });
  assert.deepEqual(h.calls, []);
  assert.ok(h.projects.get('alpha'));
});
