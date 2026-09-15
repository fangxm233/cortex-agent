import '../_test-home.js';
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRegistryRepo, effectiveBackendSessionId, type Session, type TurnRecord } from '../../src/store/session-registry-repo.js';
import { createSessionRegistryState, shouldCompactSessionRegistry } from '../../src/store/session-registry-journal.js';
import type { SessionContextUsage } from '../../src/core/types/agent-types.js';

let tmpDir = '';
let testId = 0;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-session-registry-events-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function nextPath() {
  return path.join(tmpDir, `session-registry-${testId++}.jsonl`);
}

function registerOpts(id: string, extra: Record<string, unknown> = {}) {
  return { sessionId: id, channel: 'C001', backend: 'claude', kind: 'local' as const, projectId: 'proj', label: 'label', ...extra };
}

function rawLines(filePath: string): string[] {
  return fssync.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
}

function jsonl(filePath: string) {
  return rawLines(filePath).map(line => JSON.parse(line));
}

function usage(percent: number): SessionContextUsage {
  return { usedTokens: 4523, contextWindow: 200000, percent, accuracy: 'exact', updatedAt: '2025-01-01T00:00:00.000Z' };
}

function fullTurn(turnIndex: number): TurnRecord {
  return {
    turnIndex,
    userMessageTs: '1700000000.0001',
    userMessageText: 'hello **world**\nwith newlines — rewind needs the full text',
    statusMessageTs: '1700000000.0002',
    responseMessageTimestamps: ['1700000000.0003', '1700000000.0004'],
    executionId: 'exec_abc',
    backupPath: '/backups/sess/turn-0.bak',
    status: 'processing',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:01.000Z',
  };
}

test('contextUsage update appends exactly one small patch line', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-ctx', registerOpts('sess-ctx'));
  const before = rawLines(filePath).length;

  await repo.updateContextUsage('sess-ctx', usage(2.3));

  const lines = rawLines(filePath);
  assert.equal(lines.length, before + 1);
  const lastText = lines[lines.length - 1];
  const last = JSON.parse(lastText);
  assert.equal(last.op, 'patch');
  assert.equal(last.id, 'sess-ctx');
  assert.equal(last.name, 'cortex-ctx');
  assert.ok(last.fields.contextUsage, 'patch carries the changed contextUsage');
  const bytes = Buffer.byteLength(`${lastText}\n`);
  assert.ok(bytes <= 200, `contextUsage patch line is ${bytes} bytes, expected <= 200`);
});

test('commission fields written as patches survive a replay (main d2449c4f added commissionBlockFor)', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-cm', registerOpts('sess-cm'));
  await repo.setCommissionDraft('sess-cm', '/draft/dir');            // patch commissionDraft
  await repo.markCommissionBlockDelivered('sess-cm', 'draft:/draft/dir'); // patch commissionBlockFor
  await repo.bindCommission('sess-cm', 'comm-1');                    // patch commissionId (+ clears draft)
  const ops = rawLines(filePath).map(line => JSON.parse(line).op);
  assert.deepEqual(ops, ['put', 'patch', 'patch', 'patch']);

  const reopened = new SessionRegistryRepo(filePath);
  const record = await reopened.getById('sess-cm');
  assert.equal(record?.commissionId, 'comm-1');
  assert.equal(record?.commissionDraft, null);
  assert.equal(record?.commissionBlockFor, 'draft:/draft/dir');
});

test('an update that changes nothing appends no event', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-noop', registerOpts('sess-noop'));
  const before = rawLines(filePath).length;

  await repo.updateSession('cortex-noop', { label: 'label' }); // identical to the registered label
  await repo.updateContextUsage('sess-noop', null); // never had usage → clearing is a no-op too

  assert.equal(rawLines(filePath).length, before);
});

test('replaying a journal with every event kind (plus a torn tail) reproduces state', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-a', registerOpts('sess-a'));
  await repo.registerSession('cortex-b', registerOpts('sess-b'));
  await repo.updateSession('cortex-a', { label: 'A2' });        // patch
  await repo.bindChannel('web:chan', 'sess-a');                 // bind
  await repo.bindChannel('web:temp', 'sess-a');                 // bind
  await repo.unbindChannel('web:temp');                         // unbind
  await repo.beginTurn('sess-a', fullTurn(0));                  // turn begin
  await repo.beginTurn('sess-a', fullTurn(1));                  // turn begin
  await repo.patchTurn('sess-a', 0, { status: 'completed' });   // turn patch
  await repo.truncateTurns('sess-a', 1);                        // turn truncate (drops turn 1)
  await repo.updateSession('cortex-b', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []); // delete-intent
  await repo.commitDeletion('sess-b');                          // delete-commit

  await fs.appendFile(filePath, '{"v":1,"op":"pu'); // torn last line

  const reopened = new SessionRegistryRepo(filePath);
  assert.equal((await reopened.lookupSession('cortex-a'))?.label, 'A2');
  assert.equal(await reopened.getById('sess-b'), null);
  assert.equal(await reopened.getBoundSessionId('web:chan'), 'sess-a');
  assert.equal(await reopened.getBoundSessionId('web:temp'), null);
  const turns = await reopened.getTurns('sess-a');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turnIndex, 0);
  assert.equal(turns[0].status, 'completed');
  assert.deepEqual((await reopened.listBindings()), [{ channel: 'web:chan', sessionId: 'sess-a' }]);
});

test('every TurnRecord and patch field round-trips through write → replay → compact → replay', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath, { shouldCompact: () => false });
  await repo.registerSession('cortex-rt', registerOpts('sess-rt', {
    browser: { device: 'server' }, scheduleId: 'sched-1', commissionDraft: '_draft-cortex-rt',
  }));
  await repo.updateSession('cortex-rt', {
    label: 'renamed', profileName: 'coder', backendSessionId: 'be-9', lastUsedAt: '2025-02-02T00:00:00.000Z',
  });
  await repo.updateContextUsage('sess-rt', usage(9.9));
  await repo.markRead('sess-rt');
  await repo.bindCommission('sess-rt', 'comm-1'); // sets commissionId, clears commissionDraft
  await repo.convertToDirect('sess-rt', { channel: 'C999' });
  await repo.beginTurn('sess-rt', fullTurn(0));
  await repo.patchTurn('sess-rt', 0, {
    status: 'completed', responseMessageTimestamps: ['a', 'b', 'c'], executionId: 'exec_z',
    backupPath: null, updatedAt: '2025-02-02T01:00:00.000Z',
  });

  const assertPreserved = async (r: SessionRegistryRepo) => {
    const rec = await r.getById('sess-rt') as Session;
    assert.equal(rec.label, 'renamed');
    assert.equal(rec.profileName, 'coder');
    assert.equal(rec.backendSessionId, 'be-9');
    assert.equal(rec.lastUsedAt, '2025-02-02T00:00:00.000Z');
    assert.equal(rec.scheduleId, 'sched-1');
    assert.equal(rec.commissionId, 'comm-1');
    assert.equal(rec.commissionDraft, null);
    assert.equal(rec.channel, 'C999');
    assert.equal(rec.origin, 'direct');
    assert.deepEqual(rec.browser, { device: 'server' });
    assert.deepEqual(rec.contextUsage, usage(9.9));
    assert.ok(rec.lastReadAt);
    const [turn] = await r.getTurns('sess-rt');
    assert.deepEqual(turn, {
      turnIndex: 0,
      userMessageTs: '1700000000.0001',
      userMessageText: 'hello **world**\nwith newlines — rewind needs the full text',
      statusMessageTs: '1700000000.0002',
      responseMessageTimestamps: ['a', 'b', 'c'],
      executionId: 'exec_z',
      backupPath: null,
      status: 'completed',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-02-02T01:00:00.000Z',
    });
  };

  await assertPreserved(new SessionRegistryRepo(filePath, { shouldCompact: () => false })); // replay
  await repo.compactNow();
  await assertPreserved(new SessionRegistryRepo(filePath, { shouldCompact: () => false })); // replay after compaction
});

test('compaction keeps live bindings and turns but drops those of committed deletions', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-a', registerOpts('sess-a'));
  await repo.registerSession('cortex-b', registerOpts('sess-b'));
  await repo.bindChannel('web:a', 'sess-a');
  await repo.bindChannel('web:b', 'sess-b');
  await repo.beginTurn('web:a', fullTurn(0)); // turns are channel-keyed now
  await repo.beginTurn('web:b', fullTurn(0));
  await repo.updateSession('cortex-b', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);
  await repo.commitDeletion('sess-b');

  await repo.compactNow();

  const ops = jsonl(filePath).map(line => `${line.op}:${line.op === 'bind' ? line.channel : line.op === 'turn' ? `${line.channel}/${line.kind}` : line.id}`);
  assert.deepEqual(ops.sort(), ['bind:web:a', 'put:sess-a', 'turn:web:a/begin']);

  const reopened = new SessionRegistryRepo(filePath);
  assert.equal(await reopened.getBoundSessionId('web:b'), null);
  assert.deepEqual(await reopened.getTurns('web:b'), []); // delete-commit dropped the deleted session's channel turns
  assert.equal((await reopened.getTurns('web:a')).length, 1);
});

test('binding is a free map — no liveness guard on the target session (intended behaviour change)', async () => {
  // T2: the registry is the single owner of identity, so a bind is a plain channel→id edge with no
  // check that the id names a live (or even existing) session — turns append the same way. This
  // replaces the old guard that rejected binds to unknown/pending sessions; retention (delete-commit)
  // is now what reaps dangling edges, not the append path.
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.bindChannel('web:x', 'sess-missing'); // unknown session → binds
  assert.equal(await repo.getBoundSessionId('web:x'), 'sess-missing');

  await repo.registerSession('cortex-p', registerOpts('sess-p'));
  await repo.updateSession('cortex-p', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);
  await repo.bindChannel('web:p', 'sess-p'); // pending-delete session → still binds
  assert.equal(await repo.getBoundSessionId('web:p'), 'sess-p');
});

test('unbinding an unknown channel is a no-op that appends nothing', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-a', registerOpts('sess-a'));
  const before = rawLines(filePath).length;
  await repo.unbindChannel('web:never-bound');
  assert.equal(rawLines(filePath).length, before);
});

test('conduit resolvers win over persisted bindings, null falls through', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-a', registerOpts('sess-a'));
  await repo.bindChannel('web:r', 'sess-a');

  assert.equal(await repo.getBoundSessionId('web:r'), 'sess-a'); // persisted only

  const off = repo.registerConduitResolver(channel => (channel === 'web:r' ? 'sess-resolved' : null));
  assert.equal(await repo.getBoundSessionId('web:r'), 'sess-resolved'); // resolver wins
  assert.equal(await repo.getBoundSessionId('web:other'), null);       // resolver null → no persisted bind

  off();
  assert.equal(await repo.getBoundSessionId('web:r'), 'sess-a'); // back to persisted
});

test('undefined vs null backendSessionId survives patch, compaction and replay', async () => {
  const filePath = nextPath();
  const base = {
    projectId: 'proj', channel: 'C001', backend: 'claude', kind: 'local', origin: 'direct',
    createdAt: '2025-01-01T00:00:00.000Z', lastUsedAt: '2025-01-01T00:00:00.000Z', label: null, profileName: null,
  };
  const recU = { name: 'cortex-u', sessionId: 'sess-u', ...base };                          // backendSessionId absent → undefined
  const recN = { name: 'cortex-n', sessionId: 'sess-n', ...base, backendSessionId: null };  // explicit fresh backend
  await fs.writeFile(filePath, [
    JSON.stringify({ v: 1, op: 'put', id: 'sess-u', record: recU }),
    JSON.stringify({ v: 1, op: 'put', id: 'sess-n', record: recN }),
    '',
  ].join('\n'));

  const repo = new SessionRegistryRepo(filePath);
  await repo.updateContextUsage('sess-u', usage(1.1)); // a patch that must NOT disturb backendSessionId
  await repo.updateContextUsage('sess-n', usage(1.1));
  await repo.compactNow();

  const reopened = new SessionRegistryRepo(filePath);
  const u = await reopened.getById('sess-u') as Session;
  const n = await reopened.getById('sess-n') as Session;
  assert.equal(u.backendSessionId, undefined);
  assert.equal(effectiveBackendSessionId(u), 'sess-u'); // undefined ⇒ own sessionId
  assert.equal(n.backendSessionId, null);
  assert.equal(effectiveBackendSessionId(n), null);     // null ⇒ explicit fresh backend session
});

test('an old-format journal with only put/delete-* events still replays', async () => {
  const filePath = nextPath();
  const record = {
    name: 'cortex-legacy', sessionId: 'sess-legacy', projectId: 'proj', channel: 'C001', backend: 'claude',
    kind: 'local', origin: 'direct', createdAt: '2025-01-01T00:00:00.000Z', lastUsedAt: '2025-01-01T00:00:00.000Z',
    label: null, profileName: null, backendSessionId: null,
  };
  const live = { ...record, name: 'cortex-live', sessionId: 'sess-live' };
  await fs.writeFile(filePath, [
    JSON.stringify({ v: 1, op: 'put', id: 'sess-live', record: live }),
    JSON.stringify({ v: 1, op: 'put', id: 'sess-legacy', record }),
    JSON.stringify({ v: 1, op: 'delete-intent', id: 'sess-legacy', record }),
    JSON.stringify({ v: 1, op: 'delete-commit', id: 'sess-legacy' }),
    '',
  ].join('\n'));

  const repo = new SessionRegistryRepo(filePath);
  assert.equal((await repo.lookupSession('cortex-live'))?.sessionId, 'sess-live');
  assert.equal(await repo.getById('sess-legacy'), null);
  assert.deepEqual(await repo.listBindings(), []);
  await repo.compactNow();
  assert.deepEqual(jsonl(filePath).map(line => line.op), ['put']); // only the live session survives
});

test('compaction threshold is max(512, live*4)', () => {
  const small = createSessionRegistryState();
  small.eventCount = 512;
  assert.equal(shouldCompactSessionRegistry(small, {}), false);
  small.eventCount = 513;
  assert.equal(shouldCompactSessionRegistry(small, {}), true);

  const big = createSessionRegistryState();
  for (let i = 0; i < 200; i += 1) big.live.set(`s${i}`, {} as never); // live.size = 200 → threshold 800
  big.eventCount = 800;
  assert.equal(shouldCompactSessionRegistry(big, {}), false);
  big.eventCount = 801;
  assert.equal(shouldCompactSessionRegistry(big, {}), true);

  const huge = createSessionRegistryState();
  huge.fileSize = 16 * 1024 * 1024 + 1; // 16 MB cap unchanged
  assert.equal(shouldCompactSessionRegistry(huge, {}), true);
});

test('batch lands put + bind + turn under one admission lock', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.batch(async (ops) => {
    await ops.registerSession('cortex-batch', registerOpts('sess-batch'));
    await ops.bindChannel('web:batch', 'sess-batch'); // requires the put to be visible in the same lock
    await ops.beginTurn('sess-batch', fullTurn(0));
  });

  assert.deepEqual(jsonl(filePath).map(line => line.op), ['put', 'bind', 'turn']);
  assert.equal(await repo.getBoundSessionId('web:batch'), 'sess-batch');
  assert.equal((await repo.getTurns('sess-batch')).length, 1);

  const reopened = new SessionRegistryRepo(filePath);
  assert.equal(await reopened.getBoundSessionId('web:batch'), 'sess-batch');
  assert.equal((await reopened.getTurns('sess-batch')).length, 1);
});
