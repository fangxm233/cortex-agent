// Acceptance ledger — task-keyed record of child-result deliveries and verdicts (DR-0017 W1).
// input:  core/task-node paths, core/atomic-write
// output: ledgerPath / readLedger / recordDelivered / recordVerdict / pendingDeliveries
// pos:    the cross-incarnation dedupe for TASK children (per-thread deliveredChildResults
//         only dedupes within one thread incarnation). Semantics: delivery is
//         at-least-once per manager incarnation until a verdict is recorded;
//         'accepted' children never re-deliver; 'rejected' children re-open
//         (verdict → pending, rework_round preserved) when they complete again after rework;
//         'superseded' + superseded_by (D-10) record a child replaced by an accepted rerun.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { readFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { managerNodeDir } from '@core/task-node.js';
import { atomicWriteSync } from '@core/atomic-write.js';

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

/** Record that a child result is being delivered to the parent task's manager.
 *  Returns false — meaning "do NOT deliver" — iff the child is already 'accepted'
 *  (cross-incarnation dedupe). A 'rejected' entry re-opens to 'pending' (the child
 *  completed again after rework), preserving its rework_round. */
export async function recordDelivered(project: string, taskId: string, childId: string, kind: 'completed' | 'blocked'): Promise<boolean> {
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
  return true;
}

/** Record the manager's acceptance verdict for a delivered child. 'rejected' increments
 *  rework_round (the child is expected to be reworked and re-delivered). Upserts when
 *  the entry is missing (e.g. a verdict recorded for a delivery that predates the ledger). */
export function recordVerdict(project: string, taskId: string, childId: string, verdict: 'accepted' | 'rejected', note?: string | null): void {
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
}

/** Entries delivered but not yet accepted/rejected — the rehydration prompt's
 *  "pending acceptance" list (DR-0017 W3). */
export function pendingDeliveries(project: string, taskId: string): LedgerEntry[] {
  return Object.values(readLedger(project, taskId).children).filter((e) => e.verdict === 'pending');
}
