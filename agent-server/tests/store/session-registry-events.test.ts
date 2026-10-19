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

test('nameless registration and patch persist without name keys across replay and compaction', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-nameless'));
  await repo.updateSession('sess-nameless', { label: 'new label' });
  assert.deepEqual(jsonl(filePath).map(line => line.op), ['put', 'patch']);
  assert.equal(Object.hasOwn(jsonl(filePath)[0].record, 'name'), false);
  assert.equal(Object.hasOwn(jsonl(filePath)[1], 'name'), false);
  assert.equal((await new SessionRegistryRepo(filePath).getById('sess-nameless'))?.label, 'new label');
  await repo.compactNow();
  assert.equal(Object.hasOwn(jsonl(filePath)[0].record, 'name'), false);
  assert.equal((await new SessionRegistryRepo(filePath).getById('sess-nameless'))?.label, 'new label');
});

test('legacy labels are ignored while model names survive compaction until selection is materialized', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-legacy-name'));
  const put = jsonl(filePath)[0];
  await fs.writeFile(filePath, [
    JSON.stringify({ ...put, record: { ...put.record, name: { obsolete: true }, profileName: { obsolete: true } } }),
    JSON.stringify({ v: 1, op: 'patch', id: 'sess-legacy-name', name: 42, fields: { label: 'legacy patch', profileName: 42 }, unset: ['profileName'] }),
    JSON.stringify({ v: 1, op: 'conversation', channel: 'C001', kind: 'set', fields: {
      sessionId: 'sess-legacy-name', sessionName: { obsolete: true }, backend: 'claude',
      profileName: { obsolete: true }, updatedAt: '2025-01-01T00:00:00.000Z',
    } }),
    '',
  ].join('\n'));
  const reopened = new SessionRegistryRepo(filePath);
  assert.equal((await reopened.getById('sess-legacy-name'))?.label, 'legacy patch');
  assert.equal(Object.hasOwn((await reopened.getById('sess-legacy-name'))!, 'name'), false);
  assert.equal(Object.hasOwn((await reopened.getConversationHeader('C001'))!, 'sessionName'), false);
  await reopened.compactNow();
  assert.equal(JSON.stringify(jsonl(filePath)).includes('sessionName'), false);
  assert.equal((await reopened.getById('sess-legacy-name'))?.profileName, undefined);
  assert.deepEqual((await new SessionRegistryRepo(filePath).getConversationHeader('C001'))?.profileName, { obsolete: true });
});

test('contextUsage update appends exactly one small patch line', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-ctx'));
  const before = rawLines(filePath).length;

  await repo.updateContextUsage('sess-ctx', usage(2.3));

  const lines = rawLines(filePath);
  assert.equal(lines.length, before + 1);
  const lastText = lines[lines.length - 1];
  const last = JSON.parse(lastText);
  assert.equal(last.op, 'patch');
  assert.equal(last.id, 'sess-ctx');
  assert.equal(Object.hasOwn(last, 'name'), false);
  assert.ok(last.fields.contextUsage, 'patch carries the changed contextUsage');
  const bytes = Buffer.byteLength(`${lastText}\n`);
  assert.ok(bytes <= 200, `contextUsage patch line is ${bytes} bytes, expected <= 200`);
});

test('board fields written as patches survive a replay', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-bd'));
  await repo.bindBoard('sess-bd', 'b-1');                 // patch boardId
  await repo.markBoardBlockDelivered('sess-bd', 'b-1');   // patch boardBlockFor
  await repo.bindBoard('sess-bd', 'b-2');                 // patch boardId again
  const ops = rawLines(filePath).map(line => JSON.parse(line).op);
  assert.deepEqual(ops, ['put', 'patch', 'patch', 'patch']);

  const reopened = new SessionRegistryRepo(filePath);
  const record = await reopened.getById('sess-bd');
  assert.equal(record?.boardId, 'b-2');
  assert.equal(record?.boardBlockFor, 'b-1');

  await reopened.clearBoardBlockDelivery('sess-bd');
  assert.equal((await new SessionRegistryRepo(filePath).getById('sess-bd'))?.boardBlockFor, null);
});

test('a journal written before boards replays: legacy commission keys map onto board fields', async () => {
  const filePath = nextPath();
  const record = (id: string, extra: Record<string, unknown> = {}) => ({
    sessionId: id, projectId: 'proj', channel: `web:${id}`, backend: 'claude', kind: 'local', origin: 'direct',
    createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: '2026-09-01T00:00:00.000Z', label: null, selection: null,
    ...extra,
  });
  const lines = [
    { v: 1, op: 'put', id: 's-old', record: record('s-old') },
    { v: 1, op: 'patch', id: 's-old', fields: { commissionDraft: '_draft-s-old' } },
    { v: 1, op: 'patch', id: 's-old', fields: { commissionBlockFor: 'draft:_draft-s-old' } },
    { v: 1, op: 'patch', id: 's-old', fields: { commissionId: 'c-1', commissionDraft: null } },
    { v: 1, op: 'patch', id: 's-old', fields: { lastUsedAt: '2026-09-02T00:00:00.000Z' }, unset: ['commissionDraft'] },
    { v: 1, op: 'put', id: 's-put', record: record('s-put', { commissionId: 'c-2', commissionDraft: null, commissionBlockFor: 'active:c-2' }) },
    { v: 1, op: 'put', id: 's-draft', record: record('s-draft', { commissionDraft: '_draft-s-draft' }) },
  ];
  await fs.writeFile(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const repo = new SessionRegistryRepo(filePath);
  const old = await repo.getById('s-old') as Session & Record<string, unknown>;
  assert.equal(old.boardId, 'c-1');
  assert.equal(old.boardBlockFor, 'draft:_draft-s-old');
  assert.equal(old.lastUsedAt, '2026-09-02T00:00:00.000Z');
  assert.equal(old.commissionDraft, undefined, 'commissionDraft is ignored');
  assert.equal(old.commissionId, undefined);

  const put = await repo.getById('s-put') as Session & Record<string, unknown>;
  assert.equal(put.boardId, 'c-2');
  assert.equal(put.boardBlockFor, 'active:c-2');
  assert.equal(put.commissionId, undefined);

  const draft = await repo.getById('s-draft');
  assert.equal(draft?.boardId ?? null, null);

  // New writes go out under the board keys only.
  await repo.bindBoard('s-old', 'b-9');
  const last = JSON.parse(rawLines(filePath).at(-1)!);
  assert.deepEqual(last.fields, { boardId: 'b-9' });
});

test('a journal with the retired per-session browser option replays and drops it', async () => {
  const filePath = nextPath();
  const record = (id: string, extra: Record<string, unknown> = {}) => ({
    sessionId: id, projectId: 'proj', channel: `web:${id}`, backend: 'claude', kind: 'local', origin: 'direct',
    createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: '2026-09-01T00:00:00.000Z', label: null, selection: null,
    ...extra,
  });
  const lines = [
    { v: 1, op: 'put', id: 's-b', record: record('s-b', { browser: { device: 'server' } }) },
    { v: 1, op: 'patch', id: 's-b', fields: { browser: { device: 'my-pc' }, label: 'kept' } },
    { v: 1, op: 'patch', id: 's-b', fields: { lastUsedAt: '2026-09-02T00:00:00.000Z' }, unset: ['browser'] },
    { v: 1, op: 'put', id: 's-null', record: record('s-null', { browser: null }) },
  ];
  await fs.writeFile(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const repo = new SessionRegistryRepo(filePath);
  const s = await repo.getById('s-b') as Session & Record<string, unknown>;
  assert.equal(s.label, 'kept');
  assert.equal(s.lastUsedAt, '2026-09-02T00:00:00.000Z');
  assert.equal(Object.hasOwn(s, 'browser'), false);
  assert.equal(Object.hasOwn(await repo.getById('s-null') as object, 'browser'), false);
});

test('a journal written while workers could be retired replays: workerRetiredAt is dropped', async () => {
  const filePath = nextPath();
  const record = {
    sessionId: 'w', projectId: 'proj', channel: 'web:w', backend: 'claude', kind: 'local', origin: 'direct',
    createdAt: '2026-10-01T00:00:00.000Z', lastUsedAt: '2026-10-01T00:00:00.000Z', label: null, selection: null,
    teamLeadId: 'lead', workerName: 'scout', workerRetiredAt: null,
  };
  const lines = [
    { v: 1, op: 'put', id: 'w', record },
    { v: 1, op: 'patch', id: 'w', fields: { workerRetiredAt: 1738454400000 } },
    { v: 1, op: 'patch', id: 'w', fields: { label: 'kept' }, unset: ['workerRetiredAt'] },
  ];
  await fs.writeFile(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const worker = await new SessionRegistryRepo(filePath).getById('w') as Session & Record<string, unknown>;
  assert.equal(worker.workerName, 'scout');
  assert.equal(worker.label, 'kept');
  assert.equal(worker.workerRetiredAt, undefined);
});

test('an update that changes nothing appends no event', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-noop'));
  const before = rawLines(filePath).length;

  await repo.updateSession('sess-noop', { label: 'label' }); // identical to the registered label
  await repo.updateContextUsage('sess-noop', null); // never had usage → clearing is a no-op too

  assert.equal(rawLines(filePath).length, before);
});

test('replaying a journal with every event kind (plus a torn tail) reproduces state', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-a'));
  await repo.registerSession(registerOpts('sess-b'));
  await repo.updateSession('sess-a', { label: 'A2' });        // patch
  await repo.bindChannel('web:chan', 'sess-a');                 // bind
  await repo.bindChannel('web:temp', 'sess-a');                 // bind
  await repo.unbindChannel('web:temp');                         // unbind
  await repo.beginTurn('sess-a', fullTurn(0));                  // turn begin
  await repo.beginTurn('sess-a', fullTurn(1));                  // turn begin
  await repo.patchTurn('sess-a', 0, { status: 'completed' });   // turn patch
  await repo.truncateTurns('sess-a', 1);                        // turn truncate (drops turn 1)
  await repo.updateSession('sess-b', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []); // delete-intent
  await repo.commitDeletion('sess-b');                          // delete-commit

  await fs.appendFile(filePath, '{"v":1,"op":"pu'); // torn last line

  const reopened = new SessionRegistryRepo(filePath);
  assert.equal((await reopened.getById('sess-a'))?.label, 'A2');
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
  await repo.registerSession(registerOpts('sess-rt', {
    scheduleId: 'sched-1', boardId: 'b-0',
    teamLeadId: 'sess-lead', workerName: 'scout',
  }));
  await repo.updateSession('sess-rt', {
    label: 'renamed', selection: { backend: 'pi', provider: 'deepseek', model: 'v4', thinking: 'high', mode: 'deepseek' }, backendSessionId: 'be-9', lastUsedAt: '2025-02-02T00:00:00.000Z',
  });
  await repo.updateContextUsage('sess-rt', usage(9.9));
  await repo.markRead('sess-rt');
  await repo.bindBoard('sess-rt', 'b-1');
  await repo.convertToDirect('sess-rt', { channel: 'C999' });
  await repo.beginTurn('sess-rt', fullTurn(0));
  await repo.patchTurn('sess-rt', 0, {
    status: 'completed', responseMessageTimestamps: ['a', 'b', 'c'], executionId: 'exec_z',
    backupPath: null, updatedAt: '2025-02-02T01:00:00.000Z',
  });

  const assertPreserved = async (r: SessionRegistryRepo) => {
    const rec = await r.getById('sess-rt') as Session;
    assert.equal(rec.label, 'renamed');
    assert.deepEqual(rec.selection, { backend: 'pi', provider: 'deepseek', model: 'v4', thinking: 'high', mode: 'deepseek' });
    assert.equal(rec.backendSessionId, 'be-9');
    assert.equal(rec.lastUsedAt, '2025-02-02T00:00:00.000Z');
    assert.equal(rec.scheduleId, 'sched-1');
    assert.equal(rec.boardId, 'b-1');
    assert.equal(rec.channel, 'C999');
    assert.equal(rec.origin, 'direct');
    assert.equal(rec.teamLeadId, 'sess-lead');
    assert.equal(rec.workerName, 'scout');
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
  await repo.registerSession(registerOpts('sess-a'));
  await repo.registerSession(registerOpts('sess-b'));
  await repo.bindChannel('web:a', 'sess-a');
  await repo.bindChannel('web:b', 'sess-b');
  await repo.beginTurn('web:a', fullTurn(0)); // turns are channel-keyed now
  await repo.beginTurn('web:b', fullTurn(0));
  await repo.updateSession('sess-b', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
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

  await repo.registerSession(registerOpts('sess-p'));
  await repo.updateSession('sess-p', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);
  await repo.bindChannel('web:p', 'sess-p'); // pending-delete session → still binds
  assert.equal(await repo.getBoundSessionId('web:p'), 'sess-p');
});

test('unbinding an unknown channel is a no-op that appends nothing', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-a'));
  const before = rawLines(filePath).length;
  await repo.unbindChannel('web:never-bound');
  assert.equal(rawLines(filePath).length, before);
});

test('conduit resolvers win over persisted bindings, null falls through', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession(registerOpts('sess-a'));
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
    createdAt: '2025-01-01T00:00:00.000Z', lastUsedAt: '2025-01-01T00:00:00.000Z', label: null, selection: null,
  };
  const recU = { sessionId: 'sess-u', ...base };                          // backendSessionId absent → undefined
  const recN = { sessionId: 'sess-n', ...base, backendSessionId: null };  // explicit fresh backend
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
    label: null, selection: null, backendSessionId: null,
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
  assert.equal((await repo.getById('sess-live'))?.sessionId, 'sess-live');
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

test('batch updates a session by id without writing a name', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.batch(async ops => {
    await ops.registerSession(registerOpts('sess-batch-update'));
    await ops.updateSession('sess-batch-update', { label: 'updated' });
  });
  assert.equal((await new SessionRegistryRepo(filePath).getById('sess-batch-update'))?.label, 'updated');
  assert.equal(jsonl(filePath).some(line => Object.hasOwn(line, 'name') || Object.hasOwn(line.record ?? {}, 'name')), false);
});

test('batch lands put + bind + turn under one admission lock', async () => {
  const filePath = nextPath();
  const repo = new SessionRegistryRepo(filePath);
  await repo.batch(async (ops) => {
    await ops.registerSession(registerOpts('sess-batch'));
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
