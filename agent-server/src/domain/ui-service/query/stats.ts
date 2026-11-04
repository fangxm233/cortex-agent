import type { UiServiceDeps, QueryParams } from '../types.js';
import type { StatsQuotaWindows, StatsTools, StatsUsage } from '@domain/stats/types.js';

export async function handleStatsUsage(deps: UiServiceDeps, params: QueryParams<'stats.usage'>): Promise<StatsUsage> {
  return deps.stats.usage({ range: params.range, page: params.page ?? 0, projectId: params.projectId ?? null });
}

export async function handleStatsTools(deps: UiServiceDeps, params: QueryParams<'stats.tools'>): Promise<StatsTools> {
  return deps.stats.tools({
    range: params.range, page: params.page ?? 0, projectId: params.projectId ?? null, kind: params.kind ?? 'tool',
  });
}

export async function handleStatsQuotaWindows(
  deps: UiServiceDeps, params: QueryParams<'stats.quotaWindows'>,
): Promise<StatsQuotaWindows> {
  return deps.stats.quotaWindows({ provider: params.provider ?? null, route: params.route ?? null });
}
