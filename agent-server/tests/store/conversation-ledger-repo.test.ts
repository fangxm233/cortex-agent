// input:  ../_test-home, isolated ledger JSONL files, legacy JSON, and conversation turn operations
// output: conversation ledger CRUD, journal append/replay/compaction, and legacy migration tests
// pos:    Verifies turn mapping persistence behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // MUST be first import — repoints CORTEX_HOME before paths bind

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ConversationLedgerRepo,
  type ConversationLedgerRepoOptions,
} from '../../src/store/conversation-ledger-repo.js';

async function makeDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cortex-ledger-'));
}

async function makeRepo(options: ConversationLedgerRepoOptions = {}) {
  const root = await makeDir();
  const file = path.join(root, 'conversation-ledger.jsonl');
  return { repo: new ConversationLedgerRepo(file, options), file, root };
}

async function lines(file: string): Promise<string[]> {
  const raw = await fs.readFile(file, 'utf8');
  return raw.split('\n').filter(Boolean);
}

test('clearBySessionIds removes every channel conversation whose sessionId matches', async () => {
  const { repo } = await makeRepo();
  await repo.initConversation('C1', { sessionId: 'track-1', sessionName: 'one', backend: 'claude' });
  await repo.initConversation('C2', { sessionId: 'track-2', sessionName: 'two', backend: 'claude' });
  await repo.initConversation('C3', { sessionId: 'track-1', sessionName: 'three', backend: 'pi' });

  const removed = await repo.clearBySessionIds(['track-1']);

  assert.equal(removed, 2);
  assert.equal(await repo.getConversation('C1'), null);
  assert.ok(await repo.getConversation('C2'));
  assert.equal(await repo.getConversation('C3'), null);
});

test('deleteExceptSessionIds removes dangling conversations while preserving live session ids', async () => {
  const { repo } = await makeRepo();
  await repo.initConversation('C1', { sessionId: 'track-1', sessionName: 'one', backend: 'claude' });
  await repo.initConversation('C2', { sessionId: 'track-2', sessionName: 'two', backend: 'claude' });
  await repo.initConversation('C3', { sessionId: null, sessionName: 'none', backend: 'claude' });

  const removed = await repo.deleteExceptSessionIds(['track-1']);

  assert.equal(removed, 1);
  assert.ok(await repo.getConversation('C1'));
  assert.equal(await repo.getConversation('C2'), null);
  assert.ok(await repo.getConversation('C3'));
});

test('a mutation appends the one channel it touched, not the whole ledger', async () => {
  const { repo, file } = await makeRepo();
  for (let i = 0; i < 20; i += 1) {
    await repo.initConversation(`C${i}`, { sessionId: `track-${i}`, sessionName: `s${i}`, backend: 'claude' });
  }
  const before = await lines(file);
  const beforeBytes = (await fs.stat(file)).size;

  await repo.beginTurn('C7', { userMessageTs: '1.1', userMessageText: 'hello' });

  const after = await lines(file);
  assert.equal(after.length, before.length + 1, 'one mutation is one line');
  const appended = JSON.parse(after[after.length - 1]);
  assert.equal(appended.op, 'put');
  assert.equal(appended.id, 'C7');
  assert.deepEqual(appended.record.turns.map((turn: { userMessageTs: string }) => turn.userMessageTs), ['1.1']);
  // The point of the whole change: a turn costs its own channel, not the store.
  const written = (await fs.stat(file)).size - beforeBytes;
  assert.ok(written < beforeBytes / 4, `appending a turn wrote ${written} bytes into a ${beforeBytes}-byte ledger`);
});

test('turns survive a restart, and a torn final line is dropped rather than replayed', async () => {
  const root = await makeDir();
  const file = path.join(root, 'conversation-ledger.jsonl');
  const first = new ConversationLedgerRepo(file);
  await first.initConversation('C1', { sessionId: 'track-1', sessionName: 'one', backend: 'claude' });
  await first.beginTurn('C1', { userMessageTs: '1.1', userMessageText: 'kept' });
  await first.completeTurn('C1', '1.1', { executionId: 'exec-1' });

  const reopened = await new ConversationLedgerRepo(file).getConversation('C1');
  assert.equal(reopened?.sessionId, 'track-1');
  assert.deepEqual(reopened?.turns.map(turn => [turn.userMessageTs, turn.status, turn.executionId]),
    [['1.1', 'completed', 'exec-1']]);

  // A process killed mid-append leaves a partial line; it is not a record yet.
  await fs.appendFile(file, '{"v":1,"op":"put","id":"C1","record":{"turns":[', 'utf8');
  const afterCrash = await new ConversationLedgerRepo(file).getConversation('C1');
  assert.deepEqual(afterCrash?.turns.map(turn => turn.status), ['completed']);
  assert.equal((await lines(file)).length, 3, 'the fragment is truncated away, whole records stay');
});

test('compaction collapses the journal to one line per channel without changing what it holds', async () => {
  let compactions = 0;
  const { repo, file } = await makeRepo({
    shouldCompact: ({ eventCount }) => eventCount > 6,
    onCompact: () => { compactions += 1; },
  });
  await repo.initConversation('C1', { sessionId: 'track-1', sessionName: 'one', backend: 'claude' });
  await repo.initConversation('C2', { sessionId: 'track-2', sessionName: 'two', backend: 'pi' });
  for (let i = 0; i < 6; i += 1) {
    await repo.beginTurn('C1', { userMessageTs: `1.${i}`, userMessageText: `turn ${i}` });
  }

  // 8 mutations, 2 channels: the journal is bounded by the live set, not by how much has happened.
  assert.equal(compactions, 1);
  assert.equal((await lines(file)).length, 3, 'one put per live channel, plus the append that followed');
  const replayed = new ConversationLedgerRepo(file);
  assert.deepEqual((await replayed.getConversation('C1'))?.turns.map(turn => turn.userMessageText),
    ['turn 0', 'turn 1', 'turn 2', 'turn 3', 'turn 4', 'turn 5']);
  assert.equal((await replayed.getConversation('C2'))?.backend, 'pi');
});

test('a retention sweep rewrites the journal once instead of appending a delete per channel', async () => {
  const { repo, file } = await makeRepo();
  for (let i = 0; i < 30; i += 1) {
    await repo.initConversation(`C${i}`, { sessionId: `track-${i}`, sessionName: `s${i}`, backend: 'claude' });
  }
  const removed = await repo.deleteExceptSessionIds(['track-0', 'track-1']);

  assert.equal(removed, 28);
  assert.equal((await lines(file)).length, 2, 'the sweep compacts rather than appending 28 deletes');
  const replayed = new ConversationLedgerRepo(file);
  assert.ok(await replayed.getConversation('C0'));
  assert.equal(await replayed.getConversation('C2'), null);
});

test('a legacy JSON ledger migrates into JSONL and keeps a backup of the original', async () => {
  const root = await makeDir();
  const file = path.join(root, 'conversation-ledger.jsonl');
  const legacy = path.join(root, 'conversation-ledger.json');
  const conversation = {
    sessionId: 'track-1', sessionName: 'one', backend: 'claude', profileName: null,
    updatedAt: '2026-09-09T00:00:00.000Z',
    turns: [{
      turnIndex: 0, userMessageTs: '1.1', userMessageText: 'legacy turn', statusMessageTs: '1.0',
      responseMessageTimestamps: ['1.2'], executionId: 'exec-1', backupPath: null,
      status: 'completed', createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:01.000Z',
    }],
  };
  await fs.writeFile(legacy, JSON.stringify({ C1: conversation }, null, 2), 'utf8');

  const migrated = await new ConversationLedgerRepo(file).getConversation('C1');

  assert.deepEqual(migrated, conversation);
  assert.equal((await lines(file)).length, 1);
  assert.equal(await fs.readFile(`${legacy}.bak`, 'utf8'), await fs.readFile(legacy, 'utf8'));
});

test('migration fails closed on a legacy ledger it cannot read, writing neither journal nor backup', async () => {
  for (const bad of [[], { C1: 'nope' }, { C1: { backend: 'claude' } }, { C1: { backend: 7, turns: [] } }]) {
    const root = await makeDir();
    const file = path.join(root, 'conversation-ledger.jsonl');
    const legacy = path.join(root, 'conversation-ledger.json');
    await fs.writeFile(legacy, JSON.stringify(bad), 'utf8');

    await assert.rejects(new ConversationLedgerRepo(file).getConversation('C1'));
    assert.equal(await fs.access(file).then(() => true, () => false), false, 'no partial journal');
    assert.equal(await fs.access(`${legacy}.bak`).then(() => true, () => false), false, 'no backup');
  }
});

test('an empty journal beside a non-empty legacy ledger is refused rather than silently accepted', async () => {
  const root = await makeDir();
  const file = path.join(root, 'conversation-ledger.jsonl');
  const legacy = path.join(root, 'conversation-ledger.json');
  await fs.writeFile(file, '', 'utf8');
  await fs.writeFile(legacy, JSON.stringify({ C1: { sessionId: null, sessionName: null, backend: 'claude', profileName: null, turns: [], updatedAt: '2026-09-09T00:00:00.000Z' } }), 'utf8');

  await assert.rejects(new ConversationLedgerRepo(file).getConversation('C1'), /hides non-empty legacy/);
});
