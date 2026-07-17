// input:  Node test runner, assert, tmp filesystem
// output: regression tests for JsonRepository (concurrent mutate, atomic write, cache consistency)
// pos:    verifies store/ layer S1 guarantees
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JsonRepository } from '../../src/core/json-repository.js';
import { atomicWrite } from '../../src/core/atomic-write.js';

// ── Shared tmp directory ───────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-store-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Group 1: concurrent mutate ─────────────────────────────────

test('mutate - 10 concurrent increments produce count === 10 (no lost updates)', async () => {
  const filePath = path.join(tmpDir, 'counter.json');
  const repo = new JsonRepository<{ count: number }>({
    filePath,
    defaultValue: () => ({ count: 0 }),
  });

  await Promise.all(
    Array.from({ length: 10 }, () =>
      repo.mutate(cur => ({ next: { count: cur.count + 1 }, result: undefined }))
    )
  );

  const final = await repo.read();
  assert.equal(final.count, 10);
});

test('mutate - returns the result value from the transform function', async () => {
  const filePath = path.join(tmpDir, 'result-check.json');
  const repo = new JsonRepository<{ v: number }>({
    filePath,
    defaultValue: () => ({ v: 0 }),
  });

  const r = await repo.mutate(cur => ({ next: { v: cur.v + 7 }, result: cur.v + 7 }));
  assert.equal(r, 7);
});

// ── Group 2: atomic write / mid-write crash simulation ─────────

test('atomicWrite - no .tmp. files remain after successful write', async () => {
  const filePath = path.join(tmpDir, 'clean-write.json');
  await atomicWrite(filePath, JSON.stringify({ ok: true }));

  const entries = await fs.readdir(tmpDir);
  const leftovers = entries.filter(e => e.includes('.tmp.'));
  assert.equal(leftovers.length, 0, `unexpected tmp files: ${leftovers.join(', ')}`);
});

test('atomicWrite - crash-leftover .tmp.* sibling does not affect original or next write', async () => {
  const filePath = path.join(tmpDir, 'crash-sim.json');

  // Write initial content atomically
  await atomicWrite(filePath, JSON.stringify({ v: 1 }));

  // Simulate a crash: a leftover tmp file (written but never renamed)
  const leftoverTmp = `${filePath}.tmp.99999.00000`;
  await fs.writeFile(leftoverTmp, 'CORRUPTED PARTIAL DATA', 'utf8');

  // Original file must be intact despite the leftover
  const originalContent = await fs.readFile(filePath, 'utf8');
  assert.deepEqual(JSON.parse(originalContent), { v: 1 });

  // A subsequent normal write must succeed and overwrite the final path
  await atomicWrite(filePath, JSON.stringify({ v: 2 }));
  const newContent = await fs.readFile(filePath, 'utf8');
  assert.deepEqual(JSON.parse(newContent), { v: 2 });

  // Clean up the leftover tmp (mirrors what a real crash recovery would do)
  await fs.unlink(leftoverTmp).catch(() => {});
});

test('JsonRepository.write - produced file is valid JSON parseable independently', async () => {
  const filePath = path.join(tmpDir, 'roundtrip.json');
  const repo = new JsonRepository<{ items: string[] }>({
    filePath,
    defaultValue: () => ({ items: [] }),
  });

  const payload = { items: ['a', 'b', 'c'] };
  await repo.write(payload);

  const raw = await fs.readFile(filePath, 'utf8');
  assert.deepEqual(JSON.parse(raw), payload);
});

// ── Group 3: cache consistency ─────────────────────────────────

test('cache - write(A) then external modification is invisible until invalidate()', async () => {
  const filePath = path.join(tmpDir, 'cache-consistency.json');
  const repo = new JsonRepository<{ x: number }>({
    filePath,
    defaultValue: () => ({ x: 0 }),
  });

  await repo.write({ x: 42 });

  // External modification bypassing the repo
  await fs.writeFile(filePath, JSON.stringify({ x: 99 }), 'utf8');

  // Cache should still serve 42
  const cached = await repo.read();
  assert.equal(cached.x, 42);

  // After invalidate, disk value is picked up
  repo.invalidate();
  const fresh = await repo.read();
  assert.equal(fresh.x, 99);
});

test('cache - mutate result is immediately visible in subsequent read()', async () => {
  const filePath = path.join(tmpDir, 'mutate-cache.json');
  const repo = new JsonRepository<{ n: number }>({
    filePath,
    defaultValue: () => ({ n: 0 }),
  });

  await repo.mutate(cur => ({ next: { n: cur.n + 5 }, result: undefined }));
  const val = await repo.read();
  assert.equal(val.n, 5);
});

test('cache - new instance with same file reads from disk (no shared cache)', async () => {
  const filePath = path.join(tmpDir, 'no-shared-cache.json');

  const repo1 = new JsonRepository<{ tag: string }>({
    filePath,
    defaultValue: () => ({ tag: 'default' }),
  });
  await repo1.write({ tag: 'written-by-repo1' });

  // repo2 is a fresh instance — must read from disk, not from repo1's cache
  const repo2 = new JsonRepository<{ tag: string }>({
    filePath,
    defaultValue: () => ({ tag: 'default' }),
  });
  const val = await repo2.read();
  assert.equal(val.tag, 'written-by-repo1');
});

test('cache - missing file returns defaultValue() without error', async () => {
  const filePath = path.join(tmpDir, 'nonexistent-file.json');
  const repo = new JsonRepository<{ empty: boolean }>({
    filePath,
    defaultValue: () => ({ empty: true }),
  });

  const val = await repo.read();
  assert.equal(val.empty, true);
});

// ── Group 4: orphan sweep + flush (graceful-SIGTERM safety) ─────

test('sweepOrphans - first I/O op removes leftover .tmp.* siblings from a prior crashed write', async () => {
  const filePath = path.join(tmpDir, 'sweep-target.json');
  await atomicWrite(filePath, JSON.stringify({ v: 'real' }));

  // Simulate orphan tmp files left by a previous process crashed mid-atomicWrite.
  const orphanA = `${filePath}.tmp.99998.1111111`;
  const orphanB = `${filePath}.tmp.99997.2222222`;
  await fs.writeFile(orphanA, 'PARTIAL-A', 'utf8');
  await fs.writeFile(orphanB, 'PARTIAL-B', 'utf8');

  // Construction alone does not sweep — sweep happens on first read/write.
  const repo = new JsonRepository<{ v: string }>({ filePath, defaultValue: () => ({ v: '' }) });

  // Any I/O op triggers the lazy sweep.
  const val = await repo.read();
  assert.equal(val.v, 'real', 'real file must be read correctly');

  const entries = await fs.readdir(tmpDir);
  const survivors = entries.filter(e => e.startsWith('sweep-target.json.tmp.'));
  assert.equal(survivors.length, 0, `orphan .tmp.* siblings should have been swept: ${survivors.join(', ')}`);

  // Unrelated files in the same dir must not be touched.
  const realStill = await fs.readFile(filePath, 'utf8');
  assert.deepEqual(JSON.parse(realStill), { v: 'real' });
});

test('sweepOrphans - only targets filePath-specific .tmp.*, not other repos sharing the dir', async () => {
  const targetA = path.join(tmpDir, 'sweep-isolate-A.json');
  const targetB = path.join(tmpDir, 'sweep-isolate-B.json');
  await atomicWrite(targetA, JSON.stringify({ k: 'A' }));
  await atomicWrite(targetB, JSON.stringify({ k: 'B' }));

  // Orphan belongs to B
  const orphanForB = `${targetB}.tmp.1.1`;
  await fs.writeFile(orphanForB, 'partial', 'utf8');

  // Constructing a repo for A must NOT touch B's orphan
  const repoA = new JsonRepository<{ k: string }>({ filePath: targetA, defaultValue: () => ({ k: '' }) });
  await repoA.read();

  const still = await fs.readFile(orphanForB, 'utf8');
  assert.equal(still, 'partial', 'other-repo orphan must not be swept');

  // And B's repo correctly sweeps its own
  const repoB = new JsonRepository<{ k: string }>({ filePath: targetB, defaultValue: () => ({ k: '' }) });
  await repoB.read();
  await assert.rejects(() => fs.readFile(orphanForB, 'utf8'), /ENOENT/);
});

test('flush - FIFO: resolves only after every pending mutate has finished (and its rename landed)', async () => {
  const filePath = path.join(tmpDir, 'flush-target.json');
  const repo = new JsonRepository<{ v: number }>({
    filePath,
    defaultValue: () => ({ v: 0 }),
  });

  const resolutionOrder: string[] = [];
  const N = 10;

  // Enqueue N concurrent mutates; mutex serializes them FIFO.
  const mutations = Array.from({ length: N }, (_, i) =>
    repo.mutate(cur => ({ next: { v: cur.v + 1 }, result: undefined }))
      .then(() => { resolutionOrder.push(`mut-${i}`); })
  );

  // flush() enqueued after all mutations must land last in the mutex queue.
  const flushDone = repo.flush().then(() => { resolutionOrder.push('flush'); });

  await Promise.all([...mutations, flushDone]);

  assert.equal(resolutionOrder[N], 'flush',
    `flush must be last; got ${resolutionOrder.join(', ')}`);
  // Each mutate's rename has landed: final on-disk value == N increments.
  const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(onDisk.v, N, 'all N writes persisted before flush resolved');
});

test('flush - resolves immediately when nothing is pending', async () => {
  const filePath = path.join(tmpDir, 'flush-idle.json');
  const repo = new JsonRepository<{ v: number }>({
    filePath,
    defaultValue: () => ({ v: 0 }),
  });
  await repo.write({ v: 5 });

  const t0 = Date.now();
  await repo.flush();
  const dt = Date.now() - t0;
  assert.ok(dt < 50, `idle flush took ${dt}ms; expected near-instant`);
});

// ── Group 5: existing tests ─────────────────────────────────────

test('migrate - migrate() is applied on disk read and result is cached', async () => {
  const filePath = path.join(tmpDir, 'migrate.json');

  // Write a legacy format directly (without using the repo)
  await fs.writeFile(filePath, JSON.stringify({ legacyField: 'hello' }), 'utf8');

  const repo = new JsonRepository<{ value: string }>({
    filePath,
    defaultValue: () => ({ value: '' }),
    migrate: (raw: any) => ({ value: raw.legacyField ?? '' }),
  });

  const val = await repo.read();
  assert.equal(val.value, 'hello');

  // Second read should return from cache, not re-run migrate
  const val2 = await repo.read();
  assert.equal(val2.value, 'hello');
});
