// input:  ../_test-home, vitest, tmp fs, CommissionRepo
// output: commission registry CRUD and corrupt-file fallback tests
// pos:    Commission registry persistence contract
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../_test-home.js';
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommissionRepo, type CommissionRecord } from '../../src/store/commission-repo.js';

let tmpDir = '';
let testId = 0;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-commission-repo-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function nextFile(): string {
  return path.join(tmpDir, `commissions-${testId++}.json`);
}

function record(id: string, extra: Partial<CommissionRecord> = {}): CommissionRecord {
  return {
    id,
    projectId: 'proj',
    slug: `slug-${id}`,
    title: `Commission ${id}`,
    status: 'active',
    createdAt: 1000,
    updatedAt: 1000,
    ...extra,
  };
}

test('commission repo round-trips add, find, findBySlug and list scoping', async () => {
  const filePath = nextFile();
  const repo = new CommissionRepo(filePath);
  await repo.add(record('aaaa1111'));
  await repo.add(record('bbbb2222', { projectId: 'other', updatedAt: 2000 }));

  assert.equal((await repo.find('aaaa1111'))?.slug, 'slug-aaaa1111');
  assert.equal((await repo.findBySlug('proj', 'slug-aaaa1111'))?.id, 'aaaa1111');
  assert.equal(await repo.findBySlug('proj', 'slug-bbbb2222'), null);
  assert.deepEqual((await repo.list('proj')).map(c => c.id), ['aaaa1111']);
  assert.deepEqual((await repo.list()).map(c => c.id), ['bbbb2222', 'aaaa1111']);

  const reopened = new CommissionRepo(filePath);
  assert.equal((await reopened.find('bbbb2222'))?.projectId, 'other');
});

test('commission repo update mutates status, bumps updatedAt, and misses return null', async () => {
  const repo = new CommissionRepo(nextFile());
  await repo.add(record('cccc3333'));

  const updated = await repo.update('cccc3333', (c) => {
    c.status = 'done';
    c.closedAt = 5000;
    c.closeNote = 'shipped';
  });
  assert.equal(updated?.status, 'done');
  assert.ok((updated?.updatedAt ?? 0) > 1000);
  assert.equal(await repo.update('missing', () => {}), null);
});

test('commission repo falls back to empty data on foreign JSON shape', async () => {
  const filePath = nextFile();
  await fs.writeFile(filePath, JSON.stringify({ something: 'else' }));
  const repo = new CommissionRepo(filePath);
  assert.deepEqual(await repo.list(), []);
});
