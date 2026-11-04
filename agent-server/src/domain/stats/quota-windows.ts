// Quota-window history for the Stats page: each recorded window period of a subscription account,
// with its peak utilization and the account's ledger usage in it split by source. Pure.
import type { UsageWindowRecord } from '@domain/costs/usage-window-history.js';
import { addTo, rankKeys, slotOf } from './keys.js';
import type { StatsQuotaWindowsQuery } from './query.js';
import type {
  StatsQuotaAccount, StatsQuotaPeriod, StatsQuotaSpan, StatsQuotaWindows, StatsSource,
} from './types.js';
import { HOUR_MS, RETENTION_MS } from './window.js';

const PERIOD_LIMIT = 50;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;
/** A Codex primary window seen resetting further out than this is a weekly one (plans without a
 *  short window report their weekly limit as primary). */
const SHORT_WINDOW_MAX_MS = 6 * HOUR_MS;

interface Span {
  span: StatsQuotaSpan;
  durationMs: number;
}

const FIVE_HOUR: Span = { span: 'fiveHour', durationMs: FIVE_HOURS_MS };
const WEEKLY: Span = { span: 'weekly', durationMs: WEEK_MS };

/** A ledger row already attributed to the subscription account it ran on. */
export interface QuotaLedgerRow {
  at: number;
  provider: string;
  route: string | null;
  source: StatsSource;
  cost: number;
}

export interface QuotaWindowsInput {
  records: readonly UsageWindowRecord[];
  ledger: readonly QuotaLedgerRow[];
  sourceSlots: ReadonlyMap<string, number>;
  labelOf: (provider: string, route: string | null) => string;
  query: StatsQuotaWindowsQuery;
  now: number;
}

/** Which table a window period goes in, and how long it lasts. */
export function spanOf(record: Pick<UsageWindowRecord, 'windowType' | 'horizonMs'>): Span | null {
  if (record.windowType === 'five_hour') return FIVE_HOUR;
  if (record.windowType.startsWith('seven_day') || record.windowType === 'codex_secondary') return WEEKLY;
  if (record.windowType !== 'codex_primary') return null;
  return record.horizonMs > SHORT_WINDOW_MAX_MS ? WEEKLY : FIVE_HOUR;
}

function accountKey(provider: string, route: string | null): string {
  return `${provider}\u0000${route ?? ''}`;
}

function accountsOf(records: readonly UsageWindowRecord[], labelOf: QuotaWindowsInput['labelOf']): StatsQuotaAccount[] {
  const accounts = new Map<string, StatsQuotaAccount>();
  for (const record of records) {
    const key = accountKey(record.provider, record.route);
    if (!accounts.has(key)) accounts.set(key, { provider: record.provider, route: record.route, label: labelOf(record.provider, record.route) });
  }
  return [...accounts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, account]) => account);
}

function pickAccount(accounts: readonly StatsQuotaAccount[], query: StatsQuotaWindowsQuery): StatsQuotaAccount | null {
  const requested = query.provider === null
    ? undefined
    : accounts.find((account) => account.provider === query.provider && account.route === (query.route ?? null));
  return requested ?? accounts[0] ?? null;
}

function breakdown(
  rows: readonly QuotaLedgerRow[], start: number, end: number, slots: ReadonlyMap<string, number>,
): StatsQuotaPeriod['breakdown'] {
  const costs = new Map<string, number>();
  for (const row of rows) {
    if (row.at >= start && row.at < end) addTo(costs, row.source, row.cost);
  }
  const total = [...costs.values()].reduce((acc, cost) => acc + cost, 0);
  if (!(total > 0)) return [];
  return rankKeys(costs).filter((key) => costs.get(key)! > 0)
    .map((key) => ({ key: key as StatsSource, colorSlot: slotOf(slots, key), share: costs.get(key)! / total }));
}

function periodOf(record: UsageWindowRecord, span: Span, rows: readonly QuotaLedgerRow[], slots: ReadonlyMap<string, number>): StatsQuotaPeriod {
  const start = record.resetsAt - span.durationMs;
  return {
    windowType: record.windowType, start, end: record.resetsAt, peakUtilization: record.peakUtilization,
    lastObservedAt: record.lastObservedAt, breakdown: breakdown(rows, start, record.resetsAt, slots),
  };
}

function periodsOf(
  account: StatsQuotaAccount, input: QuotaWindowsInput, records: readonly UsageWindowRecord[],
): StatsQuotaWindows['periods'] {
  const periods: StatsQuotaWindows['periods'] = { fiveHour: [], weekly: [] };
  const rows = input.ledger.filter((row) => row.provider === account.provider && row.route === account.route);
  const own = records.filter((record) => record.provider === account.provider && record.route === account.route)
    .sort((a, b) => b.resetsAt - a.resetsAt);
  for (const record of own) {
    const span = spanOf(record)!;
    const list = periods[span.span];
    if (list.length < PERIOD_LIMIT) list.push(periodOf(record, span, rows, input.sourceSlots));
  }
  return periods;
}

export function aggregateQuotaWindows(input: QuotaWindowsInput): StatsQuotaWindows {
  const records = input.records.filter((record) => spanOf(record) !== null && record.resetsAt >= input.now - RETENTION_MS);
  const accounts = accountsOf(records, input.labelOf);
  const account = pickAccount(accounts, input.query);
  const firstSeen = records.reduce((min, record) => Math.min(min, record.firstObservedAt), Infinity);
  return {
    accounts,
    account,
    periods: account ? periodsOf(account, input, records) : { fiveHour: [], weekly: [] },
    recordingSince: Number.isFinite(firstSeen) ? firstSeen : null,
  };
}
