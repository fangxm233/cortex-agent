// input:  task-node paths, atomic writes, production topology ledger
// output: delivery dedupe, verdicts, and correlated rework facts
// pos:    Persistent task-child acceptance and delivery ledger
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { readFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { managerNodeDir } from '@core/task-node.js';
import { atomicWriteSync } from '@core/atomic-write.js';
import { createLogger } from '@core/log.js';
import {
  latestDeliveryFact,
  latestDispatchFact,
  readProductionTopologyFacts,
  recordProductionTopologyFact,
  type ProductionTopologyFact,
} from './production-topology-ledger.js';

const log = createLogger('acceptance-ledger');

/** `superseded` is the fourth verdict (D-10): success requires every delivered child "accepted or
 *  superseded by an accepted replacement", which the three-value union cannot express — a replaced
 *  child would stay `rejected` forever. */
export type LedgerVerdict = 'pending' | 'accepted' | 'rejected' | 'superseded';

export interface LedgerEntry {
  child: string;
  kind: 'completed' | 'blocked';
  delivered_at: string;
  verdict: LedgerVerdict;
  verdict_at: string | null;
  verdict_note: string | null;
  rework_round: number;
  /** The replacement child, non-null on a `superseded` verdict (D-10). Always present, like every
   *  other member: `| null` marks a value that may be null, never an optional key. */
  superseded_by: string | null;
}

export interface AcceptanceLedger {
  parent: string;
  project: string;
  children: Record<string, LedgerEntry>;
}

export function ledgerPath(project: string, taskId: string): string {
  return path.join(managerNodeDir(project, taskId), 'ledger.json');
}

/** Read the ledger for a task node. Missing or corrupt file degrades to an empty ledger
 *  (fail-open: worst case a result is re-delivered, never lost). */
export function readLedger(project: string, taskId: string): AcceptanceLedger {
  const empty: AcceptanceLedger = { parent: taskId, project, children: {} };
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(project, taskId), 'utf8'));
    if (!raw || typeof raw !== 'object' || typeof raw.children !== 'object' || raw.children === null) return empty;
    return { parent: taskId, project, children: raw.children };
  } catch {
    return empty;
  }
}

function writeLedger(ledger: AcceptanceLedger): void {
  const p = ledgerPath(ledger.project, ledger.parent);
  mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteSync(p, JSON.stringify(ledger, null, 2));
}

interface DeliveryTopologyContext {
  parentThreadId: string;
  childThreadId?: string;
  childDispatchGeneration?: string;
}

interface VerdictTopologyContext {
  managerThreadId?: string;
  childThreadId?: string;
}

function latestRejectedVerdict(
  project: string, parentTaskId: string, childTaskId: string,
): Extract<ProductionTopologyFact, { kind: 'verdict' }> | null {
  const verdicts = readProductionTopologyFacts({ project, kinds: ['verdict'] });
  return [...verdicts].reverse().find(
    (fact): fact is Extract<ProductionTopologyFact, { kind: 'verdict' }> => fact.kind === 'verdict'
      && fact.parent_task_id === parentTaskId && fact.child_task_id === childTaskId
      && fact.verdict === 'rejected',
  ) ?? null;
}

function recordDeliveryTopology(
  project: string, parentTaskId: string, childTaskId: string,
  kind: 'completed' | 'blocked', existing: LedgerEntry | undefined,
  context: DeliveryTopologyContext | undefined,
): void {
  if (!context) return;
  const dispatch = latestDispatchFact(project, childTaskId);
  const childThreadId = context.childThreadId ?? dispatch?.thread_id;
  const generation = context.childDispatchGeneration
    ?? (dispatch?.thread_id === childThreadId ? dispatch.dispatch_generation : null);
  if (!childThreadId || !generation) return;
  if (existing?.verdict === 'rejected') {
    const rejected = latestRejectedVerdict(project, parentTaskId, childTaskId);
    if (rejected && rejected.child_thread_id !== childThreadId) recordProductionTopologyFact({
      project, kind: 'rework', task_id: childTaskId,
      rejected_thread_id: rejected.child_thread_id,
      rejected_dispatch_generation: rejected.child_dispatch_generation,
      replacement_thread_id: childThreadId, replacement_dispatch_generation: generation,
      rework_round: existing.rework_round,
    });
  }
  recordProductionTopologyFact({
    project, kind: 'delivery', child_task_id: childTaskId, child_thread_id: childThreadId,
    child_dispatch_generation: generation, parent_task_id: parentTaskId,
    parent_thread_id: context.parentThreadId, outcome: kind,
  });
}

/** Record that a child result is being delivered to the parent task's manager.
 *  Returns false — meaning "do NOT deliver" — iff the child is already 'accepted'
 *  (cross-incarnation dedupe). A 'rejected' entry re-opens to 'pending' (the child
 *  completed again after rework), preserving its rework_round. */
export async function recordDelivered(
  project: string, taskId: string, childId: string, kind: 'completed' | 'blocked',
  topology?: DeliveryTopologyContext,
): Promise<boolean> {
  const ledger = readLedger(project, taskId);
  const existing = ledger.children[childId];
  if (existing?.verdict === 'accepted') return false;
  ledger.children[childId] = {
    child: childId,
    kind,
    delivered_at: new Date().toISOString(),
    verdict: 'pending',
    verdict_at: null,
    verdict_note: existing?.verdict_note ?? null,
    rework_round: existing?.rework_round ?? 0,
    superseded_by: existing?.superseded_by ?? null,
  };
  writeLedger(ledger);
  try {
    recordDeliveryTopology(project, taskId, childId, kind, existing, topology);
  } catch (error) {
    log.warn(`topology ledger delivery record failed: ${(error as Error).message}`);
  }
  return true;
}

function recordVerdictTopology(
  project: string, taskId: string, childId: string, verdict: 'accepted' | 'rejected',
  reworkRound: number, topology: VerdictTopologyContext,
): void {
  try {
    const managerThreadId = topology.managerThreadId
      ?? (process.env.CORTEX_THREAD_ID?.trim() || null);
    const delivery = latestDeliveryFact(project, taskId, childId);
    const childThreadId = topology.childThreadId ?? delivery?.child_thread_id ?? null;
    const generation = delivery?.child_dispatch_generation ?? null;
    if (!managerThreadId || !childThreadId || !generation) return;
    recordProductionTopologyFact({
      project, kind: 'verdict', parent_task_id: taskId, manager_thread_id: managerThreadId,
      child_task_id: childId, child_thread_id: childThreadId,
      child_dispatch_generation: generation, verdict, rework_round: reworkRound,
    });
  } catch (error) {
    log.warn(`topology ledger verdict record failed: ${(error as Error).message}`);
  }
}

/** Record a manager verdict and advance the acceptance rework round. */
export function recordVerdict(
  project: string, taskId: string, childId: string, verdict: 'accepted' | 'rejected',
  note?: string | null, topology: VerdictTopologyContext = {},
): void {
  const ledger = readLedger(project, taskId);
  const entry = ledger.children[childId] ?? {
    child: childId,
    kind: 'completed' as const,
    delivered_at: new Date().toISOString(),
    verdict: 'pending' as LedgerVerdict,
    verdict_at: null,
    verdict_note: null,
    rework_round: 0,
    superseded_by: null,
  };
  entry.verdict = verdict;
  entry.verdict_at = new Date().toISOString();
  entry.verdict_note = note ?? entry.verdict_note ?? null;
  if (verdict === 'rejected') entry.rework_round += 1;
  ledger.children[childId] = entry;
  writeLedger(ledger);
  recordVerdictTopology(project, taskId, childId, verdict, entry.rework_round, topology);
}

/** Entries delivered but not yet accepted/rejected — the rehydration prompt's
 *  "pending acceptance" list (DR-0017 W3). */
export function pendingDeliveries(project: string, taskId: string): LedgerEntry[] {
  return Object.values(readLedger(project, taskId).children).filter((e) => e.verdict === 'pending');
}
