import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationLedgerRepo } from '../../src/store/conversation-ledger-repo.js';
import { SessionRegistryRepo } from '../../src/store/session-registry-repo.js';

// The ledger is now a façade over the session registry — back it with a real registry over a temp
// JSONL file, exactly as production wires conversationLedger onto sessionStore.
async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-ledger-'));
  const registry = new SessionRegistryRepo(path.join(root, 'session-registry.jsonl'));
  return new ConversationLedgerRepo(registry);
}

test('the registry releases every channel conversation whose sessionId matches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-ledger-'));
  const registry = new SessionRegistryRepo(path.join(root, 'session-registry.jsonl'));
  const repo = new ConversationLedgerRepo(registry);
  await repo.initConversation('C1', { sessionId: 'track-1', backend: 'claude' });
  await repo.initConversation('C2', { sessionId: 'track-2', backend: 'claude' });
  await repo.initConversation('C3', { sessionId: 'track-1', backend: 'pi' });

  const released = await registry.releaseChannels(['track-1']);

  assert.equal(released, 2);
  assert.equal(await repo.getConversation('C1'), null);
  assert.ok(await repo.getConversation('C2'));
  assert.equal(await repo.getConversation('C3'), null);
});
