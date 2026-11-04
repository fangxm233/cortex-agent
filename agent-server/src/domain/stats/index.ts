// Stats page queries: token usage from the cost ledger, tool activity from the conversation-history
// tool index, and quota-window history from usage observations. The aggregations are pure; this
// service only reads their inputs through injected sources, so tests and the daemon differ in
// wiring alone.
import type { CostEntry } from '@domain/costs/cost-tracker.js';
import type { UsageWindowRecord } from '@domain/costs/usage-window-history.js';
import type { StatsQuotaWindowsQuery, StatsToolsQuery, StatsUsageQuery } from './query.js';
import { aggregateQuotaWindows, type QuotaLedgerRow } from './quota-windows.js';
import type { ToolIndexSnapshot } from './tool-index.js';
import { DEFAULT_PROJECT, aggregateTools } from './tools.js';
import type { StatsQuotaWindows, StatsTools, StatsUsage } from './types.js';
import { aggregateUsage, usageRow, usageSlots, type SessionInfo, type UsageRow } from './usage.js';
import { RETENTION_MS } from './window.js';

export type * from './types.js';
export type { StatsQuotaWindowsQuery, StatsToolsQuery, StatsUsageQuery } from './query.js';

export interface StatsSession extends SessionInfo {
  sessionId: string;
}

/** The account a ledger entry ran on: the same attribution the Usage page's rows use. */
export interface StatsAttribution {
  provider: string;
  billing: 'subscription' | 'api';
  route: string | null;
}

export interface StatsSources {
  readLedger: () => Promise<readonly CostEntry[]>;
  listSessions: () => Promise<readonly StatsSession[]>;
  toolIndex: { snapshot: () => Promise<ToolIndexSnapshot> };
  quotaRecords: () => Promise<readonly UsageWindowRecord[]>;
  /** A fresh attributor per query, so its lookups reflect the current credential inventory. */
  attributor: () => (entry: CostEntry) => StatsAttribution | null;
  /** The name an account shows under, read once per query. */
  accountLabels: () => Promise<(provider: string, route: string | null) => string>;
  now?: () => number;
}

export interface StatsService {
  usage: (query: StatsUsageQuery) => Promise<StatsUsage>;
  tools: (query: StatsToolsQuery) => Promise<StatsTools>;
  quotaWindows: (query: StatsQuotaWindowsQuery) => Promise<StatsQuotaWindows>;
}

async function usageRows(sources: StatsSources): Promise<UsageRow[]> {
  return (await sources.readLedger()).flatMap((entry) => usageRow(entry) ?? []);
}

async function sessionMap(sources: StatsSources): Promise<Map<string, StatsSession>> {
  return new Map((await sources.listSessions()).map((session) => [session.sessionId, session]));
}

function quotaLedger(entries: readonly CostEntry[], attribute: (entry: CostEntry) => StatsAttribution | null): QuotaLedgerRow[] {
  return entries.flatMap((entry) => {
    const row = usageRow(entry);
    const account = row ? attribute(entry) : null;
    if (!row || account?.billing !== 'subscription') return [];
    return [{ at: row.at, provider: account.provider, route: account.route, source: row.source, cost: row.cost }];
  });
}

export function createStatsService(sources: StatsSources): StatsService {
  const now = sources.now ?? Date.now;
  return {
    usage: async (query) => {
      const [rows, sessions] = await Promise.all([usageRows(sources), sessionMap(sources)]);
      return aggregateUsage(rows, query, now(), (sessionId) => sessions.get(sessionId) ?? null);
    },
    tools: async (query) => {
      const [snapshot, sessions] = await Promise.all([sources.toolIndex.snapshot(), sessionMap(sources)]);
      return aggregateTools(snapshot, query, now(), (sessionId) => sessions.get(sessionId)?.projectId ?? DEFAULT_PROJECT);
    },
    quotaWindows: async (query) => {
      const [entries, records, labelOf] = await Promise.all([sources.readLedger(), sources.quotaRecords(), sources.accountLabels()]);
      const at = now();
      const retained = entries.flatMap((entry) => usageRow(entry) ?? []).filter((row) => row.at >= at - RETENTION_MS);
      return aggregateQuotaWindows({
        records, ledger: quotaLedger(entries, sources.attributor()), sourceSlots: usageSlots(retained).source,
        labelOf, query, now: at,
      });
    },
  };
}
