import { test, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { costRepo, formatCostReport, type CostEntry } from '../../../src/domain/costs/cost-tracker.js';

const NOW = Date.now();
const originalCostsPath = process.env.CORTEX_COSTS_FILE;
const originalBudgetPath = process.env.CORTEX_BUDGET_FILE;

let tmpDir: string;
let costsPath: string;
let budgetPath: string;

function fixtureEntry(project: string, cost_usd: number): CostEntry {
  return {
    timestamp: new Date(NOW).toISOString(),
    project,
    trigger: 'thread',
    cost_usd,
    num_turns: 1,
    duration_s: 1,
    backend: 'claude',
    mode: 'api',
    source: 'estimate',
  };
}

const globalReport = `*Cost Report*
• Today: $13.00 / $10 (remaining: $0.00)
• This month: $13.00 / $100 (remaining: $87.00)
• This week: $13.00
• Total (90d): $13.00

_By cost mode:_
  - API: today $13.00 | week $13.00 | month $13.00 | total $13.00
  - Plan: today $0.00 | week $0.00 | month $0.00 | total $0.00

_By source:_
• estimate: today $13.00 | month $13.00 | total $13.00

_By project:_
• alpha: today $6.00 | month $6.00
• beta: today $4.00 | month $4.00
• gamma: today $3.00 | month $3.00

_By trigger:_
• thread: today $13.00 | month $13.00 | total $13.00`;

const alphaReport = `*Cost Report (project: alpha)* _(per-project limits)_
• Today: $6.00 / $5 (remaining: $0.00)
• This month: $6.00 / $50 (remaining: $44.00)
• This week: $6.00
• Total (90d): $6.00

_By cost mode:_
  - API: today $6.00 | week $6.00 | month $6.00 | total $6.00
  - Plan: today $0.00 | week $0.00 | month $0.00 | total $0.00

_By source:_
• estimate: today $13.00 | month $13.00 | total $13.00

_By trigger:_
• thread: today $13.00 | month $13.00 | total $13.00`;

const betaReport = `*Cost Report (project: beta)* _(inherited global limits)_
• Today: $4.00 / $10 (remaining: $6.00)
• This month: $4.00 / $100 (remaining: $96.00)
• This week: $4.00
• Total (90d): $4.00

_By cost mode:_
  - API: today $4.00 | week $4.00 | month $4.00 | total $4.00
  - Plan: today $0.00 | week $0.00 | month $0.00 | total $0.00

_By source:_
• estimate: today $13.00 | month $13.00 | total $13.00

_By trigger:_
• thread: today $13.00 | month $13.00 | total $13.00`;

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-cost-report-test-'));
  costsPath = path.join(tmpDir, 'costs.jsonl');
  budgetPath = path.join(tmpDir, 'budget.json');
  await fs.writeFile(costsPath, [
    fixtureEntry('alpha', 6),
    fixtureEntry('beta', 4),
    fixtureEntry('gamma', 3),
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  await fs.writeFile(budgetPath, JSON.stringify({
    daily_usd: 10,
    monthly_usd: 100,
    projects: { alpha: { daily_usd: 5, monthly_usd: 50 } },
  }));
  process.env.CORTEX_COSTS_FILE = costsPath;
  process.env.CORTEX_BUDGET_FILE = budgetPath;
  costRepo._testReset();
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (originalCostsPath === undefined) delete process.env.CORTEX_COSTS_FILE;
  else process.env.CORTEX_COSTS_FILE = originalCostsPath;
  if (originalBudgetPath === undefined) delete process.env.CORTEX_BUDGET_FILE;
  else process.env.CORTEX_BUDGET_FILE = originalBudgetPath;
  costRepo._testReset();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('formats the global fixed-fixture report and clamps an over-budget remainder', async () => {
  assert.equal(await formatCostReport(), globalReport);
});

test('formats a project override report and clamps its over-budget remainder', async () => {
  assert.equal(await formatCostReport('alpha'), alphaReport);
});

test('formats a project report with inherited global limits', async () => {
  assert.equal(await formatCostReport('beta'), betaReport);
});

test('aggregates cost entries once per formatted report', async () => {
  const readCosts = vi.spyOn(costRepo, 'readCosts');
  await formatCostReport('alpha');
  assert.equal(readCosts.mock.calls.length, 1);
});
