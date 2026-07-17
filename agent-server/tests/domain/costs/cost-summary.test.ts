// input:  getCostSummary + costRepo (env-pointed temp costs.jsonl / budget.json)
// output: unit tests for the additive cost-summary fields (dailyBudget / forecastToday /
//         dailyCost 14-day series / byTriggerScoped project-scoped where-it-goes)
// pos:    verifies domain/costs/cost-tracker.ts getCostSummary real-data extensions (task c489)

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getCostSummary, costRepo, type CostEntry } from '../../../src/domain/costs/cost-tracker.js';

// Fixed clock captured once so seeded day-offsets stay within the 90-day prune window (prune uses
// the real Date.now()) AND the elapsed-fraction forecast is deterministic for the run.
const NOW = Date.now();

let tmpDir: string;
let costsPath: string;
let budgetPath: string;

// ── local-calendar-day helpers (mirror the impl's day boundaries) ──
function localMidnight(now: number): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}
/** ISO timestamp at local noon of (today - offsetDays) — noon avoids midnight/tz edge cases. */
function dayNoonIso(now: number, offsetDays: number): string {
  const d = localMidnight(now);
  d.setDate(d.getDate() - offsetDays);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}
function ymdLocal(now: number, offsetDays: number): string {
  const d = localMidnight(now);
  d.setDate(d.getDate() - offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function makeEntry(o: Partial<CostEntry> & { timestamp: string; project: string; trigger: string; cost_usd: number }): CostEntry {
  return {
    num_turns: 1, duration_s: 1, backend: 'claude', mode: 'api', source: 'estimate',
    ...o,
  };
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-cost-summary-test-'));
  costsPath = path.join(tmpDir, 'costs.jsonl');
  budgetPath = path.join(tmpDir, 'budget.json');

  // Seed: 'orchard' spread over several calendar days + one out-of-window entry; a foreign
  // 'atlas' entry today to prove project scoping of the 14-day series + byTriggerScoped.
  const entries: CostEntry[] = [
    makeEntry({ timestamp: dayNoonIso(NOW, 0), project: 'orchard', trigger: 'thread', cost_usd: 1.0 }),
    makeEntry({ timestamp: dayNoonIso(NOW, 0), project: 'orchard', trigger: 'session', cost_usd: 0.5 }),
    makeEntry({ timestamp: dayNoonIso(NOW, 1), project: 'orchard', trigger: 'thread', cost_usd: 2.0 }),
    makeEntry({ timestamp: dayNoonIso(NOW, 5), project: 'orchard', trigger: 'schedule', cost_usd: 3.0 }),
    makeEntry({ timestamp: dayNoonIso(NOW, 13), project: 'orchard', trigger: 'thread', cost_usd: 4.0 }),
    makeEntry({ timestamp: dayNoonIso(NOW, 20), project: 'orchard', trigger: 'thread', cost_usd: 9.0 }), // outside 14-day window
    makeEntry({ timestamp: dayNoonIso(NOW, 0), project: 'atlas', trigger: 'thread', cost_usd: 7.0 }),   // foreign project
  ];
  await fs.writeFile(costsPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  await fs.writeFile(budgetPath, JSON.stringify({ daily_usd: 50, monthly_usd: 1200 }));

  process.env.CORTEX_COSTS_FILE = costsPath;
  process.env.CORTEX_BUDGET_FILE = budgetPath;
  costRepo._testReset(); // re-resolve paths from the env vars set above
});

afterAll(async () => {
  delete process.env.CORTEX_COSTS_FILE;
  delete process.env.CORTEX_BUDGET_FILE;
  costRepo._testReset();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('dailyBudget comes from budget.json daily_usd', async () => {
  const s = await getCostSummary('orchard', { now: NOW });
  assert.equal(s.dailyBudget, 50);
});

test('forecastToday = today spend extrapolated by elapsed fraction of the local day', async () => {
  const s = await getCostSummary('orchard', { now: NOW });
  const fraction = (NOW - localMidnight(NOW).getTime()) / 86_400_000;
  const expected = fraction > 0 ? 1.5 / fraction : 1.5; // orchard today = 1.0 + 0.5 (atlas 7.0 excluded)
  assert.ok(Math.abs(s.forecastToday - expected) < 1e-9, `forecastToday=${s.forecastToday} expected≈${expected}`);
});

test('forecastToday is 0 when there is no spend today', async () => {
  const s = await getCostSummary('no-such-project', { now: NOW });
  assert.equal(s.forecastToday, 0);
});

test('dailyCost is a 14-point dated series ending today, project-scoped, zero-filled', async () => {
  const s = await getCostSummary('orchard', { now: NOW });
  assert.equal(s.dailyCost.length, 14);
  // contiguous dates oldest → newest, last = today
  for (let i = 0; i < 14; i++) {
    assert.equal(s.dailyCost[i].date, ymdLocal(NOW, 13 - i), `point ${i} date`);
  }
  const byDate = new Map(s.dailyCost.map(p => [p.date, p.cost]));
  assert.equal(byDate.get(ymdLocal(NOW, 0)), 1.5, 'today = 1.0 + 0.5 (atlas excluded)');
  assert.equal(byDate.get(ymdLocal(NOW, 1)), 2.0);
  assert.equal(byDate.get(ymdLocal(NOW, 5)), 3.0);
  assert.equal(byDate.get(ymdLocal(NOW, 13)), 4.0);
  assert.equal(byDate.get(ymdLocal(NOW, 2)), 0, 'gap day zero-filled');
  // out-of-window entry (today-20) must not leak into the series
  const total = s.dailyCost.reduce((a, p) => a + p.cost, 0);
  assert.ok(Math.abs(total - (1.5 + 2.0 + 3.0 + 4.0)) < 1e-9, `series total=${total}`);
});

test('byTriggerScoped is project-scoped (excludes foreign projects); global byTrigger still includes them', async () => {
  const s = await getCostSummary('orchard', { now: NOW });
  // scoped: only orchard entries
  assert.equal(s.byTriggerScoped.thread.today, 1.0, 'orchard thread today (atlas 7.0 excluded)');
  assert.ok(Math.abs(s.byTriggerScoped.thread.total - (1.0 + 2.0 + 4.0 + 9.0)) < 1e-9, 'orchard thread total');
  assert.equal(s.byTriggerScoped.session.today, 0.5);
  assert.equal(s.byTriggerScoped.schedule.total, 3.0);
  assert.ok(!('atlas-only-trigger' in s.byTriggerScoped));
  // invariant preserved: global byTrigger still counts the foreign atlas entry today
  assert.equal(s.byTrigger.thread.today, 1.0 + 7.0, 'global byTrigger includes atlas');
});
