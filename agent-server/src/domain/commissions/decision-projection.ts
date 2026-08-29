// input:  sessionStore, commissionRepo, commission-paths, fs append
// output: projectCommissionDecisions / projectCommissionDecisionAction
// pos:    Mirrors send_decision traffic into commission decisions.jsonl
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as fsp from 'node:fs/promises';
import { sessionStore } from '@store/session-registry-repo.js';
import { commissionRepo } from '@store/commission-repo.js';
import { ctx as jobCtx } from '@domain/scheduling/job-registry.js';
import type { RawDecisionItem } from '@store/conversation-history-repo.js';
import { commissionDecisionsFile } from './commission-paths.js';

/** decisions.jsonl is a mechanical server-side projection (DR-0037): agents never write it,
 *  and the ledger only narrates plan-changing decisions. One line per send_decision call
 *  (`kind:'decision'`) plus one line per user response (`kind:'action'`). */
export type CommissionDecisionLine =
  | { v: 1; kind: 'decision'; ts: string; sessionId: string; items: RawDecisionItem[] }
  | { v: 1; kind: 'action'; ts: string; sessionId: string; decisionId: string; action: string; message?: string };

export interface DecisionProjectionDeps {
  getSession?: (sessionId: string) => Promise<{ commissionId?: string | null } | null>;
  findCommission?: (id: string) => Promise<{ projectId: string; slug: string } | null>;
  resolveFile?: (projectId: string, slug: string) => string | null;
  appendLine?: (filePath: string, line: string) => Promise<void>;
  /** SSE hint after a successful append (an open board refetches commissions.decisions).
   *  Defaults to a `commission.updated` publish on the shared bus; no-op when the bus is absent. */
  publishUpdated?: (commissionId: string, projectId: string) => void;
}

interface ProjectionTarget { filePath: string; commissionId: string; projectId: string }

async function resolveTarget(sessionId: string, deps: DecisionProjectionDeps): Promise<ProjectionTarget | null> {
  const getSession = deps.getSession ?? ((id: string) => sessionStore.getById(id));
  const findCommission = deps.findCommission ?? ((id: string) => commissionRepo.find(id));
  const resolveFile = deps.resolveFile ?? commissionDecisionsFile;
  const session = await getSession(sessionId);
  if (!session?.commissionId) return null;
  const commission = await findCommission(session.commissionId);
  if (!commission) return null;
  const filePath = resolveFile(commission.projectId, commission.slug);
  if (!filePath) return null;
  return { filePath, commissionId: session.commissionId, projectId: commission.projectId };
}

async function appendProjection(sessionId: string, line: CommissionDecisionLine, deps: DecisionProjectionDeps): Promise<boolean> {
  const target = await resolveTarget(sessionId, deps);
  if (!target) return false;
  const append = deps.appendLine ?? ((file: string, text: string) => fsp.appendFile(file, text, 'utf8'));
  await append(target.filePath, `${JSON.stringify(line)}\n`);
  const publish = deps.publishUpdated
    ?? ((commissionId: string, projectId: string) => { jobCtx.bus?.publish({ type: 'commission.updated', commissionId, projectId }); });
  publish(target.commissionId, target.projectId);
  return true;
}

/** Mirror one send_decision call. Returns false when the session has no commission. */
export async function projectCommissionDecisions(
  args: { sessionId: string; ts: string; items: RawDecisionItem[] },
  deps: DecisionProjectionDeps = {},
): Promise<boolean> {
  return appendProjection(args.sessionId, { v: 1, kind: 'decision', ts: args.ts, sessionId: args.sessionId, items: args.items }, deps);
}

/** Mirror one user response (approve/explain/revise) to a projected decision. */
export async function projectCommissionDecisionAction(
  args: { sessionId: string; ts: string; decisionId: string; action: string; message?: string },
  deps: DecisionProjectionDeps = {},
): Promise<boolean> {
  return appendProjection(args.sessionId, {
    v: 1, kind: 'action', ts: args.ts, sessionId: args.sessionId,
    decisionId: args.decisionId, action: args.action,
    ...(args.message ? { message: args.message } : {}),
  }, deps);
}
