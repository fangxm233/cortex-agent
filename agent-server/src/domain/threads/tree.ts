// input:  thread store, task ancestry, production topology ledger
// output: tree queries, parent resolution, guards, spawn facts
// pos:    Recursive thread-tree infrastructure
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createLogger } from '@core/log.js';
import { threadStore } from '@store/thread-repo.js';
import { recordProductionTopologyFact } from '@domain/tasks/production-topology-ledger.js';
import type { ThreadRecord, ThreadStatus } from '@core/types/thread-types.js';

const log = createLogger('thread-tree');
const TERMINAL_STATUSES: ReadonlySet<ThreadStatus> = new Set(['completed', 'failed', 'cancelled', 'aborted']);

export function isTerminalStatus(status: ThreadStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envFloat(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Tree identity: a thread's root is its metadata.rootThreadId, falling back to itself. */
export function getRootThreadId(t: ThreadRecord): string {
  return t.metadata?.rootThreadId ?? t.id;
}

/** All threads belonging to the tree rooted at rootId (root included). threads.json is
 *  fully in-memory and small, so a full scan is fine. */
export function getTreeThreads(rootId: string): ThreadRecord[] {
  return threadStore.getAll().filter(t => getRootThreadId(t) === rootId);
}

function parentEvidenceKey(thread: ThreadRecord): string | null {
  const context = thread.metadata?.productionBenchmarkEvidenceContext;
  if (context == null) return null;
  return JSON.stringify({ rootThreadId: getRootThreadId(thread), context });
}

function assertParentCandidatesUnambiguous(candidates: ThreadRecord[], parentTaskId: string): void {
  const liveCount = candidates.filter(thread => !isTerminalStatus(thread.status)).length;
  const evidenceKeys = candidates.map(parentEvidenceKey);
  const benchmarkKeys = evidenceKeys.filter((key): key is string => key !== null);
  const mixedEvidence = benchmarkKeys.length > 0 && benchmarkKeys.length !== candidates.length;
  if (liveCount > 1 || mixedEvidence || new Set(benchmarkKeys).size > 1) {
    throw new Error(`Ambiguous persisted parent manager threads for task ${parentTaskId}`);
  }
}

/** Resolve the newest persisted thread that owns a task-tree parent node. */
export function resolveTaskParentThread(projectId: string, parentTaskId: string): ThreadRecord | null {
  const candidates = threadStore.getAll().filter((thread) => {
    const taskProject = thread.metadata?.taskProject ?? thread.projectId;
    return thread.metadata?.taskId === parentTaskId && taskProject === projectId;
  });
  assertParentCandidatesUnambiguous(candidates, parentTaskId);
  candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return candidates[0] ?? null;
}

export interface TreeSummary {
  nodeCount: number;
  totalCostUsd: number;
  byStatus: Record<string, number>;
}

export function summarizeTree(rootId: string): TreeSummary {
  const threads = getTreeThreads(rootId);
  const byStatus: Record<string, number> = {};
  let totalCostUsd = 0;
  for (const t of threads) {
    totalCostUsd += t.totalCostUsd || 0;
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  }
  return { nodeCount: threads.length, totalCostUsd, byStatus };
}

/** Sum of totalCostUsd over `ancestor` and all its transitive descendants within the tree. */
function subtreeCost(ancestor: ThreadRecord, treeThreads: ThreadRecord[]): number {
  const byParent = new Map<string, ThreadRecord[]>();
  for (const t of treeThreads) {
    const pid = t.metadata?.parentThreadId;
    if (pid) {
      const arr = byParent.get(pid) || [];
      arr.push(t);
      byParent.set(pid, arr);
    }
  }
  let sum = 0;
  const stack = [ancestor];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    sum += cur.totalCostUsd || 0;
    for (const c of byParent.get(cur.id) || []) stack.push(c);
  }
  return sum;
}

export type SpawnGuardResult = { ok: true } | { ok: false; reason: string };

/** Resource guards evaluated before spawning a child thread under `parent`.
 *  Three checks: width (children per thread), tree node count, and budget
 *  (each ancestor's contract.budgetUsd against its subtree's actual cost,
 *  plus a global per-tree cost ceiling). A failed guard should lead the agent
 *  to escalate ([ABORT]) or re-plan — not to retry the spawn. */
export function checkSpawnGuards(parent: ThreadRecord | null): SpawnGuardResult {
  if (!parent) return { ok: true };

  const maxChildren = envInt('CORTEX_THREAD_MAX_CHILDREN', 8);
  const childCount = parent.metadata?.childThreadIds?.length ?? 0;
  if (childCount >= maxChildren) {
    return { ok: false, reason: `parent ${parent.id} already spawned ${childCount} children (max ${maxChildren}) — escalate or re-plan instead of spawning more` };
  }

  const rootId = getRootThreadId(parent);
  const treeThreads = getTreeThreads(rootId);

  const maxNodes = envInt('CORTEX_TREE_MAX_NODES', 32);
  if (treeThreads.length >= maxNodes) {
    return { ok: false, reason: `thread tree ${rootId} already has ${treeThreads.length} nodes (max ${maxNodes})` };
  }

  // Budget: walk the ancestor chain from parent upward; any ancestor whose contract
  // budget is exhausted by its subtree's actual cost blocks further growth beneath it.
  const byId = new Map(treeThreads.map(t => [t.id, t]));
  let cursor: ThreadRecord | null = parent;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    const budget = cursor.metadata?.contract?.budgetUsd;
    if (budget != null) {
      const spent = subtreeCost(cursor, treeThreads);
      if (spent >= budget) {
        return { ok: false, reason: `budget exhausted: subtree of ${cursor.id} spent $${spent.toFixed(2)} of $${budget.toFixed(2)} budget` };
      }
    }
    const pid: string | null | undefined = cursor.metadata?.parentThreadId;
    cursor = pid ? (byId.get(pid) ?? threadStore.get(pid)) : null;
  }

  const maxTreeCost = envFloat('CORTEX_TREE_MAX_COST_USD', 50);
  const treeCost = treeThreads.reduce((s, t) => s + (t.totalCostUsd || 0), 0);
  if (treeCost >= maxTreeCost) {
    return { ok: false, reason: `tree cost limit hit: tree ${rootId} spent $${treeCost.toFixed(2)} (max $${maxTreeCost.toFixed(2)})` };
  }

  return { ok: true };
}

/** Record a freshly spawned child on its parent: always into childThreadIds (width/rework
 *  counter); into waitingOn only when the parent intends to suspend on it (wait=true). */
export async function registerChildSpawn(parentThreadId: string, childThreadId: string, wait: boolean): Promise<void> {
  await threadStore.mutate(parentThreadId, (t) => {
    const m = (t.metadata ??= {});
    (m.childThreadIds ??= []).push(childThreadId);
    if (wait) (m.waitingOn ??= []).push(childThreadId);
  });
  const child = threadStore.get(childThreadId);
  if (!child) return;
  try {
    recordProductionTopologyFact({
      project: child.projectId, kind: 'spawn', parent_thread_id: parentThreadId, child_thread_id: childThreadId,
    });
  } catch (error) {
    log.warn(`topology ledger spawn record failed: ${(error as Error).message}`);
  }
}

// --- Tree view (observability) ---

export interface ThreadTreeNode {
  threadId: string;
  status: ThreadStatus;
  templateName: string | null;
  activeAgent: string | null;
  costUsd: number;
  depth: number;
  createdAt: string;
  children: ThreadTreeNode[];
  /** Present on root nodes only. */
  rollup?: TreeSummary & { maxDepth: number };
}

/** Group the given threads into nested trees by metadata.parentThreadId.
 *  Nodes whose parent is outside the set become roots. Root nodes carry a rollup. */
export function buildThreadTree(threads: ThreadRecord[]): ThreadTreeNode[] {
  const byId = new Map(threads.map(t => [t.id, t]));
  const childrenOf = new Map<string, ThreadRecord[]>();
  const roots: ThreadRecord[] = [];
  for (const t of threads) {
    const pid = t.metadata?.parentThreadId;
    if (pid && byId.has(pid)) {
      const arr = childrenOf.get(pid) || [];
      arr.push(t);
      childrenOf.set(pid, arr);
    } else {
      roots.push(t);
    }
  }

  function toNode(t: ThreadRecord, depth: number): ThreadTreeNode {
    const kids = (childrenOf.get(t.id) || [])
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(c => toNode(c, depth + 1));
    return {
      threadId: t.id,
      status: t.status,
      templateName: t.templateName,
      activeAgent: t.activeAgent || null,
      costUsd: t.totalCostUsd || 0,
      depth,
      createdAt: t.createdAt,
      children: kids,
    };
  }

  function collectRollup(node: ThreadTreeNode): TreeSummary & { maxDepth: number } {
    let nodeCount = 0;
    let totalCostUsd = 0;
    let maxDepth = 0;
    const byStatus: Record<string, number> = {};
    const stack = [node];
    while (stack.length) {
      const cur = stack.pop()!;
      nodeCount++;
      totalCostUsd += cur.costUsd;
      maxDepth = Math.max(maxDepth, cur.depth);
      byStatus[cur.status] = (byStatus[cur.status] || 0) + 1;
      for (const c of cur.children) stack.push(c);
    }
    return { nodeCount, totalCostUsd, byStatus, maxDepth };
  }

  return roots
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(r => {
      const node = toNode(r, 0);
      node.rollup = collectRollup(node);
      return node;
    });
}
