import type { UsageResetCredit, UsageResetCredits } from './usage-store.js';

/**
 * Banked resets that clear the same windows. Claude grants differ in reach: a full reset clears
 * the 5-hour and both weekly limits, a model launch reset only the 5-hour and that model's weekly.
 */
export interface ResetCreditKind {
  /** Window types a reset of this kind clears, sorted; empty when the provider does not say. */
  clears: string[];
  count: number;
  /** The credit a reset of this kind spends: the account's own pick, else the earliest to expire.
   *  Null when only the count is known. */
  credit: UsageResetCredit | null;
  /** Earliest expiry among the kind's credits; null when none expires. */
  expiresAt: number | null;
}

/** The weekly window only a full Claude reset clears. */
const ALL_MODELS_WEEKLY = 'seven_day';

function sortedClears(credit: UsageResetCredit): string[] {
  return [...(credit.clears ?? [])].sort();
}

function expiryOrder(a: UsageResetCredit, b: UsageResetCredit): number {
  return (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY);
}

function kindOf(group: UsageResetCredit[], nextCreditId: string | undefined): ResetCreditKind {
  const byExpiry = [...group].sort(expiryOrder);
  return {
    clears: sortedClears(group[0]),
    count: group.reduce((sum, credit) => sum + (credit.count ?? 1), 0),
    credit: group.find((credit) => credit.id === nextCreditId) ?? byExpiry[0],
    expiresAt: byExpiry[0].expiresAt,
  };
}

/** Kinds in order of their first credit; a count without a credit list is one unnamed kind. */
export function resetCreditKinds(credits: UsageResetCredits): ResetCreditKind[] {
  if (credits.credits.length === 0) {
    return credits.availableCount > 0
      ? [{ clears: [], count: credits.availableCount, credit: null, expiresAt: null }]
      : [];
  }
  const groups = new Map<string, UsageResetCredit[]>();
  for (const credit of credits.credits) {
    const key = sortedClears(credit).join(',');
    groups.set(key, [...(groups.get(key) ?? []), credit]);
  }
  return [...groups.values()].map((group) => kindOf(group, credits.nextCreditId));
}

/** Whether a kind clears every limit, not just one model's. */
export function isFullResetKind(kind: Pick<ResetCreditKind, 'clears'>): boolean {
  return kind.clears.includes(ALL_MODELS_WEEKLY);
}

/** Kinds that would lift a limit on `windowType`; all of them when none says it clears it. */
export function kindsClearing(kinds: ResetCreditKind[], windowType: string | undefined): ResetCreditKind[] {
  if (!windowType) return kinds;
  const matching = kinds.filter((kind) => kind.clears.length === 0 || kind.clears.includes(windowType));
  return matching.length > 0 ? matching : kinds;
}
