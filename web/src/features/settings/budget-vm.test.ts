import { describe, it, expect } from 'vitest';
import type { ConfigBudget } from '@cortex-agent/ui-contract';
import {
  DAILY_CHIPS,
  MONTHLY_CHIPS,
  WARN_CHIPS,
  hasOverride,
  pickScopeBudget,
  buildBudgetValue,
  budgetSetArgs,
  budgetClearArgs,
  parseAmountInput,
  isChipActive,
  formatBudgetUsd,
  budgetBarPct,
} from './budget-vm';

const budget = (
  daily: number | null,
  monthly: number | null,
  projects: ConfigBudget['projects'] = {},
): ConfigBudget => ({ daily_usd: daily, monthly_usd: monthly, projects });

const withAlpha = budget(300, 8000, { alpha: { daily_usd: 5, monthly_usd: 100 } });

describe('budget-vm chips', () => {
  it('exposes the daily, monthly and warn chip sets', () => {
    expect(DAILY_CHIPS).toEqual([5, 10, 20, 50]);
    expect(MONTHLY_CHIPS).toEqual([100, 200, 500, 1000]);
    expect(WARN_CHIPS).toEqual([60, 80, 90]);
  });

  it('isChipActive matches the current limit', () => {
    expect(isChipActive(10, 10)).toBe(true);
    expect(isChipActive(10, 20)).toBe(false);
    expect(isChipActive(null, 10)).toBe(false);
  });
});

describe('scope resolution', () => {
  it('the global scope shows the globals and is never inherited', () => {
    expect(pickScopeBudget(withAlpha, null)).toEqual({ daily: 300, monthly: 8000, inherited: false });
  });

  it('a project with an override shows its own pair', () => {
    expect(pickScopeBudget(withAlpha, 'alpha')).toEqual({ daily: 5, monthly: 100, inherited: false });
  });

  it('a project without an override shows the globals it inherits, flagged', () => {
    expect(pickScopeBudget(withAlpha, 'beta')).toEqual({ daily: 300, monthly: 8000, inherited: true });
  });

  it('a missing snapshot yields null limits rather than fabricated ones', () => {
    expect(pickScopeBudget(null, null)).toEqual({ daily: null, monthly: null, inherited: false });
    expect(pickScopeBudget(null, 'alpha')).toEqual({ daily: null, monthly: null, inherited: true });
  });

  it('hasOverride is true only for a project that declares its own limits', () => {
    expect(hasOverride(withAlpha, 'alpha')).toBe(true);
    expect(hasOverride(withAlpha, 'beta')).toBe(false);
    expect(hasOverride(withAlpha, null)).toBe(false);
    expect(hasOverride(null, 'alpha')).toBe(false);
  });
});

describe('buildBudgetValue', () => {
  const scope = { daily: 10, monthly: 300, inherited: false };

  it('patches one limit and carries the other over', () => {
    expect(buildBudgetValue(scope, { daily: 20 })).toEqual({ daily_usd: 20, monthly_usd: 300 });
    expect(buildBudgetValue(scope, { monthly: 900 })).toEqual({ daily_usd: 10, monthly_usd: 900 });
  });

  it('seeds a new override from the inherited globals (both limits, never half a pair)', () => {
    const inherited = pickScopeBudget(withAlpha, 'beta');
    expect(buildBudgetValue(inherited, { daily: 7 })).toEqual({ daily_usd: 7, monthly_usd: 8000 });
  });

  it('returns null when the counterpart is unwritable — no fabricated limit', () => {
    expect(buildBudgetValue({ daily: 10, monthly: null, inherited: false }, { daily: 20 })).toBeNull();
    expect(buildBudgetValue({ daily: 10, monthly: 0, inherited: false }, { daily: 20 })).toBeNull();
    expect(buildBudgetValue({ daily: null, monthly: null, inherited: false }, { monthly: 5 })).toBeNull();
  });

  it('rejects a non-positive patch', () => {
    expect(buildBudgetValue(scope, { daily: 0 })).toBeNull();
    expect(buildBudgetValue(scope, { daily: -5 })).toBeNull();
    expect(buildBudgetValue(scope, { monthly: Number.NaN })).toBeNull();
  });
});

// The tRPC client input type cannot express null on these fields, so the global scope and the
// clear operation are both spelled by OMITTING a field.
describe('config.set arg builders', () => {
  it('targets the globals by omitting project', () => {
    expect(budgetSetArgs(null, { daily_usd: 20, monthly_usd: 300 })).toEqual({
      section: 'budget', value: { daily_usd: 20, monthly_usd: 300 },
    });
  });

  it('targets one project override', () => {
    expect(budgetSetArgs('alpha', { daily_usd: 5, monthly_usd: 100 })).toEqual({
      section: 'budget', project: 'alpha', value: { daily_usd: 5, monthly_usd: 100 },
    });
  });

  it('clears an override by omitting value', () => {
    expect(budgetClearArgs('alpha')).toEqual({ section: 'budget', project: 'alpha' });
  });
});

describe('parseAmountInput', () => {
  it('accepts plain, decorated and decimal amounts', () => {
    expect(parseAmountInput('20')).toBe(20);
    expect(parseAmountInput(' $12.50 ')).toBe(12.5);
    expect(parseAmountInput('1,000')).toBe(1000);
    expect(parseAmountInput('.5')).toBe(0.5);
  });

  it('rejects empty, non-numeric and non-positive input', () => {
    expect(parseAmountInput('')).toBeNull();
    expect(parseAmountInput('   ')).toBeNull();
    expect(parseAmountInput('abc')).toBeNull();
    expect(parseAmountInput('0')).toBeNull();
    expect(parseAmountInput('-5')).toBeNull();
    expect(parseAmountInput('1e5')).toBeNull();
  });
});

describe('formatting', () => {
  it('formatBudgetUsd renders $N or a dash for null', () => {
    expect(formatBudgetUsd(10)).toBe('$10');
    expect(formatBudgetUsd(12.5)).toBe('$12.50');
    expect(formatBudgetUsd(null)).toBe('—');
  });

  it('budgetBarPct is spend/limit clamped to 0..100', () => {
    expect(budgetBarPct(4.21, 10)).toBe('42%');
    expect(budgetBarPct(15, 10)).toBe('100%');
    expect(budgetBarPct(0, 10)).toBe('0%');
    expect(budgetBarPct(5, null)).toBe('0%');
    expect(budgetBarPct(5, 0)).toBe('0%');
  });
});
