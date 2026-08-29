// input:  UiServiceDeps (+commissionStore seam) + commissions.* params; decisions.jsonl on disk
// output: handleCommissionsList / handleCommissionsGet / handleCommissionsDecisions
// pos:    query handlers for 'commissions.list' / 'commissions.get' / 'commissions.decisions'
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as fs from 'node:fs';
import { commissionRepo, type CommissionRecord } from '@store/commission-repo.js';
import type {
  UiServiceDeps,
  CommissionInfo,
  CommissionsListParams,
  CommissionsGetParams,
  CommissionsDecisionsParams,
  CommissionDecisionEntry,
  DecisionActionKind,
} from '../types.js';
import { resolveProjectRoot, resolveMemoryFilePath } from './memory.js';

function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: 'not-found' });
}

/** Registry record → DTO (epoch ms → ISO strings; absent close fields → honest null). */
export function toCommissionInfo(record: CommissionRecord): CommissionInfo {
  return {
    id: record.id,
    projectId: record.projectId,
    slug: record.slug,
    title: record.title,
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    closedAt: record.closedAt != null ? new Date(record.closedAt).toISOString() : null,
    closeNote: record.closeNote ?? null,
  };
}

function store(deps: UiServiceDeps): NonNullable<UiServiceDeps['commissionStore']> {
  return deps.commissionStore ?? commissionRepo;
}

export async function handleCommissionsList(
  deps: UiServiceDeps,
  params: CommissionsListParams,
): Promise<CommissionInfo[]> {
  let records = await store(deps).list(params.projectId);
  if (params.status) records = records.filter((r) => r.status === params.status);
  return records.map(toCommissionInfo);
}

export async function handleCommissionsGet(
  deps: UiServiceDeps,
  params: CommissionsGetParams,
): Promise<CommissionInfo> {
  const record = await store(deps).find(params.commissionId);
  if (!record) throw notFound(`commission not found: ${params.commissionId}`);
  return toCommissionInfo(record);
}

const DECISION_ACTIONS = new Set<string>(['approve', 'explain', 'revise']);

/** Fold the append-only decisions.jsonl (server-side projection, DR-0037) into board cards:
 *  each `kind:'decision'` item becomes an entry, later `kind:'action'` lines merge into that
 *  entry's actions — the same DecisionItem shape the transcript renders. Malformed lines and
 *  actions for unknown decision ids are skipped (the projection is best-effort by design). */
export function foldDecisionLines(content: string): CommissionDecisionEntry[] {
  const byId = new Map<string, CommissionDecisionEntry>();
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue;
    let line: any;
    try { line = JSON.parse(raw); } catch { continue; }
    if (line?.kind === 'decision' && Array.isArray(line.items)) {
      for (const item of line.items) {
        if (typeof item?.id !== 'string' || byId.has(item.id)) continue;
        byId.set(item.id, {
          ts: String(line.ts ?? ''),
          sessionId: String(line.sessionId ?? ''),
          item: {
            id: item.id,
            title: String(item.title ?? ''),
            decision: String(item.decision ?? ''),
            context: String(item.context ?? ''),
            reasoning: String(item.reasoning ?? ''),
            actions: [],
          },
        });
      }
    } else if (line?.kind === 'action' && typeof line.decisionId === 'string') {
      const entry = byId.get(line.decisionId);
      if (!entry || !DECISION_ACTIONS.has(String(line.action))) continue;
      entry.item.actions.push({
        action: line.action as DecisionActionKind,
        ...(typeof line.message === 'string' && line.message ? { message: line.message } : {}),
        ts: String(line.ts ?? ''),
      });
    }
  }
  return [...byId.values()];
}

export async function handleCommissionsDecisions(
  deps: UiServiceDeps,
  params: CommissionsDecisionsParams,
): Promise<CommissionDecisionEntry[]> {
  const record = await store(deps).find(params.commissionId);
  if (!record) throw notFound(`commission not found: ${params.commissionId}`);
  const root = resolveProjectRoot(deps, record.projectId);
  let abs: string;
  try {
    // Path is built from registry facts (slug), not user input; the guard is defense in depth.
    abs = resolveMemoryFilePath(root, `commissions/${record.slug}/decisions.jsonl`);
  } catch {
    return [];   // no projection file yet — an empty stream, not an error
  }
  return foldDecisionLines(fs.readFileSync(abs, 'utf8'));
}
