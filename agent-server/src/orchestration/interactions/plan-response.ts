import { runRegistry } from '@core/run-registry.js';
import { resolveRequest as resolveHookRequest } from '../routing/hook-bridge.js';
import type { InteractionRecords } from './interaction-records.js';
import type { PendingPlan, PlanApprovals } from './plan-approvals.js';

export type PlanResponseOutcome = 'resolved' | 'already-resolved' | 'not-found';

export function deliverPlanResponse(
  requestId: string,
  pending: PendingPlan,
  approved: boolean,
  feedback = '',
): boolean {
  if (pending.extensionUiId) {
    const payload = { value: approved ? '__APPROVED__' : feedback };
    // Walk the channel's live runs; the first that still has this dialog answers it. When none
    // does (stale id / no run), fall through to the blocking webhook instead of dropping it.
    for (const entry of runRegistry.getByChannel(pending.channel)) {
      if (entry.run?.respondToDialog(pending.extensionUiId, payload)) return true;
    }
  }
  return resolveHookRequest(requestId, { approved, reason: feedback });
}

export function respondToPlan(
  deps: {
    planApprovals: Pick<PlanApprovals, 'lookup' | 'resolve' | 'reject'>;
    interactionRecords: Pick<InteractionRecords, 'get' | 'resolve'>;
  },
  requestId: string,
  approved: boolean,
  feedback = '',
): PlanResponseOutcome {
  const record = deps.interactionRecords.get(requestId);
  if (record && record.status !== 'pending') return 'already-resolved';

  const pending = deps.planApprovals.lookup(requestId);
  if (!pending || !deliverPlanResponse(requestId, pending, approved, feedback)) return 'not-found';

  if (approved) deps.planApprovals.resolve(requestId);
  else deps.planApprovals.reject(requestId);
  void deps.interactionRecords.resolve({
    id: requestId,
    status: approved ? 'approved' : 'rejected',
    result: feedback ? { feedback } : undefined,
    resolvedVia: 'web',
  });
  return 'resolved';
}
