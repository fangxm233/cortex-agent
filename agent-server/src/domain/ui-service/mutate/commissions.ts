import { t } from '@core/i18n.js';
import { commissionRepo, type CommissionStatus } from '@store/commission-repo.js';
import type { UiServiceDeps, Result, CommissionInfo, MutateArgs } from '../types.js';
import { toCommissionInfo } from '../query/commissions.js';

/** Close a commission as done/abandoned — a user action from the board UI; agents never close
 *  their own commission. The commission dir (contract/ledger/assets) is left untouched. */
export async function handleCommissionClose(
  deps: UiServiceDeps,
  args: MutateArgs<'commissions.close'>,
): Promise<Result<CommissionInfo>> {
  const store = deps.commissionStore ?? commissionRepo;
  // The status check runs inside the update, under the repo lock: checked outside it, two closes
  // racing would both pass and the second would overwrite the first one's status and note.
  let closedAs: CommissionStatus | null = null;
  const updated = await store.update(args.commissionId, (r) => {
    if (r.status !== 'active') {
      closedAs = r.status;
      return false;
    }
    r.status = args.status;
    r.closedAt = Date.now();
    if (args.note) r.closeNote = args.note;
  });
  if (!updated) {
    return { ok: false, code: 'not-found', message: t('ui.commission.notFound', { id: args.commissionId }) };
  }
  if (closedAs) {
    return { ok: false, code: 'already-terminal', message: t('ui.commission.alreadyClosed', { status: closedAs }) };
  }
  deps.bus.publish({ type: 'commission.updated', commissionId: updated.id, projectId: updated.projectId });
  return { ok: true, data: toCommissionInfo(updated) };
}
