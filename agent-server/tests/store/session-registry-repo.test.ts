import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRegistryRepo, type Session } from '../../src/store/session-registry-repo.js';
import { appendSessionRegistryEvents, loadSessionRegistryState } from '../../src/store/session-registry-journal.js';

let tmpDir = '';
let testId = 0;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-session-registry-jsonl-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function nextPaths() {
  const id = testId++;
  return { filePath: path.join(tmpDir, `session-registry-${id}.jsonl`) };
}

function baseSession(id: string): Session {
  return {
    sessionId: id,
    projectId: 'proj',
    channel: 'C001',
    backend: 'claude',
    kind: 'local',
    origin: 'direct',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastUsedAt: '2025-01-01T00:00:00.000Z',
    label: 'label',
    profileName: null,
    backendSessionId: null,
    scheduleId: null,
  };
}

function registerOpts(id: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: id,
    channel: 'C001',
    backend: 'claude',
    kind: 'local' as const,
    projectId: 'proj',
    label: 'label',
    ...extra,
  };
}

function jsonlLines(filePath: string) {
  const text = fssync.readFileSync(filePath, 'utf8');
  return text.trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function lineText(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

async function fileText(filePath: string) {
  return fs.readFile(filePath, 'utf8');
}

test('session registry appends one JSONL event per mutation and keeps prior prefix bytes', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-a'));
  const prefix = await fileText(filePath);

  await Promise.all([
    repo.registerSession(registerOpts('sess-b')),
    repo.updateSession('sess-a', { label: 'updated label' }),
  ]);

  const text = await fileText(filePath);
  assert.ok(text.startsWith(prefix));
  const lines = jsonlLines(filePath);
  assert.equal(lines.length, 3);
  // B.T1: updateSession now emits a delta `patch`, not a whole-record `put`.
  assert.deepEqual(lines.map(line => line.op), ['put', 'put', 'patch']);
  assert.equal((await repo.getById('sess-a'))?.label, 'updated label');
});

test('session registry replays concurrent appends after restart without rewriting the journal', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  const ids = Array.from({ length: 10 }, (_, i) => `sess-${i}`);

  await Promise.all(ids.map(id => repo.registerSession(registerOpts(id))));
  await Promise.all(ids.slice(0, 5).map((id, i) => repo.updateSession(id, { label: `l-${i}` })));

  const reopened = new SessionRegistryRepo(filePath);
  const sessions = await reopened.listRecentSessions(20);
  assert.equal(sessions.length, 10);
  assert.deepEqual(new Set(sessions.map(session => session.sessionId)), new Set(ids));
  assert.equal((await reopened.getById('sess-0'))?.label, 'l-0');
  assert.equal(jsonlLines(filePath).length, 15);
});

test('session registry hides delete-intent sessions from normal queries and replays commit', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-live'));
  await repo.registerSession(registerOpts('sess-stale'));
  await repo.updateSession('sess-stale', { lastUsedAt: '2020-01-01T00:00:00.000Z' });

  const pending = await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), [], async () => ({
    claudeBackupPaths: ['/safe/sess-stale.jsonl.turn-1.bak'],
  }));
  assert.deepEqual(pending.map(entry => entry.session.sessionId), ['sess-stale']);
  assert.deepEqual(pending[0].cleanup.claudeBackupPaths, ['/safe/sess-stale.jsonl.turn-1.bak']);
  assert.equal(await repo.getById('sess-stale'), null);
  assert.equal(await repo.getById('sess-stale'), null);
  assert.deepEqual((await repo.listPendingDeletions()).map(entry => entry.session.sessionId), ['sess-stale']);

  assert.equal(await repo.commitDeletion('sess-stale'), true);
  assert.deepEqual(await repo.listPendingDeletions(), []);

  const reopened = new SessionRegistryRepo(filePath);
  assert.equal(await reopened.getById('sess-stale'), null);
  assert.equal((await reopened.getById('sess-live'))?.sessionId, 'sess-live');
  // B.T1: the stale-session lastUsedAt bump is now a `patch`, not a `put`.
  assert.deepEqual(jsonlLines(filePath).map(line => line.op), ['put', 'put', 'patch', 'delete-intent', 'delete-commit']);
});

test('session registry touchSessionUse bumps lastUsedAt and beginDeleteExpired share one admission mutex', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-touch'));
  await repo.updateSession('sess-touch', { lastUsedAt: '2020-01-01T00:00:00.000Z' });

  assert.equal(await repo.touchSessionUse('sess-touch'), true);
  assert.deepEqual(await repo.beginDeleteExpired(Date.now() - 1_000, []), []);

  await repo.updateSession('sess-touch', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  assert.deepEqual((await repo.beginDeleteExpired(new Date(), [])).map(entry => entry.session.sessionId), ['sess-touch']);
  assert.equal(await repo.touchSessionUse('sess-touch'), false);
  assert.equal(await repo.commitDeletion('sess-touch'), true);
});

test('session registry pending delete-intent sessions cannot be revived by put-like updates or touch', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-pending'));
  await repo.updateSession('sess-pending', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);

  await repo.updateSession('sess-pending', { label: 'revive-attempt', lastUsedAt: '2030-01-01T00:00:00.000Z' });
  await assert.rejects(() => repo.registerSession(registerOpts('sess-pending')), /pending-deletion/i);
  assert.equal(await repo.touchSessionUse('sess-pending'), false);
  assert.equal(await repo.getById('sess-pending'), null);
  assert.deepEqual((await repo.listPendingDeletions()).map(entry => entry.session.sessionId), ['sess-pending']);

  const reopened = new SessionRegistryRepo(filePath);
  assert.equal(await reopened.getById('sess-pending'), null);
  assert.deepEqual((await reopened.listPendingDeletions()).map(entry => entry.session.sessionId), ['sess-pending']);
});

test('legacy delete intents replay with an empty cleanup manifest', async () => {
  const { filePath } = nextPaths();
  const record = { ...baseSession('sess-legacy-intent'), name: 'cortex-legacy-intent' }; // legacy fixture
  await fs.writeFile(filePath, [
    JSON.stringify({ v: 1, op: 'put', id: record.sessionId, record }),
    JSON.stringify({ v: 1, op: 'delete-intent', id: record.sessionId, record }),
    '',
  ].join('\n'));

  const repo = new SessionRegistryRepo(filePath);
  const pending = await repo.listPendingDeletions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].session.sessionId, record.sessionId);
  assert.equal(Object.hasOwn(pending[0].session, 'name'), false);
  assert.deepEqual(pending[0].cleanup, { claudeBackupPaths: [] });
});

test('session registry rolls back a partial append before later writes continue', async () => {
  const { filePath } = nextPaths();
  let fail = false;
  const repo = new SessionRegistryRepo(filePath, {
    writeAppend: async (handle, line) => {
      if (!fail) return handle.writeFile(line, 'utf8');
      await handle.write(line.slice(0, Math.max(1, Math.floor(line.length / 2))), 0, 'utf8');
      throw new Error('forced partial append');
    },
  });

  await repo.registerSession(registerOpts('sess-a'));
  const before = await fileText(filePath);
  fail = true;
  await assert.rejects(repo.registerSession(registerOpts('sess-b')), /forced partial append/);
  assert.equal(await fileText(filePath), before);

  fail = false;
  await repo.registerSession(registerOpts('sess-b'));
  const reopened = new SessionRegistryRepo(filePath);
  assert.equal((await reopened.getById('sess-a'))?.sessionId, 'sess-a');
  assert.equal((await reopened.getById('sess-b'))?.sessionId, 'sess-b');
});

test('session registry truncates an unterminated tail line during replay', async () => {
  const { filePath } = nextPaths();
  const first = lineText({ v: 1, op: 'put', id: 'sess-a', record: baseSession('sess-a') });
  const tail = JSON.stringify({ v: 1, op: 'put', id: 'sess-b', record: baseSession('sess-b') }).slice(0, 20);
  await fs.writeFile(filePath, `${first}${tail}`);

  const repo = new SessionRegistryRepo(filePath);
  const sessions = await repo.listRecentSessions(10);
  assert.deepEqual(sessions.map(session => session.sessionId), ['sess-a']);
  assert.equal(await fileText(filePath), first);
});

test('session registry fails closed on a malformed newline-terminated record', async () => {
  const { filePath } = nextPaths();
  const first = lineText({ v: 1, op: 'put', id: 'sess-a', record: baseSession('sess-a') });
  await fs.writeFile(filePath, `${first}{bad json}\n`);

  const repo = new SessionRegistryRepo(filePath);
  await assert.rejects(repo.listRecentSessions(10), /malformed/i);
  await assert.rejects(repo.registerSession(registerOpts('sess-b')), /malformed/i);
  assert.equal(await fileText(filePath), `${first}{bad json}\n`);
});

test('session registry preserves invalid lastUsedAt values instead of normalizing them away', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-invalid'));
  await repo.updateSession('sess-invalid', { lastUsedAt: 'not-a-date' });

  const reopened = new SessionRegistryRepo(filePath);
  assert.equal((await reopened.getById('sess-invalid'))?.lastUsedAt, 'not-a-date');
});

test('legacy duplicate names do not block distinct session ids during replay', async () => {
  const { filePath } = nextPaths();
  await fs.writeFile(filePath, [
    lineText({ v: 1, op: 'put', id: 'sess-a', record: { ...baseSession('sess-a'), name: 'cortex-dup' } }),
    lineText({ v: 1, op: 'put', id: 'sess-b', record: { ...baseSession('sess-b'), name: 'cortex-dup' } }),
  ].join(''));

  const repo = new SessionRegistryRepo(filePath);
  assert.deepEqual(new Set((await repo.listRecentSessions(10)).map(s => s.sessionId)), new Set(['sess-a', 'sess-b']));
});

test('session registry flush waits for an in-flight synced append', async () => {
  const { filePath } = nextPaths();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const repo = new SessionRegistryRepo(filePath, {
    writeAppend: async (handle, line) => {
      await gate;
      await handle.writeFile(line, 'utf8');
    },
  });

  const pending = repo.registerSession(registerOpts('sess-a'));
  let flushed = false;
  const flush = repo.flush().then(() => { flushed = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(flushed, false);

  release();
  await Promise.all([pending, flush]);
  assert.equal(flushed, true);
});

test('session registry compacts to live puts plus pending delete-intents and survives concurrent writes', async () => {
  const { filePath } = nextPaths();
  let compactCount = 0;
  const repo = new SessionRegistryRepo(filePath, {
    shouldCompact: ({ eventCount }) => eventCount > 4,
    onCompact: () => { compactCount += 1; },
  });

  await Promise.all([
    repo.registerSession(registerOpts('sess-a')),
    repo.registerSession(registerOpts('sess-b')),
    repo.registerSession(registerOpts('sess-c')),
  ]);
  await repo.updateSession('sess-a', { label: 'A1' });
  await repo.updateSession('sess-a', { label: 'A2' });
  await repo.updateSession('sess-b', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);
  await repo.compactNow();

  assert.ok(compactCount >= 1);
  const lines = jsonlLines(filePath);
  assert.deepEqual(lines.map(line => `${line.op}:${line.id}`).sort(), [
    'delete-intent:sess-b',
    'put:sess-a',
    'put:sess-c',
  ]);

  const reopened = new SessionRegistryRepo(filePath);
  assert.equal((await reopened.getById('sess-a'))?.label, 'A2');
  assert.equal(await reopened.getById('sess-b'), null);
  assert.deepEqual((await reopened.listPendingDeletions()).map(entry => entry.session.sessionId), ['sess-b']);
});

test('registerSession defaults origin from kind, not from a bracketed label', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-bracket', { label: '[fix:login]' }));
  await repo.registerSession(registerOpts('sess-sched', { kind: 'scheduled', label: '[a:b]' }));

  assert.equal((await repo.getById('sess-bracket'))?.origin, 'direct');
  assert.equal((await repo.getById('sess-sched'))?.origin, 'scheduled');
  assert.deepEqual((await repo.listByOrigin('direct')).map(s => s.sessionId), ['sess-bracket']);
});

test('session registry preserves explicit origin and markRead after invalidate', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-origin', {
    origin: 'thread',
    label: '[thr_1:coder]',
    scheduleId: 'sched-1',
  }));

  await repo.markRead('sess-origin');
  repo.invalidate();
  const record = await repo.getById('sess-origin');
  assert.equal(record?.origin, 'thread');
  assert.equal(record?.scheduleId, 'sched-1');
  assert.ok(record?.lastReadAt);
});

test('session registry replays a board binding set at registration and rebinding', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-board', { boardId: 'b-1' }));
  assert.equal((await new SessionRegistryRepo(filePath).getById('sess-board'))?.boardId, 'b-1');

  await repo.bindBoard('sess-board', 'b-2');
  assert.equal((await new SessionRegistryRepo(filePath).getById('sess-board'))?.boardId, 'b-2');
});

test('session registry replays worker fields and lists a lead\'s workers', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-lead'));
  await repo.registerSession(registerOpts('sess-w1', {
    teamLeadId: 'sess-lead', workerName: 'scout', workerBrief: 'Map the grasp dataset',
  }));
  await repo.registerSession(registerOpts('sess-w2', { teamLeadId: 'sess-lead', workerName: 'builder' }));
  await repo.registerSession(registerOpts('sess-other', { teamLeadId: 'sess-elsewhere', workerName: 'scout' }));

  // Ordinary sessions carry no worker fields at all.
  const lead = await repo.getById('sess-lead');
  assert.equal(lead?.teamLeadId ?? null, null);
  assert.equal(lead?.workerName ?? null, null);
  assert.equal(lead?.workerBrief ?? null, null);

  const reopened = new SessionRegistryRepo(filePath);
  const w1 = await reopened.getById('sess-w1');
  assert.equal(w1?.teamLeadId, 'sess-lead');
  assert.equal(w1?.workerName, 'scout');
  assert.equal(w1?.workerBrief, 'Map the grasp dataset');
  assert.equal((await reopened.getById('sess-w2'))?.workerName, 'builder');
  assert.deepEqual((await reopened.listWorkers('sess-lead')).map(s => s.sessionId).sort(), ['sess-w1', 'sess-w2']);
  assert.deepEqual(await reopened.listWorkers('sess-w1'), []);
});

test('retention keeps a stale worker while its lead lives and deletes fresh workers with their lead', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  const stale = '2020-01-01T00:00:00.000Z';
  await repo.registerSession(registerOpts('sess-lead'));
  await repo.registerSession({ ...registerOpts('sess-w1'), teamLeadId: 'sess-lead', workerName: 'w1' });
  await repo.registerSession(registerOpts('sess-lead2'));
  await repo.registerSession({ ...registerOpts('sess-w2'), teamLeadId: 'sess-lead2', workerName: 'w2' });
  await repo.registerSession({ ...registerOpts('sess-orphan'), teamLeadId: 'sess-gone', workerName: 'o' });
  await repo.updateSession('sess-w1', { lastUsedAt: stale });
  await repo.updateSession('sess-lead2', { lastUsedAt: stale });
  await repo.updateSession('sess-orphan', { lastUsedAt: stale });

  const pending = await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);
  assert.deepEqual(
    pending.map(entry => entry.session.sessionId).sort(),
    ['sess-lead2', 'sess-orphan', 'sess-w2'],
    'w1 waits for its live lead; w2 (fresh) goes with its expired lead; an orphan ages out normally',
  );
  assert.equal((await repo.getById('sess-w1'))?.workerName, 'w1');

  const protectedLead = new SessionRegistryRepo(nextPaths().filePath);
  await protectedLead.registerSession(registerOpts('l'));
  await protectedLead.registerSession({ ...registerOpts('w'), teamLeadId: 'l', workerName: 'w' });
  await protectedLead.updateSession('l', { lastUsedAt: stale });
  await protectedLead.updateSession('w', { lastUsedAt: stale });
  assert.deepEqual(await protectedLead.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), ['l']), [],
    'an in-use lead keeps its workers');
});

test('retention keeps starred and board sessions however old; an unstarred worker follows its lead', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  const stale = '2020-01-01T00:00:00.000Z';
  await repo.registerSession(registerOpts('sess-starred'));
  await repo.setStarred('sess-starred', true);
  await repo.registerSession(registerOpts('sess-board', { boardId: 'b-1' }));
  await repo.registerSession(registerOpts('sess-plain'));
  // A kept lead keeps its workers.
  await repo.registerSession(registerOpts('sess-lead'));
  await repo.setStarred('sess-lead', true);
  await repo.registerSession({ ...registerOpts('sess-worker'), teamLeadId: 'sess-lead', workerName: 'w' });
  // An expired lead takes its unstarred worker with it; a starred worker stays.
  await repo.registerSession(registerOpts('sess-lead2'));
  await repo.registerSession({ ...registerOpts('sess-worker2'), teamLeadId: 'sess-lead2', workerName: 'w2' });
  await repo.registerSession({ ...registerOpts('sess-worker3'), teamLeadId: 'sess-lead2', workerName: 'w3' });
  await repo.setStarred('sess-worker3', true);
  const ids = [
    'sess-starred', 'sess-board', 'sess-plain', 'sess-lead', 'sess-worker',
    'sess-lead2', 'sess-worker2', 'sess-worker3',
  ];
  for (const id of ids) await repo.updateSession(id, { lastUsedAt: stale });

  const pending = await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);
  assert.deepEqual(
    pending.map(entry => entry.session.sessionId).sort(),
    ['sess-lead2', 'sess-plain', 'sess-worker2'],
  );

  // Once its lead is gone, the starred worker is still kept by its own star.
  await repo.commitDeletions(pending.map(entry => entry.session.sessionId));
  assert.deepEqual(await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []), []);
});

/** A registry whose appends and compactions are counted; `compactAlways` forces a compaction
 *  check to pass after every append. */
function countingRepo(filePath: string, opts: { compactAlways?: boolean } = {}) {
  const counts = { appends: 0, compactions: 0 };
  const repo = new SessionRegistryRepo(filePath, {
    writeAppend: async (handle, text) => {
      counts.appends += 1;
      await handle.writeFile(text, 'utf8');
    },
    ...(opts.compactAlways ? { shouldCompact: () => true } : {}),
    onCompact: () => { counts.compactions += 1; },
  });
  return { repo, counts };
}

async function seedExpired(filePath: string, count: number, turnsPerSession = 0): Promise<string[]> {
  const lines: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `sess-${i}`;
    const channel = `web:${id}`;
    ids.push(id);
    lines.push(lineText({ v: 1, op: 'put', id, record: { ...baseSession(id), channel, lastUsedAt: '2020-01-01T00:00:00.000Z' } }));
    lines.push(lineText({ v: 1, op: 'bind', channel, sessionId: id }));
    lines.push(lineText({ v: 1, op: 'conversation', channel, kind: 'set', fields: { sessionId: id, backend: 'claude', profileName: null, updatedAt: '2020-01-01T00:00:00.000Z' } }));
    for (let t = 0; t < turnsPerSession; t += 1) {
      lines.push(lineText({ v: 1, op: 'turn', channel, kind: 'begin', turn: {
        turnIndex: t, userMessageTs: `M${t}`, userMessageText: 'hi', statusMessageTs: null, responseMessageTimestamps: [],
        executionId: null, backupPath: null, status: 'completed', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
      } }));
    }
  }
  await fs.writeFile(filePath, lines.join(''));
  return ids;
}

test('beginDeleteExpired, the channel release and commitDeletions each land as one append and one compaction check', async () => {
  const { filePath } = nextPaths();
  const ids = await seedExpired(filePath, 50, 2);
  const { repo, counts } = countingRepo(filePath, { compactAlways: true });

  const pending = await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);
  assert.equal(pending.length, 50);
  assert.deepEqual(counts, { appends: 1, compactions: 1 });

  assert.equal(await repo.releaseChannels(ids), 50);
  assert.deepEqual(counts, { appends: 2, compactions: 2 }, 'bindings, headers and turns in one append');
  assert.equal(await repo.getBoundSessionId('web:sess-0'), null);
  assert.deepEqual(await repo.getTurns('web:sess-0'), []);
  assert.equal(await repo.getConversationHeader('web:sess-0'), null);

  const committed = await repo.commitDeletions([...ids, 'not-pending', ids[0]]);
  assert.deepEqual(committed, ids);
  assert.deepEqual(counts, { appends: 3, compactions: 3 });
  assert.deepEqual(await repo.listPendingDeletions(), []);
  assert.deepEqual(await repo.commitDeletions(ids), [], 'a second commit is a no-op');
  assert.equal(counts.appends, 3, 'and appends nothing');

  const reopened = new SessionRegistryRepo(filePath);
  assert.deepEqual(await reopened.listRecentSessions(100), []);
  assert.deepEqual(await reopened.listPendingDeletions(), []);
});

test('a torn batch of delete commits replays its whole lines and leaves the rest pending', async () => {
  const { filePath } = nextPaths();
  const ids = await seedExpired(filePath, 5);
  const repo = new SessionRegistryRepo(filePath, { shouldCompact: () => false });
  await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);

  // A crash in the middle of one batched write: two whole commit lines, then a torn third.
  const torn = [0, 1, 2].map(i => lineText({ v: 1, op: 'delete-commit', id: ids[i] })).join('');
  await fs.appendFile(filePath, torn.slice(0, torn.length - 10));

  const reopened = new SessionRegistryRepo(filePath);
  assert.deepEqual(
    (await reopened.listPendingDeletions()).map(entry => entry.session.sessionId).sort(),
    ids.slice(2).sort(),
  );
  assert.deepEqual((await reopened.commitDeletions(ids)).sort(), ids.slice(2).sort());
  assert.deepEqual(await new SessionRegistryRepo(filePath).listPendingDeletions(), []);
});

test('session registry does not compact on every append once its compacted state exceeds the base threshold', async () => {
  const { filePath } = nextPaths();
  // 20 live sessions with 40 turns each: the compacted journal has ~860 events, well above both
  // 512 and four events per live session.
  await seedExpired(filePath, 20, 40);
  const { repo, counts } = countingRepo(filePath);
  await repo.compactNow();
  counts.compactions = 0;

  for (let i = 0; i < 100; i += 1) await repo.markRead(`sess-${i % 20}`);
  assert.equal(counts.appends, 100);
  assert.equal(counts.compactions, 0);
});

test('a batch append rejects the same session twice before writing anything', async () => {
  const { filePath } = nextPaths();
  await seedExpired(filePath, 1);
  const state = await loadSessionRegistryState(filePath);
  const before = await fileText(filePath);
  await assert.rejects(appendSessionRegistryEvents(filePath, state, [
    { v: 1, op: 'patch', id: 'sess-0', fields: { label: 'a' } },
    { v: 1, op: 'patch', id: 'sess-0', fields: { label: 'b' } },
  ]), /twice/);
  assert.equal(await fileText(filePath), before);
});
