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

export interface SpendFigures {
  today: number;
  month: number;
  all: number;
}

export interface LedgerSpendRow {
  provider: string;
  billing: UsageBilling;
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
}

interface Accumulator {
  provider: string;
  billing: UsageBilling;
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

function memoBilling(billingOf: BillingOf): BillingOf {
  const cache = new Map<string, ConnectionBilling>();
  return (ref) => {
    const key = `${ref.backend}\u0000${ref.provider ?? ''}\u0000${ref.connection ?? ''}`;
    let billing = cache.get(key);
    if (billing === undefined) {
      billing = billingOf(ref);
      cache.set(key, billing);
    }
    return billing;
  };
}

/** A PI provider is its own connection, and bills as its credential does. */
function attribute(entry: CostEntry, billingOf: BillingOf): Attribution | null {
  if ((entry.backend || 'claude') === 'pi') {
    const provider = entry.provider;
    if (!provider) return null;
    return { provider, connection: provider, billing: usageBilling(billingOf({ backend: 'pi', provider, connection: null })) };
  }
  const connection = claudeConnection(entry);
  const billing = connection === null
    ? 'api' : usageBilling(billingOf({ backend: 'claude', provider: null, connection }));
  return { provider: entry.provider || 'anthropic', connection, billing };
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

function accumulator(rows: Map<string, Accumulator>, { provider, billing }: Attribution): Accumulator {
  const key = `${provider}\u0000${billing}`;
  let row = rows.get(key);
  if (!row) {
    row = {
      provider, billing, connectionSet: new Set(), recent: false,
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
  return { provider: row.provider, billing: row.billing, connections: [...row.connectionSet].sort(), spend };
}

/** Rows for every (provider, billing) with traffic in the last 30 days, from the ledger's last 90. */
export function ledgerSpend(entries: readonly CostEntry[], billingOf: BillingOf, now: Date): LedgerSpendRow[] {
  const windows = windowsAt(now);
  const billing = memoBilling(billingOf);
  const rows = new Map<string, Accumulator>();
  for (const entry of entries) {
    const at = Date.parse(entry.timestamp);
    if (!(at >= windows.ledgerStart)) continue;
    const attribution = attribute(entry, billing);
    if (attribution) addEntry(accumulator(rows, attribution), entry, at, windows, attribution.connection);
  }
  return [...rows.values()].filter((row) => row.recent).map(settle);
}
