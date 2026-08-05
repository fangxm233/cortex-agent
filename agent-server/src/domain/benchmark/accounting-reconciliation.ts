// input:  the proxy-authoritative export, journal-derived totals, the arm's tolerance
// output: the accounting record, its tagged figures, deltas and check ids
// pos:    Pure §9.6 A1-A5 accounting reconciliation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import {
  absDecimal, compareDecimal, decimalFromNumber, decimalText, isDecimalText,
  maxDecimal, multiplyDecimal, parseDecimal, subtractDecimal, type DecimalValue,
} from './decimal-text.js';
import { BENCHMARK_FAILURES } from './resolved-policy.js';

export const ACCOUNTING_RECORD_SCHEMA_VERSION = 'cortex-bench-accounting/1';
export const PROXY_EXPORT_SCHEMA_VERSION = 'cortex-bench-proxy-export/1';

/**
 * Every figure is a tagged union rather than a number, so "the counter was never read" and "the
 * counter read zero" cannot share a representation. A rule that merely forbids zero is violated by
 * the next default initialiser; a shape that cannot hold a bare number is not.
 */
export type Available<T> = { readonly status: 'available'; readonly value: T };
export type Unavailable = { readonly status: 'unavailable'; readonly reason: UnavailableReason };
export type Tagged<T> = Available<T> | Unavailable;

/** Closed on purpose: a reason the other side of the seam does not know is a refusal, not a pass. */
export const UNAVAILABLE_REASONS = [
  'proxy_not_started', 'counter_unreadable', 'audit_log_unreadable', 'no_echo_received',
  'journal_absent', 'journal_underivable', 'operand_unavailable',
] as const;
export type UnavailableReason = typeof UNAVAILABLE_REASONS[number];

export const ACCOUNTING_CHECK_IDS = [
  'accounting_requests_mismatch', 'accounting_cost_out_of_tolerance',
  'accounting_operand_unavailable',
] as const;
export type AccountingCheckId = typeof ACCOUNTING_CHECK_IDS[number];

/** No new failure code is allocated: the distinctions ride as check ids on the shipped code 41. */
const TERMINAL_PREDICATE_UNMET = BENCHMARK_FAILURES
  .find(failure => failure.reason === 'terminal_predicate_unmet')!.code;

export interface AccountingCheck {
  readonly check_id: AccountingCheckId;
  readonly passed: boolean;
  readonly failure_code: number | null;
  readonly detail: string;
}

export interface ProxyAccounting {
  readonly requests: Tagged<number>;
  readonly cost_usd: Tagged<string>;
  readonly input_tokens: Tagged<number>;
  readonly output_tokens: Tagged<number>;
  readonly audit_log: Tagged<Record<string, unknown>>;
  readonly lease_echo: Tagged<Record<string, unknown>>;
  readonly source: 'proxy_export';
}

export interface ProxyExport extends ProxyAccounting {
  readonly schema_version: typeof PROXY_EXPORT_SCHEMA_VERSION;
  readonly trial_id: string;
  readonly adapter_id: string;
}

export interface JournalAccounting {
  readonly requests: Tagged<number>;
  readonly cost_usd: Tagged<string>;
  readonly steps: Tagged<number>;
  readonly tokens: {
    readonly input: Tagged<number>;
    readonly output: Tagged<number>;
    readonly cached: Tagged<number>;
  };
  readonly source: 'trajectory_merge';
}

export interface JournalTotals extends JournalAccounting {
  /** The roles the attempt DAG did account for, so an excess can be reported against a named set. */
  readonly roles: readonly string[];
}

/**
 * Declared arm policy, frozen at compile and recorded in the record so a reader can see what was
 * applied. `requests_abs` is the literal 0: a request either traversed the proxy or it did not, and
 * a count has no rounding, so widening it is a type error rather than a judgement call.
 */
export interface AccountingTolerance {
  readonly requests_abs: 0;
  readonly cost_usd_rel: string;
  readonly cost_usd_abs_floor: string;
}

export const DEFAULT_ACCOUNTING_TOLERANCE: AccountingTolerance = Object.freeze({
  requests_abs: 0, cost_usd_rel: '0.01', cost_usd_abs_floor: '0.000001',
});

/** The proxy metered requests the attempt DAG never claimed — OC-11's observable, listed not hidden. */
export interface UnaccountedRole {
  readonly kind: 'proxy_excess';
  readonly journal_roles: readonly string[];
  readonly requests: Tagged<number>;
  readonly cost_usd: Tagged<string>;
}

export interface AccountingRecord {
  readonly schema_version: typeof ACCOUNTING_RECORD_SCHEMA_VERSION;
  readonly trial_id: string;
  readonly proxy: ProxyAccounting;
  readonly journal: JournalAccounting;
  readonly tolerance: AccountingTolerance;
  readonly deltas: { readonly requests: Tagged<number>; readonly cost_usd: Tagged<string> };
  readonly reconciled: Tagged<boolean>;
  readonly unaccounted_roles: readonly UnaccountedRole[];
  readonly checks: readonly AccountingCheck[];
}

export class AccountingInputError extends Error {
  constructor(detail: string) {
    super(`accounting input invalid: ${detail}`);
    this.name = 'AccountingInputError';
  }
}

/**
 * Compare the proxy's own totals against the journal's. Pure: it reads its two arguments, mutates
 * neither and writes nothing. Gate 4 places the result verbatim; it does not re-derive it.
 */
export function reconcileAccounting(
  proxyExport: ProxyExport,
  journalTotals: JournalTotals,
  tolerance: AccountingTolerance = DEFAULT_ACCOUNTING_TOLERANCE,
): AccountingRecord {
  assertTolerance(tolerance);
  const proxy = readProxy(proxyExport);
  const journal = readJournal(journalTotals);
  const missing = unavailableOperands(proxy, journal);
  const requests = compareRequests(proxy.requests, journal.requests);
  const cost = compareCost(proxy.cost_usd, journal.cost_usd, tolerance);
  return deepFreeze({
    schema_version: ACCOUNTING_RECORD_SCHEMA_VERSION,
    trial_id: assertTrialId(proxyExport.trial_id),
    proxy,
    journal,
    tolerance: { ...tolerance },
    deltas: { requests: requests.delta, cost_usd: cost.delta },
    reconciled: reconciledFlag(missing, [requests, cost]),
    unaccounted_roles: unaccountedRoles(proxy, journal, journalTotals.roles),
    checks: buildChecks(missing, [requests, cost]),
  });
}

/** The journal reports cost as a JavaScript number; costs are compared as decimal strings. */
export function journalCostFromNumber(value: unknown): Tagged<string> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { status: 'unavailable', reason: 'journal_underivable' };
  }
  return { status: 'available', value: decimalText(decimalFromNumber(value)) };
}

interface Comparison<T> {
  readonly delta: Tagged<T>;
  readonly check: AccountingCheck | null;
}

const OPERAND_PATHS = [
  'proxy.requests', 'proxy.cost_usd', 'proxy.lease_echo',
  'journal.requests', 'journal.cost_usd',
] as const;

function unavailableOperands(proxy: ProxyAccounting, journal: JournalAccounting): string[] {
  const slots: Tagged<unknown>[] = [
    proxy.requests, proxy.cost_usd, proxy.lease_echo, journal.requests, journal.cost_usd,
  ];
  return OPERAND_PATHS.filter((_path, index) => slots[index].status === 'unavailable');
}

function compareRequests(proxy: Tagged<number>, journal: Tagged<number>): Comparison<number> {
  if (proxy.status !== 'available' || journal.status !== 'available') return notComparable();
  const delta = proxy.value - journal.value;
  return {
    delta: { status: 'available', value: delta },
    check: check('accounting_requests_mismatch', delta === 0,
      `proxy ${proxy.value} journal ${journal.value}`),
  };
}

function compareCost(
  proxy: Tagged<string>, journal: Tagged<string>, tolerance: AccountingTolerance,
): Comparison<string> {
  if (proxy.status !== 'available' || journal.status !== 'available') return notComparable();
  const observed = parseDecimal(proxy.value);
  const delta = subtractDecimal(observed, parseDecimal(journal.value));
  const limit = costLimit(observed, tolerance);
  return {
    delta: { status: 'available', value: decimalText(delta) },
    check: check('accounting_cost_out_of_tolerance',
      compareDecimal(absDecimal(delta), limit) <= 0,
      `delta ${decimalText(delta)} tolerance ${decimalText(limit)}`),
  };
}

/** The floor exists so a near-zero trial is not compared by ratio. */
function costLimit(observed: DecimalValue, tolerance: AccountingTolerance): DecimalValue {
  const relative = absDecimal(multiplyDecimal(observed, parseDecimal(tolerance.cost_usd_rel)));
  return maxDecimal(parseDecimal(tolerance.cost_usd_abs_floor), relative);
}

function notComparable<T>(): Comparison<T> {
  return { delta: { status: 'unavailable', reason: 'operand_unavailable' }, check: null };
}

function check(id: AccountingCheckId, passed: boolean, detail: string): AccountingCheck {
  return { check_id: id, passed, failure_code: passed ? null : TERMINAL_PREDICATE_UNMET, detail };
}

/** R-A5-2: a missing operand is neither a mismatch nor a match, so it is neither false nor true. */
function reconciledFlag(
  missing: readonly string[], comparisons: readonly Comparison<unknown>[],
): Tagged<boolean> {
  if (missing.length > 0) return { status: 'unavailable', reason: 'operand_unavailable' };
  return {
    status: 'available',
    value: comparisons.every(comparison => comparison.check?.passed === true),
  };
}

function buildChecks(
  missing: readonly string[], comparisons: readonly Comparison<unknown>[],
): AccountingCheck[] {
  const evaluated = comparisons
    .map(comparison => comparison.check)
    .filter((entry): entry is AccountingCheck => entry !== null);
  if (missing.length === 0) return evaluated;
  return [check('accounting_operand_unavailable', false, missing.join(', ')), ...evaluated];
}

/**
 * A4 detection. The proxy meters by route and source IP, so every role's traffic is inside its
 * totals by construction; the journal side is the one that can miss a role. An excess is listed
 * here rather than absorbed into the tolerance, because absorbing it is how OC-11 disappears.
 */
function unaccountedRoles(
  proxy: ProxyAccounting, journal: JournalAccounting, roles: readonly string[],
): UnaccountedRole[] {
  if (proxy.requests.status !== 'available' || journal.requests.status !== 'available') return [];
  const excess = proxy.requests.value - journal.requests.value;
  if (excess <= 0) return [];
  return [{
    kind: 'proxy_excess',
    journal_roles: [...roles],
    requests: { status: 'available', value: excess },
    cost_usd: costExcess(proxy.cost_usd, journal.cost_usd),
  }];
}

function costExcess(proxy: Tagged<string>, journal: Tagged<string>): Tagged<string> {
  if (proxy.status !== 'available' || journal.status !== 'available') {
    return { status: 'unavailable', reason: 'operand_unavailable' };
  }
  const delta = subtractDecimal(parseDecimal(proxy.value), parseDecimal(journal.value));
  return { status: 'available', value: decimalText(maxDecimal(delta, parseDecimal('0'))) };
}

function readProxy(document: ProxyExport): ProxyAccounting {
  assertMember(document?.schema_version === PROXY_EXPORT_SCHEMA_VERSION, 'proxy.schema_version');
  assertMember(document.source === 'proxy_export', 'proxy.source');
  return {
    requests: taggedCount(document.requests, 'proxy.requests'),
    cost_usd: taggedDecimal(document.cost_usd, 'proxy.cost_usd'),
    input_tokens: taggedCount(document.input_tokens, 'proxy.input_tokens'),
    output_tokens: taggedCount(document.output_tokens, 'proxy.output_tokens'),
    audit_log: taggedObject(document.audit_log, 'proxy.audit_log'),
    lease_echo: taggedObject(document.lease_echo, 'proxy.lease_echo'),
    source: 'proxy_export',
  };
}

function readJournal(totals: JournalTotals): JournalAccounting {
  assertMember(totals?.source === 'trajectory_merge', 'journal.source');
  assertMember(Array.isArray(totals.roles), 'journal.roles');
  return {
    requests: taggedCount(totals.requests, 'journal.requests'),
    cost_usd: taggedDecimal(totals.cost_usd, 'journal.cost_usd'),
    steps: taggedCount(totals.steps, 'journal.steps'),
    tokens: {
      input: taggedCount(totals.tokens?.input, 'journal.tokens.input'),
      output: taggedCount(totals.tokens?.output, 'journal.tokens.output'),
      cached: taggedCount(totals.tokens?.cached, 'journal.tokens.cached'),
    },
    source: 'trajectory_merge',
  };
}

function tagged<T>(slot: unknown, path: string, shape: (value: unknown) => boolean): Tagged<T> {
  assertMember(typeof slot === 'object' && slot !== null, path);
  const entry = slot as { status?: unknown; value?: unknown; reason?: unknown };
  if (entry.status === 'unavailable') {
    assertMember(UNAVAILABLE_REASONS.includes(entry.reason as UnavailableReason), `${path}.reason`);
    return { status: 'unavailable', reason: entry.reason as UnavailableReason };
  }
  assertMember(entry.status === 'available', `${path}.status`);
  assertMember(shape(entry.value), `${path}.value`);
  return { status: 'available', value: entry.value as T };
}

function taggedCount(slot: unknown, path: string): Tagged<number> {
  return tagged(slot, path, value => Number.isSafeInteger(value) && (value as number) >= 0);
}

function taggedDecimal(slot: unknown, path: string): Tagged<string> {
  return tagged(slot, path, value => isDecimalText(value) && !value.startsWith('-'));
}

function taggedObject(slot: unknown, path: string): Tagged<Record<string, unknown>> {
  const entry = tagged<Record<string, unknown>>(
    slot, path, value => typeof value === 'object' && value !== null,
  );
  // The record is frozen on the way out. An opaque block carried through by reference would be
  // frozen inside the caller's own document too, which is a mutation of an input however equal its
  // values still compare afterwards.
  if (entry.status !== 'available') return entry;
  return { status: 'available', value: structuredClone(entry.value) };
}

function assertTolerance(tolerance: AccountingTolerance): void {
  assertMember(tolerance?.requests_abs === 0, 'tolerance.requests_abs');
  for (const member of ['cost_usd_rel', 'cost_usd_abs_floor'] as const) {
    assertMember(isDecimalText(tolerance[member]), `tolerance.${member}`);
    assertMember(!tolerance[member].startsWith('-'), `tolerance.${member}`);
  }
}

function assertTrialId(trialId: string): string {
  assertMember(typeof trialId === 'string' && trialId.length > 0, 'proxy.trial_id');
  return trialId;
}

function assertMember(valid: boolean, path: string): void {
  if (!valid) throw new AccountingInputError(path);
}

function deepFreeze<T>(document: T): T {
  for (const value of Object.values(document as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(document);
}
