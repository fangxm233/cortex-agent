import type { UiServiceDeps, QueryParams } from '../types.js';
import type { CostSummary } from '@domain/costs/cost-tracker.js';

export async function handleCostSummary(
  deps: UiServiceDeps,
  params: QueryParams<'cost.summary'>,
): Promise<CostSummary> {
  return deps.costSummary(params.projectId ?? null);
}
