import type { UiServiceDeps, CostSummaryParams } from '../types.js';
import type { CostSummary } from '@domain/costs/cost-tracker.js';

export async function handleCostSummary(
  deps: UiServiceDeps,
  params: CostSummaryParams,
): Promise<CostSummary> {
  return deps.costSummary(params.projectId ?? null);
}
