// input:  isolated sessions.json and bulk binding operations
// output: session binding CRUD and dangling-reference repair tests
// pos:    Verifies channel→session persistence behavior

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionRepo } from '../../src/store/session-repo.js';

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-session-repo-'));
  return new SessionRepo(path.join(root, 'sessions.json'));
}

test('deleteManyBySessionIds removes every binding whose sessionId matches', async () => {
  const repo = await makeRepo();
  await repo.setSessionAsync('C1', 'track-1', 'claude');
  await repo.setSessionAsync('C2', 'track-2', 'claude');
  await repo.setSessionAsync('C3', 'track-1', 'pi');

  const removed = await repo.deleteManyBySessionIds(['track-1']);

  assert.equal(removed, 2);
  assert.equal(await repo.getSessionAsync('C1', 'claude'), undefined);
  assert.equal(await repo.getSessionAsync('C2', 'claude'), 'track-2');
  assert.equal(await repo.getSessionAsync('C3', 'pi'), undefined);
});

test('deleteExceptSessionIds removes dangling bindings while preserving live session ids', async () => {
  const repo = await makeRepo();
  await repo.setSessionAsync('C1', 'track-1', 'claude');
  await repo.setSessionAsync('C2', 'track-2', 'claude');
  await repo.setSessionAsync('C3', 'track-3', 'pi');

  const removed = await (repo as any).deleteExceptSessionIds(['track-1', 'track-3']);

  assert.equal(removed, 1);
  assert.equal(await repo.getSessionAsync('C1', 'claude'), 'track-1');
  assert.equal(await repo.getSessionAsync('C2', 'claude'), undefined);
  assert.equal(await repo.getSessionAsync('C3', 'pi'), 'track-3');
});
