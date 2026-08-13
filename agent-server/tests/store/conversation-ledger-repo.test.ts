// input:  isolated ledger JSON file and conversation turn operations
// output: conversation ledger CRUD and bulk clear tests
// pos:    Verifies turn mapping persistence behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationLedgerRepo } from '../../src/store/conversation-ledger-repo.js';

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-ledger-'));
  return new ConversationLedgerRepo(path.join(root, 'conversation-ledger.json'));
}

test('clearBySessionIds removes every channel conversation whose sessionId matches', async () => {
  const repo = await makeRepo();
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
  const repo = await makeRepo();
  await repo.initConversation('C1', { sessionId: 'track-1', sessionName: 'one', backend: 'claude' });
  await repo.initConversation('C2', { sessionId: 'track-2', sessionName: 'two', backend: 'claude' });
  await repo.initConversation('C3', { sessionId: null, sessionName: 'none', backend: 'claude' });

  const removed = await (repo as any).deleteExceptSessionIds(['track-1']);

  assert.equal(removed, 1);
  assert.ok(await repo.getConversation('C1'));
  assert.equal(await repo.getConversation('C2'), null);
  assert.ok(await repo.getConversation('C3'));
});
