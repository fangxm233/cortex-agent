// input:  Node test runner, assert, tmp filesystem
// output: regression tests for CostRepo (concurrent recordEntry, 90-day prune, flush ordering)
// pos:    verifies store/cost-repo.ts Pattern A guarantees
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CostRepo } from '../../src/store/cost-repo.js';
import type { CostEntry } from '../../src/domain/costs/cost-tracker.js';

// ── Shared tmp directory ───────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-cost-repo-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helper: fresh repo + file per test ─────────────────────────

let _testIdx = 0;
function createRepo(): { repo: CostRepo; costsPath: string; budgetPath: string } {
  const idx = _testIdx++;
  const costsPath = path.join(tmpDir, `costs-${idx}.json`);
  const budgetPath = path.join(tmpDir, `budget-${idx}.json`);
  return { repo: new CostRepo({ costsPath, budgetPath }), costsPath, budgetPath };
}

function makeEntry(overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    timestamp: new Date().toISOString(),
    project: 'proj-test',
    trigger: 'user',
    cost_usd: 0.01,
    num_turns: 1,
    duration_s: 1.0,
    backend: 'claude',
    mode: 'api',
    source: 'estimate',
    ...overrides,
  };
}

// ── Concurrent recordEntry: no lost entries ────────────────────

test('CostRepo - 10 concurrent recordEntry produce all 10 entries', async () => {
  const { repo } = createRepo();

  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      repo.recordEntry(makeEntry({ cost_usd: i + 0.1, trigger: `t-${i}` }))
    )
  );

  const data = await repo.readCosts();
  assert.equal(data.entries.length, 10, 'all 10 entries should be recorded');
  const triggers = new Set(data.entries.map(e => e.trigger));
  assert.equal(triggers.size, 10, 'each trigger should appear exactly once');
});

// ── Batch: recordEntryBatch writes atomically ──────────────────

test('CostRepo - recordEntryBatch writes multiple entries in one mutate', async () => {
  const { repo } = createRepo();

  await repo.recordEntryBatch([
    makeEntry({ trigger: 'b1' }),
    makeEntry({ trigger: 'b2' }),
    makeEntry({ trigger: 'b3' }),
  ]);

  const data = await repo.readCosts();
  assert.equal(data.entries.length, 3);
  assert.deepEqual(data.entries.map(e => e.trigger), ['b1', 'b2', 'b3']);
});

test('CostRepo - recordEntryBatch on empty array is a no-op', async () => {
  const { repo } = createRepo();
  await repo.recordEntryBatch([]);
  const data = await repo.readCosts();
  assert.equal(data.entries.length, 0);
});

// ── 90-day prune: startup prune drops stale entries ───────────

test('CostRepo - startup prunes entries older than 90 days', async () => {
  const { costsPath, budgetPath } = createRepo();

  const now = Date.now();
  const recent = new Date(now - 10 * 24 * 3600 * 1000).toISOString(); // 10 days ago
  const stale = new Date(now - 100 * 24 * 3600 * 1000).toISOString(); // 100 days ago

  // Seed the file directly in JSONL format (bypasses startup prune).
  await fs.writeFile(costsPath, [
    JSON.stringify(makeEntry({ timestamp: recent, trigger: 'keep-1' })),
    JSON.stringify(makeEntry({ timestamp: stale, trigger: 'drop-1' })),
    JSON.stringify(makeEntry({ timestamp: recent, trigger: 'keep-2' })),
    JSON.stringify(makeEntry({ timestamp: stale, trigger: 'drop-2' })),
  ].join('\n') + '\n');

  // Fresh repo triggers startup prune on first I/O.
  const repo = new CostRepo({ costsPath, budgetPath });
  const data = await repo.readCosts();
  const triggers = data.entries.map(e => e.trigger).sort();
  assert.deepEqual(triggers, ['keep-1', 'keep-2'], 'only non-stale entries remain');
});

test('CostRepo - subsequent recordEntry prunes prior stale entries', async () => {
  const { costsPath } = createRepo();
  // Seed the file directly with a stale entry that bypasses prune (JSONL format).
  const stale = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
  await fs.writeFile(
    costsPath,
    JSON.stringify(makeEntry({ timestamp: stale, trigger: 'pre-existing-stale' })) + '\n'
  );

  const repo = new CostRepo({ costsPath, budgetPath: path.join(tmpDir, `budget-extra-${_testIdx++}.json`) });
  // A fresh recordEntry must prune the seeded stale entry in the same mutate.
  await repo.recordEntry(makeEntry({ trigger: 'fresh' }));

  const data = await repo.readCosts();
  assert.equal(data.entries.length, 1, 'stale entries pruned by fresh recordEntry');
  assert.equal(data.entries[0].trigger, 'fresh');
});

// ── Flush: mid-mutate flush resolves only after pending work ───

test('CostRepo - flush() resolves only after all pending mutations (FIFO on mutex)', async () => {
  const { repo } = createRepo();

  const resolutionOrder: string[] = [];
  const N = 10;

  const mutations = Array.from({ length: N }, (_, i) =>
    repo.recordEntry(makeEntry({ trigger: `m-${i}` }))
      .then(() => { resolutionOrder.push(`mut-${i}`); })
  );

  const flushDone = repo.flush().then(() => { resolutionOrder.push('flush'); });

  await Promise.all([...mutations, flushDone]);

  assert.equal(
    resolutionOrder[N],
    'flush',
    `flush must be last; got ${resolutionOrder.join(', ')}`,
  );
});

test('CostRepo - flush() on idle repo resolves immediately', async () => {
  const { repo } = createRepo();
  // Exercise the repo so its internal _repo is initialized.
  await repo.recordEntry(makeEntry({ trigger: 'init' }));
  // Now flush with no pending work.
  await repo.flush();
});

// ── Budget: read/write roundtrip + defaults ───────────────────

test('CostRepo - readBudget returns defaults when file is missing', async () => {
  const { repo } = createRepo();
  const budget = await repo.readBudget();
  assert.equal(budget.daily_usd, 300);
  assert.equal(budget.monthly_usd, 8000);
});

test('CostRepo - writeBudget persists and readBudget returns the value', async () => {
  const { repo } = createRepo();
  await repo.writeBudget({ daily_usd: 42, monthly_usd: 999 });
  const budget = await repo.readBudget();
  assert.equal(budget.daily_usd, 42);
  assert.equal(budget.monthly_usd, 999);
});

test('CostRepo - readBudget fills missing fields from DEFAULT_BUDGET', async () => {
  const { costsPath, budgetPath } = createRepo();
  // Partial budget.json — only daily_usd set.
  await fs.writeFile(budgetPath, JSON.stringify({ daily_usd: 7 }));
  const repo = new CostRepo({ costsPath, budgetPath });
  const budget = await repo.readBudget();
  assert.equal(budget.daily_usd, 7);
  assert.equal(budget.monthly_usd, 8000, 'missing monthly_usd filled from DEFAULT_BUDGET');
});

// ── On-disk schema: JSONL format ──────────────────────────────

test('CostRepo - on-disk schema is JSONL (one CostEntry per line)', async () => {
  const { repo, costsPath } = createRepo();
  await repo.recordEntry(makeEntry({ trigger: 'schema-check' }));
  await repo.flush();

  const raw = await fs.readFile(costsPath, 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 1, 'one line per entry');
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.trigger, 'schema-check');
  assert.equal(parsed.backend, 'claude');
  assert.equal(parsed.source, 'estimate');
});
