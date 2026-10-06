import { createLogger } from '@core/log.js';
import type { SubagentUsageReport } from '../../../agent-adapter/pi/subagent.js';
import { recordCost } from '../../costs/cost-tracker.js';
import * as executionRegistry from '../../executions/registry.js';

const log = createLogger('subagent-spend');

/** Who a backgrounded run belongs to: the session that started it, and where that session lives. */
export interface BackgroundSpendOwner {
  sessionId: string | null;
  conduit?: string;
  project?: string;
}

/**
 * File one backgrounded PI child's spend as a run of its own, once, when the child ends.
 *
 * A foreground child's spend joins the parent turn it ran inside. A background child usually ends
 * after that turn, when there is no turn left to carry it (the parent's stream drops it) or a later
 * one that did not spend it. So it is filed the way a daemon-run child is: an execution record owned
 * by the parent session — the session totals roll it up as subagent cost — and one ledger row
 * pointing at that record.
 */
export function recordBackgroundChildSpend(owner: BackgroundSpendOwner, report: SubagentUsageReport): void {
  const { usage } = report;
  const record = executionRegistry.startLocalExecution({
    kind: 'local',
    channel: owner.conduit ?? null,
    project: owner.project,
    trigger: 'subagent',
    backend: 'pi',
    billingMode: 'api',
    sessionId: null,
    ownerSessionId: owner.sessionId,
    label: report.description?.substring(0, 60) ?? null,
  });
  executionRegistry.completeExecution(record.id, {
    costUsd: usage.cost, numTurns: usage.turns > 0 ? usage.turns : null,
  });
  // The same row the parent's stream would have filed for a foreground child (PI event parser,
  // `subagentUsageEvents`), attributed to the record above.
  void recordCost({
    session_id: owner.sessionId, execution_id: record.id,
    project: owner.project || 'general', trigger: 'subagent',
    cost_usd: usage.cost, backend: 'pi', mode: 'api', source: 'estimate',
    input_tokens: usage.input, output_tokens: usage.output,
    prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
    cache_read_tokens: usage.cacheRead, cache_creation_tokens: usage.cacheWrite,
    provider_requests: usage.turns > 0 ? usage.turns : null,
    provider: report.provider, model: report.model || undefined,
  }).catch((error) => log.warn('background subagent recordCost failed:', (error as Error)?.message ?? error));
}
