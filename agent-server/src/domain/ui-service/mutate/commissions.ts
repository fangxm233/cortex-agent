import { commissionRepo } from '@store/commission-repo.js';
import type { UiServiceDeps, Result, CommissionCloseArgs, CommissionInfo } from '../types.js';
import { toCommissionInfo } from '../query/commissions.js';

/** Close a commission as done/abandoned — a user action from the board UI; agents never close
 *  their own commission. The commission dir (contract/ledger/assets) is left untouched. */
export async function handleCommissionClose(
  deps: UiServiceDeps,
  args: CommissionCloseArgs,
): Promise<Result<CommissionInfo>> {
  const store = deps.commissionStore ?? commissionRepo;
  const record = await store.find(args.commissionId);
  if (!record) {
    return { ok: false, code: 'not-found', message: `Commission not found: ${args.commissionId}` };
  }
  if (record.status !== 'active') {
    return { ok: false, code: 'already-terminal', message: `Commission is already ${record.status}` };
  }
  const updated = await store.update(args.commissionId, (r) => {
    r.status = args.status;
    r.closedAt = Date.now();
    if (args.note) r.closeNote = args.note;
  });
  if (!updated) {
    return { ok: false, code: 'not-found', message: `Commission not found: ${args.commissionId}` };
  }
  deps.bus.publish({ type: 'commission.updated', commissionId: updated.id, projectId: updated.projectId });
  return { ok: true, data: toCommissionInfo(updated) };
}
