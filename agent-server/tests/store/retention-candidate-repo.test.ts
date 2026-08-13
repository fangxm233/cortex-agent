// input:  temp repo path and retention candidate store
// output: retention candidate persistence and two-sweep contract tests
// pos:    Verifies orphan retention candidate durability
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RetentionCandidateRepo } from '../../src/store/retention-candidate-repo.js';

test('retention candidates persist by category+key and survive repo reloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-retention-candidates-'));
  const filePath = path.join(root, 'retention-candidates.json');
  const repo = new RetentionCandidateRepo(filePath);

  await repo.mark('history', 'track-1', 1000);
  await repo.mark('pi', 'backend-1', 2000);

  const reopened = new RetentionCandidateRepo(filePath);
  assert.equal(await reopened.isConfirmed('history', 'track-1', 1000), true);
  assert.equal(await reopened.isConfirmed('pi', 'backend-1', 2000), true);
  assert.equal(await reopened.isConfirmed('pi', 'backend-1', 2001), false);
});

test('retention candidates clear one key or a whole category', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-retention-candidates-'));
  const filePath = path.join(root, 'retention-candidates.json');
  const repo = new RetentionCandidateRepo(filePath);

  await repo.mark('history', 'track-1', 1000);
  await repo.mark('history', 'track-2', 1000);
  await repo.mark('pi', 'backend-1', 1000);

  await repo.clear('history', 'track-1');
  assert.equal(await repo.isConfirmed('history', 'track-1', 1000), false);
  assert.equal(await repo.isConfirmed('history', 'track-2', 1000), true);

  await repo.clearCategory('history');
  assert.equal(await repo.isConfirmed('history', 'track-2', 1000), false);
  assert.equal(await repo.isConfirmed('pi', 'backend-1', 1000), true);
});
