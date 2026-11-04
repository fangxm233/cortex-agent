// The Stats page's query inputs, as the ui-service handlers pass them.
import type { StatsRange, StatsToolKind } from './types.js';

export interface StatsUsageQuery {
  range: StatsRange;
  page: number;
  projectId: string | null;
}

export interface StatsToolsQuery extends StatsUsageQuery {
  kind: StatsToolKind;
}

export interface StatsQuotaWindowsQuery {
  provider: string | null;
  route: string | null;
}
