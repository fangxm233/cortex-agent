// @cortex-agent/ui-contract — the types the Cortex Web UI shares with the server. Types only: the
// browser bundle takes nothing at runtime from this package.

export type * from '@cortex-agent/server/dist/domain/ui-service/types.js';
// The cost.summary return DTO lives in the costs domain, not the ui-service barrel.
export type { CostSummary } from '@cortex-agent/server/dist/domain/costs/cost-tracker.js';
export type { AppRouter } from './app-router.js';
