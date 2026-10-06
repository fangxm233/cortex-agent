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

function baseSession(id: string, name = `cortex-${id}`): Session {
  return {
    name,
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
  await repo.registerSession('cortex-a', registerOpts('sess-a'));
  const prefix = await fileText(filePath);

  await Promise.all([
    repo.registerSession('cortex-b', registerOpts('sess-b')),
    repo.updateSession('cortex-a', { label: 'updated label' }),
  ]);

  const text = await fileText(filePath);
  assert.ok(text.startsWith(prefix));
  const lines = jsonlLines(filePath);
  assert.equal(lines.length, 3);
  // B.T1: updateSession now emits a delta `patch`, not a whole-record `put`.
  assert.deepEqual(lines.map(line => line.op), ['put', 'put', 'patch']);
  assert.equal((await repo.lookupSession('cortex-a'))?.label, 'updated label');
});

test('session registry replays concurrent appends after restart without rewriting the journal', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  const names = Array.from({ length: 10 }, (_, i) => `cortex-${i}`);

  await Promise.all(names.map((name, i) => repo.registerSession(name, registerOpts(`sess-${i}`))));
  await Promise.all(names.slice(0, 5).map((name, i) => repo.updateSession(name, { label: `l-${i}` })));

  const reopened = new SessionRegistryRepo(filePath);
  const sessions = await reopened.listRecentSessions(20);
  assert.equal(sessions.length, 10);
  assert.deepEqual(new Set(sessions.map(session => session.name)), new Set(names));
  assert.equal((await reopened.lookupSession('cortex-0'))?.label, 'l-0');
  assert.equal(jsonlLines(filePath).length, 15);
});

test('session registry hides delete-intent sessions from normal queries and replays commit', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-live', registerOpts('sess-live'));
  await repo.registerSession('cortex-stale', registerOpts('sess-stale'));
  await repo.updateSession('cortex-stale', { lastUsedAt: '2020-01-01T00:00:00.000Z' });

  const pending = await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), [], async () => ({
    claudeBackupPaths: ['/safe/sess-stale.jsonl.turn-1.bak'],
  }));
  assert.deepEqual(pending.map(entry => entry.session.sessionId), ['sess-stale']);
  assert.deepEqual(pending[0].cleanup.claudeBackupPaths, ['/safe/sess-stale.jsonl.turn-1.bak']);
  assert.equal(await repo.lookupSession('cortex-stale'), null);
  assert.equal(await repo.getById('sess-stale'), null);
  assert.deepEqual((await repo.listPendingDeletions()).map(entry => entry.session.sessionId), ['sess-stale']);

  assert.equal(await repo.commitDeletion('sess-stale'), true);
  assert.deepEqual(await repo.listPendingDeletions(), []);

  const reopened = new SessionRegistryRepo(filePath);
  assert.equal(await reopened.getById('sess-stale'), null);
  assert.equal((await reopened.lookupSession('cortex-live'))?.sessionId, 'sess-live');
  // B.T1: the stale-session lastUsedAt bump is now a `patch`, not a `put`.
  assert.deepEqual(jsonlLines(filePath).map(line => line.op), ['put', 'put', 'patch', 'delete-intent', 'delete-commit']);
});

test('session registry touchSessionUse bumps lastUsedAt and beginDeleteExpired share one admission mutex', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-touch', registerOpts('sess-touch'));
  await repo.updateSession('cortex-touch', { lastUsedAt: '2020-01-01T00:00:00.000Z' });

  assert.equal(await repo.touchSessionUse('sess-touch'), true);
  assert.deepEqual(await repo.beginDeleteExpired(Date.now() - 1_000, []), []);

  await repo.updateSession('cortex-touch', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  assert.deepEqual((await repo.beginDeleteExpired(new Date(), [])).map(entry => entry.session.sessionId), ['sess-touch']);
  assert.equal(await repo.touchSessionUse('sess-touch'), false);
  assert.equal(await repo.commitDeletion('sess-touch'), true);
});

test('session registry pending delete-intent sessions cannot be revived by put-like updates or touch', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-pending', registerOpts('sess-pending'));
  await repo.updateSession('cortex-pending', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);

  await repo.updateSession('cortex-pending', { label: 'revive-attempt', lastUsedAt: '2030-01-01T00:00:00.000Z' });
  await assert.rejects(() => repo.registerSession('cortex-pending-new', registerOpts('sess-pending')), /pending-deletion/i);
  assert.equal(await repo.touchSessionUse('sess-pending'), false);
  assert.equal(await repo.getById('sess-pending'), null);
  assert.deepEqual((await repo.listPendingDeletions()).map(entry => entry.session.sessionId), ['sess-pending']);

  const reopened = new SessionRegistryRepo(filePath);
  assert.equal(await reopened.getById('sess-pending'), null);
  assert.deepEqual((await reopened.listPendingDeletions()).map(entry => entry.session.sessionId), ['sess-pending']);
});

test('legacy delete intents replay with an empty cleanup manifest', async () => {
  const { filePath } = nextPaths();
  const record = baseSession('sess-legacy-intent', 'cortex-legacy-intent');
  await fs.writeFile(filePath, [
    JSON.stringify({ v: 1, op: 'put', id: record.sessionId, record }),
    JSON.stringify({ v: 1, op: 'delete-intent', id: record.sessionId, record }),
    '',
  ].join('\n'));

  const repo = new SessionRegistryRepo(filePath);
  const pending = await repo.listPendingDeletions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].session.sessionId, record.sessionId);
  assert.equal(pending[0].session.name, record.name);
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

  await repo.registerSession('cortex-a', registerOpts('sess-a'));
  const before = await fileText(filePath);
  fail = true;
  await assert.rejects(repo.registerSession('cortex-b', registerOpts('sess-b')), /forced partial append/);
  assert.equal(await fileText(filePath), before);

  fail = false;
  await repo.registerSession('cortex-b', registerOpts('sess-b'));
  const reopened = new SessionRegistryRepo(filePath);
  assert.equal((await reopened.lookupSession('cortex-a'))?.sessionId, 'sess-a');
  assert.equal((await reopened.lookupSession('cortex-b'))?.sessionId, 'sess-b');
});

test('session registry truncates an unterminated tail line during replay', async () => {
  const { filePath } = nextPaths();
  const first = lineText({ v: 1, op: 'put', id: 'sess-a', record: baseSession('sess-a', 'cortex-a') });
  const tail = JSON.stringify({ v: 1, op: 'put', id: 'sess-b', record: baseSession('sess-b', 'cortex-b') }).slice(0, 20);
  await fs.writeFile(filePath, `${first}${tail}`);

  const repo = new SessionRegistryRepo(filePath);
  const sessions = await repo.listRecentSessions(10);
  assert.deepEqual(sessions.map(session => session.sessionId), ['sess-a']);
  assert.equal(await fileText(filePath), first);
});

test('session registry fails closed on a malformed newline-terminated record', async () => {
  const { filePath } = nextPaths();
  const first = lineText({ v: 1, op: 'put', id: 'sess-a', record: baseSession('sess-a', 'cortex-a') });
  await fs.writeFile(filePath, `${first}{bad json}\n`);

  const repo = new SessionRegistryRepo(filePath);
  await assert.rejects(repo.listRecentSessions(10), /malformed/i);
  await assert.rejects(repo.registerSession('cortex-b', registerOpts('sess-b')), /malformed/i);
  assert.equal(await fileText(filePath), `${first}{bad json}\n`);
});

test('session registry preserves invalid lastUsedAt values instead of normalizing them away', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-invalid', registerOpts('sess-invalid'));
  await repo.updateSession('cortex-invalid', { lastUsedAt: 'not-a-date' });

  const reopened = new SessionRegistryRepo(filePath);
  assert.equal((await reopened.getById('sess-invalid'))?.lastUsedAt, 'not-a-date');
});

test('session registry fails closed on duplicate live names during replay', async () => {
  const { filePath } = nextPaths();
  await fs.writeFile(filePath, [
    lineText({ v: 1, op: 'put', id: 'sess-a', record: baseSession('sess-a', 'cortex-dup') }),
    lineText({ v: 1, op: 'put', id: 'sess-b', record: baseSession('sess-b', 'cortex-dup') }),
  ].join(''));

  const repo = new SessionRegistryRepo(filePath);
  await assert.rejects(repo.listRecentSessions(10), /duplicate live session name/i);
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

  const pending = repo.registerSession('cortex-a', registerOpts('sess-a'));
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
    repo.registerSession('cortex-a', registerOpts('sess-a')),
    repo.registerSession('cortex-b', registerOpts('sess-b')),
    repo.registerSession('cortex-c', registerOpts('sess-c')),
  ]);
  await repo.updateSession('cortex-a', { label: 'A1' });
  await repo.updateSession('cortex-a', { label: 'A2' });
  await repo.updateSession('cortex-b', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
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
  assert.equal((await reopened.lookupSession('cortex-a'))?.label, 'A2');
  assert.equal(await reopened.lookupSession('cortex-b'), null);
  assert.deepEqual((await reopened.listPendingDeletions()).map(entry => entry.session.sessionId), ['sess-b']);
});

test('registerSession defaults origin from kind, not from a bracketed label', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-bracket', registerOpts('sess-bracket', { label: '[fix:login]' }));
  await repo.registerSession('cortex-sched', registerOpts('sess-sched', { kind: 'scheduled', label: '[a:b]' }));

  assert.equal((await repo.lookupSession('cortex-bracket'))?.origin, 'direct');
  assert.equal((await repo.lookupSession('cortex-sched'))?.origin, 'scheduled');
  assert.deepEqual((await repo.listByOrigin('direct')).map(s => s.sessionId), ['sess-bracket']);
});

test('session registry preserves explicit origin, markRead, and name index after invalidate', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-origin', registerOpts('sess-origin', {
    origin: 'thread',
    label: '[thr_1:coder]',
    scheduleId: 'sched-1',
  }));

  await repo.markRead('sess-origin');
  repo.invalidate();
  const record = await repo.lookupSession('cortex-origin');
  assert.equal(record?.origin, 'thread');
  assert.equal(record?.scheduleId, 'sched-1');
  assert.ok(record?.lastReadAt);
});

test('session registry replays commissionDraft and clears it when the commission lands', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-draft', registerOpts('sess-draft', { commissionDraft: '_draft-cortex-draft' }));

  // Survives a cold replay — the field must be whitelisted in the journal record assert or every
  // restart silently drops commission mode (the bug the browser opt-in originally had).
  const reopened = new SessionRegistryRepo(filePath);
  const replayed = await reopened.getById('sess-draft');
  assert.equal(replayed?.commissionDraft, '_draft-cortex-draft');
  assert.equal(replayed?.commissionId ?? null, null);

  // Landing the contract binds the id and retires the draft name.
  await reopened.bindCommission('sess-draft', 'comm-9');
  const landed = await reopened.getById('sess-draft');
  assert.equal(landed?.commissionId, 'comm-9');
  assert.equal(landed?.commissionDraft, null);

  const again = new SessionRegistryRepo(filePath);
  const afterRestart = await again.getById('sess-draft');
  assert.equal(afterRestart?.commissionId, 'comm-9');
  assert.equal(afterRestart?.commissionDraft, null);
});

test('session registry replays worker fields, retirement, and lists a lead\'s workers', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-lead', registerOpts('sess-lead'));
  await repo.registerSession('cortex-w1', registerOpts('sess-w1', {
    teamLeadId: 'sess-lead', workerName: 'scout', workerBrief: 'Map the grasp dataset',
  }));
  await repo.registerSession('cortex-w2', registerOpts('sess-w2', { teamLeadId: 'sess-lead', workerName: 'builder' }));
  await repo.registerSession('cortex-other', registerOpts('sess-other', { teamLeadId: 'sess-elsewhere', workerName: 'scout' }));

  // Ordinary sessions carry no worker fields at all.
  const lead = await repo.getById('sess-lead');
  assert.equal(lead?.teamLeadId ?? null, null);
  assert.equal(lead?.workerName ?? null, null);
  assert.equal(lead?.workerBrief ?? null, null);

  await repo.setWorkerRetired('sess-w2', 1738454400000);

  const reopened = new SessionRegistryRepo(filePath);
  const w1 = await reopened.getById('sess-w1');
  assert.equal(w1?.teamLeadId, 'sess-lead');
  assert.equal(w1?.workerName, 'scout');
  assert.equal(w1?.workerBrief, 'Map the grasp dataset');
  assert.equal(w1?.workerRetiredAt, null);
  assert.equal((await reopened.getById('sess-w2'))?.workerRetiredAt, 1738454400000);
  assert.deepEqual((await reopened.listWorkers('sess-lead')).map(s => s.sessionId).sort(), ['sess-w1', 'sess-w2']);
  assert.deepEqual(await reopened.listWorkers('sess-w1'), []);

  // Reactivating clears the retirement and survives another restart.
  await reopened.setWorkerRetired('sess-w2', null);
  const again = new SessionRegistryRepo(filePath);
  assert.equal((await again.getById('sess-w2'))?.workerRetiredAt, null);
  assert.equal((await again.getById('sess-w2'))?.workerName, 'builder');
});

test('retention keeps a stale worker while its lead lives and deletes fresh workers with their lead', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  const stale = '2020-01-01T00:00:00.000Z';
  await repo.registerSession('cortex-lead', registerOpts('sess-lead'));
  await repo.registerSession('cortex-w1', { ...registerOpts('sess-w1'), teamLeadId: 'sess-lead', workerName: 'w1' });
  await repo.registerSession('cortex-lead2', registerOpts('sess-lead2'));
  await repo.registerSession('cortex-w2', { ...registerOpts('sess-w2'), teamLeadId: 'sess-lead2', workerName: 'w2' });
  await repo.registerSession('cortex-orphan', { ...registerOpts('sess-orphan'), teamLeadId: 'sess-gone', workerName: 'o' });
  await repo.updateSession('cortex-w1', { lastUsedAt: stale });
  await repo.updateSession('cortex-lead2', { lastUsedAt: stale });
  await repo.updateSession('cortex-orphan', { lastUsedAt: stale });

  const pending = await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);
  assert.deepEqual(
    pending.map(entry => entry.session.sessionId).sort(),
    ['sess-lead2', 'sess-orphan', 'sess-w2'],
    'w1 waits for its live lead; w2 (fresh) goes with its expired lead; an orphan ages out normally',
  );
  assert.equal((await repo.getById('sess-w1'))?.workerName, 'w1');

  const protectedLead = new SessionRegistryRepo(nextPaths().filePath);
  await protectedLead.registerSession('cortex-l', registerOpts('l'));
  await protectedLead.registerSession('cortex-w', { ...registerOpts('w'), teamLeadId: 'l', workerName: 'w' });
  await protectedLead.updateSession('cortex-l', { lastUsedAt: stale });
  await protectedLead.updateSession('cortex-w', { lastUsedAt: stale });
  assert.deepEqual(await protectedLead.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), ['l']), [],
    'an in-use lead keeps its workers');
});

test('retention keeps starred and commission sessions however old; a worker still follows its lead', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  const stale = '2020-01-01T00:00:00.000Z';
  await repo.registerSession('cortex-starred', registerOpts('sess-starred'));
  await repo.setStarred('sess-starred', true);
  await repo.registerSession('cortex-commission', registerOpts('sess-commission', { commissionId: 'c-1' }));
  await repo.registerSession('cortex-plain', registerOpts('sess-plain'));
  // A kept lead keeps its workers.
  await repo.registerSession('cortex-lead', registerOpts('sess-lead'));
  await repo.setStarred('sess-lead', true);
  await repo.registerSession('cortex-worker', { ...registerOpts('sess-worker'), teamLeadId: 'sess-lead', workerName: 'w' });
  // A worker goes with its expired lead, its own star notwithstanding (Decision 6).
  await repo.registerSession('cortex-lead2', registerOpts('sess-lead2'));
  await repo.registerSession('cortex-worker2', { ...registerOpts('sess-worker2'), teamLeadId: 'sess-lead2', workerName: 'w2' });
  await repo.setStarred('sess-worker2', true);
  for (const name of ['cortex-starred', 'cortex-commission', 'cortex-plain', 'cortex-lead', 'cortex-worker', 'cortex-lead2', 'cortex-worker2']) {
    await repo.updateSession(name, { lastUsedAt: stale });
  }

  const pending = await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);
  assert.deepEqual(
    pending.map(entry => entry.session.sessionId).sort(),
    ['sess-lead2', 'sess-plain', 'sess-worker2'],
  );
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
    lines.push(lineText({ v: 1, op: 'conversation', channel, kind: 'set', fields: { sessionId: id, sessionName: `cortex-${id}`, backend: 'claude', profileName: null, updatedAt: '2020-01-01T00:00:00.000Z' } }));
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

test('beginDeleteExpired, the cleanup releases and commitDeletions each land as one append and one compaction check', async () => {
  const { filePath } = nextPaths();
  const ids = await seedExpired(filePath, 50, 2);
  const { repo, counts } = countingRepo(filePath, { compactAlways: true });

  const pending = await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);
  assert.equal(pending.length, 50);
  assert.deepEqual(counts, { appends: 1, compactions: 1 });

  assert.equal(await repo.unbindBySessionIds(ids), 50);
  assert.equal(await repo.clearConversationsBySessionIds(ids), 50);
  assert.deepEqual(counts, { appends: 3, compactions: 3 });
  assert.equal(await repo.getBoundSessionId('web:sess-0'), null);
  assert.deepEqual(await repo.getTurns('web:sess-0'), []);
  assert.equal(await repo.getConversationHeader('web:sess-0'), null);

  const committed = await repo.commitDeletions([...ids, 'not-pending', ids[0]]);
  assert.deepEqual(committed, ids);
  assert.deepEqual(counts, { appends: 4, compactions: 4 });
  assert.deepEqual(await repo.listPendingDeletions(), []);
  assert.deepEqual(await repo.commitDeletions(ids), [], 'a second commit is a no-op');
  assert.equal(counts.appends, 4, 'and appends nothing');

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
    { v: 1, op: 'patch', id: 'sess-0', name: 'cortex-sess-0', fields: { label: 'a' } },
    { v: 1, op: 'patch', id: 'sess-0', name: 'cortex-sess-0', fields: { label: 'b' } },
  ]), /twice/);
  assert.equal(await fileText(filePath), before);
});
