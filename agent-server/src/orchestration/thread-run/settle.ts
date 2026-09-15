// input:  a finished ThreadRun's verdict + status message
// output: the persisted `metadata.statusMsgRef` and the caller's settle hook, in that order
// pos:    orchestration/thread-run — the single place a thread's run hands control back. The ref
//         persistence used to be duplicated in the webhook's onSettled and in task-dispatch's two
//         pause branches; the settle hook itself is injected (thread-callback.settleThread) so
//         nothing in here imports the callback module (it would close a cycle — see thread-run.ts).

import type { MessageRef } from '@platform/index.js';
import { createLogger } from '@core/log.js';
import { threadStore } from '@store/thread-repo.js';
import type { ThreadVerdict } from './verdict.js';

const log = createLogger('thread-run');

/** A non-terminal run will be re-entered later; whoever resumes it must find the live status
 *  message to refresh, so persist the ref on the record (plan §1.2 step 8). */
export function persistsStatusMsgRef(verdict: ThreadVerdict): boolean {
  return verdict === 'waiting' || verdict === 'rate_limited';
}

export async function settleThreadRun(opts: {
  threadId: string;
  verdict: ThreadVerdict;
  statusMsg: MessageRef | null;
  settle: ((threadId: string) => Promise<void>) | null;
}): Promise<void> {
  const { threadId, verdict, statusMsg, settle } = opts;
  if (statusMsg && persistsStatusMsgRef(verdict)) {
    await threadStore.mutate(threadId, (t) => { (t.metadata ??= {}).statusMsgRef = statusMsg; })
      .catch((e) => log.warn(`persist statusMsgRef ${threadId}: ${(e as Error).message}`));
  }
  if (settle) {
    await settle(threadId).catch((e) => log.error(`settle ${threadId}: ${(e as Error).message}`));
  }
}
