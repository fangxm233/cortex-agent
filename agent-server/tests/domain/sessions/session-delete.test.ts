import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionRegistryRepo } from '../../../src/store/session-registry-repo.js';
import { ConversationHistoryRepo } from '../../../src/store/conversation-history-repo.js';
import { SessionTotalsCarryRepo } from '../../../src/store/session-totals-repo.js';
import { deleteSessions, type SessionDeleteDeps } from '../../../src/domain/sessions/session-delete.js';

function registerOpts(id: string, extra: Record<string, unknown> = {}) {
  return { sessionId: id, channel: `web:${id}`, backend: 'claude', kind: 'local' as const, projectId: 'proj', label: id, ...extra };
}

async function exists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(() => true, () => false);
}

async function makeHarness(busy: string[] = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-session-delete-'));
  const dirs = {
    history: path.join(root, 'history'),
    pi: path.join(root, 'sessions-pi'),
    claude: path.join(root, 'claude', 'projects', 'home'),
    outputs: path.join(root, 'outputs'),
    attachments: path.join(root, 'attachments'),
  };
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true });
  const registry = new SessionRegistryRepo(path.join(root, 'session-registry.jsonl'));
  const history = new ConversationHistoryRepo(dirs.history);
  const forgotten: string[] = [];
  const settled: string[] = [];
  const deps: SessionDeleteDeps = {
    registry,
    historyRepo: history,
    sessionTotals: new SessionTotalsCarryRepo(path.join(root, 'session-totals.json')),
    forgetSessions: async (ids) => { forgotten.push(...ids); },
    busySessionIds: () => busy,
    settleSession: async (session) => { settled.push(session.sessionId); },
    paths: {
      historyDir: dirs.history,
      piSessionsDir: dirs.pi,
      claudeCaptureDir: path.join(root, 'capture'),
      claudeProjectDir: dirs.claude,
      sessionDirRoots: [dirs.outputs, dirs.attachments],
    },
  };
  return { root, dirs, registry, history, deps, forgotten, settled };
}

/** A session with a transcript, a history file, a Claude sidecar and per-session directories. */
async function seed(h: Awaited<ReturnType<typeof makeHarness>>, id: string, extra: Record<string, unknown> = {}) {
  await h.registry.registerSession(registerOpts(id, { backendSessionId: `be-${id}`, ...extra }));
  await h.registry.bindChannel(`web:${id}`, id);
  await h.history.appendUser(id, { text: 'hello' });
  await fs.writeFile(path.join(h.dirs.claude, `be-${id}.jsonl`), '{}\n');
  await fs.mkdir(path.join(h.dirs.claude, `be-${id}`, 'tool-results'), { recursive: true });
  await fs.writeFile(path.join(h.dirs.claude, `be-${id}`, 'tool-results', 'r.txt'), 'x');
  for (const root of [h.dirs.outputs, h.dirs.attachments]) {
    await fs.mkdir(path.join(root, id), { recursive: true });
    await fs.writeFile(path.join(root, id, 'f.txt'), 'x');
  }
}

function sessionFiles(h: Awaited<ReturnType<typeof makeHarness>>, id: string): string[] {
  return [
    path.join(h.dirs.history, `${id}.jsonl`),
    path.join(h.dirs.claude, `be-${id}.jsonl`),
    path.join(h.dirs.claude, `be-${id}`),
    path.join(h.dirs.outputs, id),
    path.join(h.dirs.attachments, id),
  ];
}

test('deleting a lead removes it, its workers and their files; other sessions keep theirs', async () => {
  const h = await makeHarness();
  await seed(h, 'lead', { starred: true });
  await seed(h, 'worker', { teamLeadId: 'lead', workerName: 'w' });
  await seed(h, 'other');
  await h.registry.setStarred('lead', true);

  const result = await deleteSessions(h.deps, ['lead']);
  assert.deepEqual(result.ok && result.deletedIds.sort(), ['lead', 'worker']);
  assert.deepEqual((await h.registry.listRecentSessions(10)).map(s => s.sessionId), ['other']);
  assert.deepEqual(await h.registry.listPendingDeletions(), []);
  assert.equal(await h.registry.getBoundSessionId('web:lead'), null);
  for (const id of ['lead', 'worker']) {
    for (const file of sessionFiles(h, id)) assert.equal(await exists(file), false, file);
  }
  for (const file of sessionFiles(h, 'other')) assert.equal(await exists(file), true, file);
  assert.deepEqual(h.forgotten.sort(), ['lead', 'worker']);
  assert.deepEqual(h.settled.sort(), ['lead', 'worker']);
});

test('a busy session, or a busy worker of a lead, refuses the whole delete', async () => {
  const h = await makeHarness(['worker']);
  await seed(h, 'lead');
  await seed(h, 'worker', { teamLeadId: 'lead', workerName: 'w' });

  assert.deepEqual(await deleteSessions(h.deps, ['lead']), { ok: false, reason: 'busy', busyIds: ['worker'] });
  assert.equal((await h.registry.listRecentSessions(10)).length, 2);
  for (const file of sessionFiles(h, 'lead')) assert.equal(await exists(file), true, file);
  assert.deepEqual(h.settled, []);
});

test('an unknown session is not-found', async () => {
  const h = await makeHarness();
  assert.deepEqual(await deleteSessions(h.deps, ['nope']), { ok: false, reason: 'not-found' });
});

test('a failed cleanup leaves the session pending for the next sweep, out of every list', async () => {
  const h = await makeHarness();
  await seed(h, 'a');
  const deps: SessionDeleteDeps = {
    ...h.deps,
    historyRepo: { clearBySessionIds: async () => { throw new Error('disk'); } },
  };
  assert.deepEqual(await deleteSessions(deps, ['a']), { ok: true, deletedIds: ['a'] });
  assert.deepEqual(await h.registry.listRecentSessions(10), []);
  assert.deepEqual((await h.registry.listPendingDeletions()).map(entry => entry.session.sessionId), ['a']);
});
