// input:  ../_test-home, vitest, tmp fs, and session registry repo/journal options
// output: JSONL journal replay, append, delete, compact, and failure-mode tests
// pos:    Session registry JSONL authority and mutation contract
// >>> If I am updated, update my header comment and the parent folder CORTEX.md <<<

import '../_test-home.js';
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRegistryRepo, deriveSessionOrigin, type Session } from '../../src/store/session-registry-repo.js';

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
  const filePath = path.join(tmpDir, `session-registry-${id}.jsonl`);
  return {
    filePath,
    legacyPath: filePath.replace(/\.jsonl$/, '.json'),
    backupPath: filePath.replace(/\.jsonl$/, '.json.bak'),
  };
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

test('deriveSessionOrigin keeps scheduled precedence and detects thread labels', () => {
  assert.equal(deriveSessionOrigin('scheduled', null), 'scheduled');
  assert.equal(deriveSessionOrigin('scheduled', '[thr:x]'), 'scheduled');
  assert.equal(deriveSessionOrigin('local', '[thr_1:coder]'), 'thread');
  assert.equal(deriveSessionOrigin('local', 'plain text'), 'direct');
});

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
  assert.deepEqual(lines.map(line => line.op), ['put', 'put', 'put']);
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
  assert.deepEqual(jsonlLines(filePath).map(line => line.op), ['put', 'put', 'put', 'delete-intent', 'delete-commit']);
});

test('session registry touchForUse and beginDeleteExpired share one admission mutex', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-touch', registerOpts('sess-touch'));
  await repo.updateSession('cortex-touch', { lastUsedAt: '2020-01-01T00:00:00.000Z' });

  assert.equal(await repo.touchForUse('sess-touch'), true);
  assert.deepEqual(await repo.beginDeleteExpired(Date.now() - 1_000, []), []);

  await repo.updateSession('cortex-touch', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  assert.deepEqual((await repo.beginDeleteExpired(new Date(), [])).map(entry => entry.session.sessionId), ['sess-touch']);
  assert.equal(await repo.touchForUse('sess-touch'), false);
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
  assert.equal(await repo.touchForUse('sess-pending'), false);
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

test('session registry append tracks the actual on-disk size after partial-failure rollback and later success', async () => {
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
  fail = true;
  await assert.rejects(repo.registerSession('cortex-b', registerOpts('sess-b')), /forced partial append/);
  fail = false;
  await repo.registerSession('cortex-c', registerOpts('sess-c'));

  const reopened = new SessionRegistryRepo(filePath);
  const sessions = await reopened.listRecentSessions(10);
  assert.deepEqual(new Set(sessions.map(session => session.sessionId)), new Set(['sess-a', 'sess-c']));
  const statSize = (await fs.stat(filePath)).size;
  assert.equal(Buffer.byteLength(await fileText(filePath)), statSize);
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

test('session registry replays commissionId and browser opt-in from the journal', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-comm', registerOpts('sess-comm', { browser: { device: 'server' } }));
  await repo.bindCommission('sess-comm', 'comm-1');

  repo.invalidate();
  const record = await repo.lookupSession('cortex-comm');
  assert.equal(record?.commissionId, 'comm-1');
  assert.deepEqual(record?.browser, { device: 'server' });

  const reopened = new SessionRegistryRepo(filePath);
  const replayed = await reopened.getById('sess-comm');
  assert.equal(replayed?.commissionId, 'comm-1');
  assert.deepEqual(replayed?.browser, { device: 'server' });
});

test('session registry replays commissionDraft and clears it when the commission lands', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-draft', registerOpts('sess-draft', { commissionDraft: '_draft-cortex-draft' }));

  // Survives a cold replay — the field must be whitelisted in BOTH journal asserts or every
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
