// input:  the proxy-authoritative export and the journal-derived totals
// output: the accounting record — each side's own measured figures, tagged, plus the A4 role excess
// pos:    Pure §9.6 A1-A5 accounting record construction
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { decimalFromNumber, decimalText, isDecimalText } from './decimal-text.js';

export const ACCOUNTING_RECORD_SCHEMA_VERSION = 'cortex-bench-accounting/2';
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
  // The counter WAS read and the provider simply never reported a cache split. Distinct from
  // `counter_unreadable`, which is this side failing to read its own register: a response without a
  // cache breakdown is not a cache miss, so one silent request makes the trial's cached total
  // unknowable rather than smaller.
  'no_cache_breakdown_reported',
  'journal_absent', 'journal_underivable',
  // No writer left: this was produced by the proxy-vs-journal comparison, which is gone. It stays
  // in the set because this set gates PARSING — dropping it would start refusing any document
  // written before that removal, which is the opposite of what a closed reason set is for.
  'operand_unavailable',
] as const;
export type UnavailableReason = typeof UNAVAILABLE_REASONS[number];

/**
 * What the proxy itself measured. It counts requests and meters tokens; it prices nothing, so there
 * is no `cost_usd` here — see the note above `buildAccountingRecord` for why that slot is gone.
 * Declaration order is load-bearing: `composite-manifest.ts` compares `Object.keys(...).join(',')`
 * against `PROXY_KEYS` exactly, so `readProxy` must construct in this order too.
 */
export interface ProxyAccounting {
  readonly requests: Tagged<number>;
  readonly cached_tokens: Tagged<number>;
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

/**
 * What the run's own accumulator derived. `cost_usd` stays here and only here: it is the run's
 * cache-aware figure, computed from the provider's own per-response billing, and it is the number a
 * reader should quote for what the trial spent.
 */
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

/** The proxy metered requests the attempt DAG never claimed — OC-11's observable, listed not hidden. */
export interface UnaccountedRole {
  readonly kind: 'proxy_excess';
  readonly journal_roles: readonly string[];
  readonly requests: Tagged<number>;
}

/**
 * A statement of what each side measured, not a verdict on whether they agree. Nothing in here can
 * refuse a trial; Gate 4 carries it verbatim as evidence.
 */
export interface AccountingRecord {
  readonly schema_version: typeof ACCOUNTING_RECORD_SCHEMA_VERSION;
  readonly trial_id: string;
  readonly proxy: ProxyAccounting;
  readonly journal: JournalAccounting;
  readonly unaccounted_roles: readonly UnaccountedRole[];
}

export class AccountingInputError extends Error {
  constructor(detail: string) {
    super(`accounting input invalid: ${detail}`);
    this.name = 'AccountingInputError';
  }
}

/**
 * Record both sides' figures side by side, each tagged with whether it could be read at all. Pure:
 * it reads its two arguments, mutates neither and writes nothing. Gate 4 places the result verbatim;
 * it does not re-derive it.
 *
 * ── the proxy-vs-journal cross-check was REMOVED here, deliberately ──────────────────────────────
 *
 * This function used to be `reconcileAccounting`: it compared the two sides' `cost_usd` under a
 * relative tolerance and their request counts under exact equality, and published `reconciled`,
 * `deltas`, `tolerance` and a `checks` array whose failures rode failure code 41 — i.e. a
 * disagreement could refuse a finished trial.
 *
 * It was removed because the quantity it compared is not one either side observes. Cost is a token
 * count multiplied by whichever price list the observer happens to hold, and the two observers held
 * different ones. The trial proxy priced every prompt token at the full input rate; DeepSeek bills
 * cached prompt tokens at a reduced rate, which the run's own cache-aware accumulator applied. At a
 * 99.2% cache hit rate the two figures for one trial were $0.642 (proxy) against $0.0505 (journal) —
 * a 12.7x spread in which BOTH numbers were correct under their own price list. Their disagreement
 * failed reconciliation and discarded a finished trial.
 *
 * The fix was upstream, not here: the proxy no longer prices anything (it counts requests and
 * measures tokens), so it no longer has a cost figure to disagree with. What remains is evidence,
 * kept in full — both sides' measured counts are still recorded, and the journal's cache-aware
 * `cost_usd` is still carried as the run's spend. The A4 excess below survives too, because it
 * compares REQUEST COUNTS, which both sides genuinely observe.
 *
 * Do not "restore" the comparison as a bug fix. Reinstating it without a single shared price list
 * reinstates the incident. If a cost cross-check is ever wanted again, the two sides must first be
 * made to price from the same table, and the disagreement must be reported rather than allowed to
 * discard a trial that already ran.
 *
 * (In production the comparison had in fact never fired: `runner.ts` hardcodes every proxy-side
 * figure to `counter_unreadable` because the proxy runs host-side and the runner runs in-container,
 * so an operand was always missing. It was exercised only through the Python-produced golden files.)
 */
export function buildAccountingRecord(
  proxyExport: ProxyExport,
  journalTotals: JournalTotals,
): AccountingRecord {
  const proxy = readProxy(proxyExport);
  const journal = readJournal(journalTotals);
  return deepFreeze({
    schema_version: ACCOUNTING_RECORD_SCHEMA_VERSION,
    trial_id: assertTrialId(proxyExport.trial_id),
    proxy,
    journal,
    unaccounted_roles: unaccountedRoles(proxy, journal, journalTotals.roles),
  });
}

/** The journal reports cost as a JavaScript number; it is carried as an exact decimal string. */
export function journalCostFromNumber(value: unknown): Tagged<string> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { status: 'unavailable', reason: 'journal_underivable' };
  }
  return { status: 'available', value: decimalText(decimalFromNumber(value)) };
}

/**
 * A4 detection. The proxy meters by route and source IP, so every role's traffic is inside its
 * totals by construction; the journal side is the one that can miss a role. This is an observable
 * about roles the journal never claimed, denominated in REQUESTS — a count both sides genuinely
 * observe — and it is listed rather than absorbed, because absorbing it is how OC-11 disappears.
 *
 * It is not the removed proxy-vs-journal reconciliation and did not go with it: it raises no check,
 * carries no failure code and cannot refuse a trial.
 *
 * `journal.requests` is in practice permanently `journal_underivable`: `MetricAccumulator`
 * (`trajectory-merge.ts`) carries only prompt/completion/cached/cost/steps, and the journal's
 * one-per-turn `cost_record` counts a different event from the proxy's one-per-HTTP-call
 * `request_count`. Dividing one by the other is a guess, so the excess simply goes unlisted rather
 * than being estimated.
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
  }];
}

function readProxy(document: ProxyExport): ProxyAccounting {
  assertMember(document?.schema_version === PROXY_EXPORT_SCHEMA_VERSION, 'proxy.schema_version');
  assertMember(document.source === 'proxy_export', 'proxy.source');
  // Construction order is the declaration order of `ProxyAccounting`; `composite-manifest.ts`
  // compares the key list verbatim, so reordering a line here refuses every trial.
  return {
    requests: taggedCount(document.requests, 'proxy.requests'),
    cached_tokens: taggedCount(document.cached_tokens, 'proxy.cached_tokens'),
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
