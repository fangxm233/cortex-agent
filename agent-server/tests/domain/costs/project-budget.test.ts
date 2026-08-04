// input:  pickBudget / getCostSummary / checkBudget / setBudget / clearProjectBudget /
//         listProjectBudgets against an env-pointed temp costs.jsonl + budget.json
// output: unit tests for per-project budget resolution and editing
// pos:    verifies domain/costs/cost-tracker.ts budget scoping (plan/per-project-budget.md)

import { test, describe, beforeEach, afterAll, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  pickBudget, getCostSummary, checkBudget, setBudget, clearProjectBudget, listProjectBudgets,
  costRepo, type BudgetConfig, type CostEntry,
} from '../../../src/domain/costs/cost-tracker.js';

const NOW = Date.now();

let tmpDir: string;
let costsPath: string;
let budgetPath: string;

function nowIso(): string {
  const d = new Date(NOW);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

function entry(project: string, cost_usd: number): CostEntry {
  return {
    timestamp: nowIso(), project, trigger: 'thread', cost_usd,
    num_turns: 1, duration_s: 1, backend: 'claude', mode: 'api', source: 'estimate',
  };
}

async function seed(budget: Partial<BudgetConfig>, entries: CostEntry[]): Promise<void> {
  await fs.writeFile(costsPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  await fs.writeFile(budgetPath, JSON.stringify({ daily_usd: 100, monthly_usd: 2000, ...budget }));
  costRepo._testReset();
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-project-budget-test-'));
  costsPath = path.join(tmpDir, 'costs.jsonl');
  budgetPath = path.join(tmpDir, 'budget.json');
  process.env.CORTEX_COSTS_FILE = costsPath;
  process.env.CORTEX_BUDGET_FILE = budgetPath;
  costRepo._testReset();
});

afterAll(async () => {
  delete process.env.CORTEX_COSTS_FILE;
  delete process.env.CORTEX_BUDGET_FILE;
  costRepo._testReset();
});

// ── pickBudget: the pure resolution rule ──────────────────────

describe('pickBudget', () => {
  const config: BudgetConfig = {
    daily_usd: 100, monthly_usd: 2000,
    projects: { alpha: { daily_usd: 5, monthly_usd: 80 } },
  };

  test('a project with an override gets its own limits', () => {
    expect(pickBudget(config, 'alpha')).toEqual({ daily_usd: 5, monthly_usd: 80, scope: 'project' });
  });

  test('a project without an override inherits BOTH globals', () => {
    expect(pickBudget(config, 'beta')).toEqual({ daily_usd: 100, monthly_usd: 2000, scope: 'global' });
  });

  test('no project id at all is the global view', () => {
    expect(pickBudget(config, null)).toEqual({ daily_usd: 100, monthly_usd: 2000, scope: 'global' });
    expect(pickBudget(config, undefined).scope).toBe('global');
  });

  test('a config with no projects map does not throw', () => {
    const legacy = { daily_usd: 100, monthly_usd: 2000 } as BudgetConfig;
    expect(pickBudget(legacy, 'alpha').scope).toBe('global');
  });
});

// ── getCostSummary: scoped denominators ───────────────────────

describe('getCostSummary budget denominators', () => {
  test('a project-scoped summary reports the project override as its denominators', async () => {
    await seed({ projects: { alpha: { daily_usd: 5, monthly_usd: 80 } } }, [entry('alpha', 1)]);
    const s = await getCostSummary('alpha', { now: NOW });
    expect(s.dailyBudget).toBe(5);
    expect(s.monthlyBudget).toBe(80);
    expect(s.budgetScope).toBe('project');
  });

  test('a project without an override falls back to the globals', async () => {
    await seed({ projects: { alpha: { daily_usd: 5, monthly_usd: 80 } } }, [entry('beta', 1)]);
    const s = await getCostSummary('beta', { now: NOW });
    expect(s.dailyBudget).toBe(100);
    expect(s.monthlyBudget).toBe(2000);
    expect(s.budgetScope).toBe('global');
  });

  test('the unscoped summary always reports the globals', async () => {
    await seed({ projects: { alpha: { daily_usd: 5, monthly_usd: 80 } } }, [entry('alpha', 1)]);
    const s = await getCostSummary(null, { now: NOW });
    expect(s.dailyBudget).toBe(100);
    expect(s.budgetScope).toBe('global');
  });
});

// ── checkBudget: scoped spend vs scoped limits ────────────────

describe('checkBudget', () => {
  test('scopes both the spend and the limits to the project', async () => {
    await seed(
      { projects: { alpha: { daily_usd: 5, monthly_usd: 80 } } },
      [entry('alpha', 2), entry('beta', 50)],
    );
    const b = await checkBudget('alpha');
    expect(b.project).toBe('alpha');
    expect(b.scope).toBe('project');
    expect(b.dailyBudget).toBe(5);
    expect(b.dailySpent).toBe(2);              // beta's 50 excluded
    expect(b.dailyRemaining).toBe(3);
    expect(b.withinBudget).toBe(true);
  });

  test('reports over-budget without enforcing anything', async () => {
    await seed({ projects: { alpha: { daily_usd: 5, monthly_usd: 80 } } }, [entry('alpha', 9)]);
    const b = await checkBudget('alpha');
    expect(b.withinBudget).toBe(false);
    expect(b.dailyRemaining).toBe(0);          // clamped, never negative
  });

  test('the no-arg form stays the global view over all projects', async () => {
    await seed(
      { projects: { alpha: { daily_usd: 5, monthly_usd: 80 } } },
      [entry('alpha', 2), entry('beta', 50)],
    );
    const b = await checkBudget();
    expect(b.project).toBeNull();
    expect(b.scope).toBe('global');
    expect(b.dailyBudget).toBe(100);
    expect(b.dailySpent).toBe(52);
  });
});

// ── setBudget / clearProjectBudget: isolation between scopes ──

describe('setBudget', () => {
  test('a project write leaves the globals and sibling overrides untouched', async () => {
    await seed({ projects: { beta: { daily_usd: 9, monthly_usd: 90 } } }, []);
    const result = await setBudget({ daily_usd: 5, monthly_usd: 80, project: 'alpha' });
    expect(result).toEqual({ daily_usd: 5, monthly_usd: 80, scope: 'project' });

    const budget = await costRepo.readBudget();
    expect(budget.daily_usd).toBe(100);
    expect(budget.monthly_usd).toBe(2000);
    expect(budget.projects.alpha).toEqual({ daily_usd: 5, monthly_usd: 80 });
    expect(budget.projects.beta).toEqual({ daily_usd: 9, monthly_usd: 90 });
  });

  test('a global write preserves every per-project override', async () => {
    await seed({ projects: { alpha: { daily_usd: 5, monthly_usd: 80 } } }, []);
    await setBudget({ daily_usd: 250 });

    const budget = await costRepo.readBudget();
    expect(budget.daily_usd).toBe(250);
    expect(budget.monthly_usd, 'unspecified global field untouched').toBe(2000);
    expect(budget.projects.alpha).toEqual({ daily_usd: 5, monthly_usd: 80 });
  });

  test('a half-pair project write is rejected', async () => {
    await seed({}, []);
    await expect(setBudget({ daily_usd: 5, project: 'alpha' })).rejects.toThrow(/both daily and monthly/);
    expect((await costRepo.readBudget()).projects).toEqual({});
  });
});

describe('clearProjectBudget', () => {
  test('removes one override and leaves the rest intact', async () => {
    await seed({
      projects: { alpha: { daily_usd: 5, monthly_usd: 80 }, beta: { daily_usd: 9, monthly_usd: 90 } },
    }, []);
    expect(await clearProjectBudget('alpha')).toBe(true);

    const budget = await costRepo.readBudget();
    expect(budget.projects.alpha).toBeUndefined();
    expect(budget.projects.beta).toEqual({ daily_usd: 9, monthly_usd: 90 });
    expect(budget.daily_usd).toBe(100);
  });

  test('is a no-op returning false when the project has no override', async () => {
    await seed({}, []);
    expect(await clearProjectBudget('alpha')).toBe(false);
  });

  test('a cleared project inherits the globals again', async () => {
    await seed({ projects: { alpha: { daily_usd: 5, monthly_usd: 80 } } }, [entry('alpha', 1)]);
    await clearProjectBudget('alpha');
    const b = await checkBudget('alpha');
    expect(b.scope).toBe('global');
    expect(b.dailyBudget).toBe(100);
  });
});

test('listProjectBudgets returns every override sorted by project id', async () => {
  await seed({
    projects: {
      zeta: { daily_usd: 1, monthly_usd: 10 },
      alpha: { daily_usd: 5, monthly_usd: 80 },
    },
  }, []);
  expect(await listProjectBudgets()).toEqual([
    { project: 'alpha', daily_usd: 5, monthly_usd: 80 },
    { project: 'zeta', daily_usd: 1, monthly_usd: 10 },
  ]);
});
