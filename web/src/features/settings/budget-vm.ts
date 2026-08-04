import type { ConfigBudget, BudgetValue } from '@cortex-agent/ui-contract';

// Pure derivations for the Budget panel. This module governs the only real write in the settings
// modal (config.set budget), so its value-builders are unit-tested against the backend zod
// contract (daily/monthly finite & positive).
//
// Two scopes exist: the global limits, and a per-project override. Overrides are PAIR-ONLY — a
// project either declares both limits or inherits both globals — so every write here carries a
// complete pair, and a project that has never been overridden shows the globals marked `inherited`.
// Framework-free; no JSX, no hex.

/** null = the global scope; a string = that project's scope. */
export type BudgetScopeId = string | null;

/** Daily-limit quick chips (prototype budgetChips L2411). */
export const DAILY_CHIPS = [5, 10, 20, 50];
/** Monthly-limit quick chips — same ladder one order of magnitude up. */
export const MONTHLY_CHIPS = [100, 200, 500, 1000];
/** Warn-threshold chips — display only; no budget.json field backs it. */
export const WARN_CHIPS = [60, 80, 90];

export interface ScopeBudget {
  daily: number | null;
  monthly: number | null;
  /** True when a project scope is showing the GLOBAL numbers because it has no override of its own. */
  inherited: boolean;
}

export function hasOverride(budget: ConfigBudget | null, projectId: BudgetScopeId): boolean {
  if (!projectId) return false;
  return budget?.projects?.[projectId] != null;
}

/**
 * Resolve the limits a scope displays. A project with an override shows its own pair; a project
 * without one shows the globals flagged `inherited` (never fabricated, never blank — the globals
 * are what actually applies to that project today).
 */
export function pickScopeBudget(budget: ConfigBudget | null, projectId: BudgetScopeId): ScopeBudget {
  const override = projectId ? budget?.projects?.[projectId] : undefined;
  if (override) return { daily: override.daily_usd, monthly: override.monthly_usd, inherited: false };
  return {
    daily: budget?.daily_usd ?? null,
    monthly: budget?.monthly_usd ?? null,
    inherited: projectId != null,
  };
}

function isWritable(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n) && n > 0;
}

/**
 * Build a complete config.set budget payload by patching ONE limit of a scope and carrying the
 * other over. Returns null when the result would not satisfy the backend contract (both limits
 * finite & positive) — we never invent a missing counterpart.
 */
export function buildBudgetValue(
  scope: ScopeBudget,
  patch: { daily?: number; monthly?: number },
): BudgetValue | null {
  const daily = patch.daily ?? scope.daily;
  const monthly = patch.monthly ?? scope.monthly;
  if (!isWritable(daily) || !isWritable(monthly)) return null;
  return { daily_usd: daily, monthly_usd: monthly };
}

// The generated tRPC client input type collapses nullable optionals to `undefined` (the same
// already happens to `cost.summary`'s nullish projectId), so "global scope" and "clear the
// override" are expressed by OMITTING the field rather than sending null. The server schema
// accepts both spellings; this is the wire shape the browser can actually express.
export interface BudgetSetInput {
  section: 'budget';
  project?: string;
  value?: BudgetValue;
}

/** `config.set` args for writing a scope's limits. A null projectId targets the globals. */
export function budgetSetArgs(projectId: BudgetScopeId, value: BudgetValue): BudgetSetInput {
  return projectId ? { section: 'budget', project: projectId, value } : { section: 'budget', value };
}

/** `config.set` args for dropping a project's override so it inherits the globals again. */
export function budgetClearArgs(projectId: string): BudgetSetInput {
  return { section: 'budget', project: projectId };
}

/** Parse a hand-typed amount (`$12.50`, ` 20 `). Returns null for anything unwritable. */
export function parseAmountInput(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (cleaned === '' || !/^\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return isWritable(n) ? n : null;
}

export function isChipActive(current: number | null, chip: number): boolean {
  return current === chip;
}

/** `$10` (integer) / `$12.50` (fractional) / `—` for null. */
export function formatBudgetUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? '$' + n : '$' + n.toFixed(2);
}

/** spend/limit as a clamped `NN%` string for the spend bar; `0%` when the limit is unusable. */
export function budgetBarPct(spent: number, limit: number | null | undefined): string {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return '0%';
  const pct = Math.max(0, Math.min(100, (spent / limit) * 100));
  return Math.round(pct) + '%';
}
