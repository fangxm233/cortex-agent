// Spend per Usage row, read from Cortex's own cost ledger. A row is one provider billed one way;
// each ledger row lands on one by the connection it ran on, and the connection's billing decides
// whether its cost is a bill (metered) or an imputed price a subscription already covers.

import { SUBSCRIPTION_CONNECTION, type ConnectionBilling } from '@core/connections-file.js';
import type { SelectionRef } from '../connections/inventory.js';
import type { CostEntry } from './cost-tracker.js';
import type { UsageBilling } from './usage-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Month" is a rolling 30 days. */
export const MONTH_WINDOW_MS = 30 * DAY_MS;
/** The ledger keeps 90 days; the longest period reads exactly that, whatever the file still holds. */
export const LEDGER_WINDOW_MS = 90 * DAY_MS;

export type BillingOf = (ref: SelectionRef) => ConnectionBilling;
/** The account a connection is, or null when it is not one. */
export type AccountOf = (ref: SelectionRef) => string | null;

export interface SpendFigures {
  today: number;
  month: number;
  all: number;
}

export interface LedgerSpendRow {
  provider: string;
  billing: UsageBilling;
  /** The account the row's traffic ran on; absent for the provider's default login. */
  route?: string;
  /** Connections that carried this row's traffic in the last 30 days. */
  connections: string[];
  /** Metered rows only: a subscription's cost is an imputed API price, not a bill. */
  spend: SpendFigures | null;
}

interface Attribution {
  provider: string;
  /** Null: a row filed before connections existed, whose connection is unknown. */
  connection: string | null;
  billing: UsageBilling;
  route: string | null;
}

interface Accumulator {
  provider: string;
  billing: UsageBilling;
  route: string | null;
  spend: SpendFigures | null;
  connectionSet: Set<string>;
  /** Only traffic in the last 30 days makes a row; older spend just adds to its 90-day total. */
  recent: boolean;
}

function usageBilling(billing: ConnectionBilling): UsageBilling {
  return billing === 'subscription' ? 'subscription' : 'api';
}

/** Rows written before connections existed recorded only the bucket: 'plan' was the subscription,
 *  anything else one of the metered relays, which one unknown. */
function claudeConnection(entry: CostEntry): string | null {
  return entry.connection ?? (entry.mode === 'plan' ? SUBSCRIPTION_CONNECTION : null);
}

function memo<T>(lookup: (ref: SelectionRef) => T): (ref: SelectionRef) => T {
  const cache = new Map<string, T>();
  return (ref) => {
    const key = `${ref.backend}\u0000${ref.provider ?? ''}\u0000${ref.connection ?? ''}`;
    if (!cache.has(key)) cache.set(key, lookup(ref));
    return cache.get(key)!;
  };
}

interface Lookups {
  billingOf: BillingOf;
  accountOf: AccountOf;
}

/** A PI provider's default login is the provider itself; an account of it runs on a route of its
 *  own. Each bills as its credential does. */
function piAttribution(entry: CostEntry, lookups: Lookups): Attribution | null {
  const provider = entry.provider;
  if (!provider) return null;
  const named = entry.connection && entry.connection !== provider ? entry.connection : null;
  const route = named === null ? null : lookups.accountOf({ backend: 'pi', provider, connection: named });
  const billing = usageBilling(lookups.billingOf({ backend: 'pi', provider, connection: route }));
  return { provider, connection: route ?? provider, billing, route };
}

function attribute(entry: CostEntry, lookups: Lookups): Attribution | null {
  if ((entry.backend || 'claude') === 'pi') return piAttribution(entry, lookups);
  const connection = claudeConnection(entry);
  const ref = { backend: 'claude' as const, provider: null, connection };
  const billing = connection === null ? 'api' : usageBilling(lookups.billingOf(ref));
  const route = connection === null ? null : lookups.accountOf(ref);
  return { provider: entry.provider || 'anthropic', connection, billing, route };
}

interface Windows {
  todayStart: number;
  monthStart: number;
  ledgerStart: number;
}

function windowsAt(now: Date): Windows {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return {
    todayStart: midnight.getTime(),
    monthStart: now.getTime() - MONTH_WINDOW_MS,
    ledgerStart: now.getTime() - LEDGER_WINDOW_MS,
  };
}

function accumulator(rows: Map<string, Accumulator>, { provider, billing, route }: Attribution): Accumulator {
  const key = `${provider}\u0000${billing}\u0000${route ?? ''}`;
  let row = rows.get(key);
  if (!row) {
    row = {
      provider, billing, route, connectionSet: new Set(), recent: false,
      spend: billing === 'api' ? { today: 0, month: 0, all: 0 } : null,
    };
    rows.set(key, row);
  }
  return row;
}

function addEntry(row: Accumulator, entry: CostEntry, at: number, windows: Windows, connection: string | null): void {
  const recent = at >= windows.monthStart;
  if (recent) {
    row.recent = true;
    if (connection) row.connectionSet.add(connection);
  }
  if (!row.spend) return;
  const cost = entry.cost_usd ?? 0;
  row.spend.all += cost;
  if (recent) row.spend.month += cost;
  if (at >= windows.todayStart) row.spend.today += cost;
}

function roundCost(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function settle(row: Accumulator): LedgerSpendRow {
  const spend = row.spend && {
    today: roundCost(row.spend.today), month: roundCost(row.spend.month), all: roundCost(row.spend.all),
  };
  return {
    provider: row.provider, billing: row.billing, ...(row.route ? { route: row.route } : {}),
    connections: [...row.connectionSet].sort(), spend,
  };
}

/** Rows for every (provider, billing, account) with traffic in the last 30 days, from the ledger's
 *  last 90. */
export function ledgerSpend(
  entries: readonly CostEntry[], billingOf: BillingOf, now: Date, accountOf: AccountOf = () => null,
): LedgerSpendRow[] {
  const windows = windowsAt(now);
  const lookups: Lookups = { billingOf: memo(billingOf), accountOf: memo(accountOf) };
  const rows = new Map<string, Accumulator>();
  for (const entry of entries) {
    const at = Date.parse(entry.timestamp);
    if (!(at >= windows.ledgerStart)) continue;
    const attribution = attribute(entry, lookups);
    if (attribution) addEntry(accumulator(rows, attribution), entry, at, windows, attribution.connection);
  }
  return [...rows.values()].filter((row) => row.recent).map(settle);
}
