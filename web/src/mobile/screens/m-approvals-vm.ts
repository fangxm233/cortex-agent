// Pure view-model for the 1f 审批队列 screen (scheme-mobile.dc.html 1f L354-385, project grouping
// added post-scheme). Maps the REAL `ApprovalInfo` DTO (parsed from PENDING_APPROVALS.md) into
// project groups (current project → 全局 → others) of pending cards plus a flat list in group order —
// the same DTO→slot discipline as the desktop approval center (approval-center-vm.ts), adapted so ANY
// card can be the expanded one (1f lets you tap a collapsed card to swap which is expanded).
// Honest placeholders — NO fabrication (851f precedent):
//   • operation → the real tier variable (null → no pill).
//   • reason / impact → the real free-text (the scheme's `$12.40 / 日预算 $10.00` estimate has NO
//     structured DTO field — it lives inside this free text; we render it verbatim, never invent `$`).
//   • command → the real Command/Action for an optional mono block (null → omit).
//   • provenance → the verbatim `来自` origin (null → omit; never fabricated).
//   • queuedAt → the real relative time (relTimeZh; '' when absent — no fabricated clock).
// The scheme's `APR-0007` id and `ttl` are MOCKS: we render the real `id` and never render a ttl (no
// source field). Framework-free so the DTO→value mapping is unit-tested in isolation.
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { relTimeZh } from '@/mobile/ui/format';

export interface MApprovalCard {
  /** Real stable id (a sha1-derived hash — the scheme's `APR-0007` is a mock). */
  id: string;
  /** Real owning project (ApprovalInfo.projectId); null = 全局 (legacy / system-level entry). */
  projectId: string | null;
  /** Real operation = the tier variable; null → no tier pill (no safety-class taxonomy field). */
  operation: string | null;
  title: string;
  /** Relative queued time (real, from queuedAt); '' when absent — never a fabricated clock. */
  time: string;
  /** Real reason free-text (carries the budget/estimate text); null → omit. */
  reason: string | null;
  /** Real impact free-text; null → omit. */
  impact: string | null;
  /** Real Command/Action for the mono block; null → omit the block (no invented `$` numbers). */
  command: string | null;
  /** Verbatim provenance = the `来自` origin; null → omit (never fabricated). */
  provenance: string | null;
}

export interface MApprovalGroup {
  /** Group key: the owning project id, or null for the 全局 (unattributed) bucket. */
  projectId: string | null;
  cards: MApprovalCard[];
}

export interface MApprovalsVm {
  pendingCount: number;
  /** Project groups: current project → 全局 (null) → other projects by id. */
  groups: MApprovalGroup[];
  /** Flat card list in group order (drives the expand-first-card default). */
  cards: MApprovalCard[];
}

export function buildMApprovalsVm(
  entries: ApprovalInfo[],
  now: number = Date.now(),
  currentProjectId: string | null = null,
): MApprovalsVm {
  const pending = entries.filter((e) => e.status === 'pending');
  const toCard = (e: ApprovalInfo): MApprovalCard => ({
    id: e.id,
    projectId: e.projectId,
    operation: e.operation,
    title: e.title,
    time: relTimeZh(e.queuedAt, now),
    reason: e.reason,
    impact: e.impact,
    command: e.command,
    provenance: e.provenance,
  });

  // Bucket by projectId preserving input order inside each bucket; '' keys the 全局 (null) bucket.
  const buckets = new Map<string, MApprovalCard[]>();
  for (const e of pending) {
    const key = e.projectId ?? '';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(toCard(e));
  }

  // Group order: current project first, then 全局, then remaining projects by id.
  const keys = [...buckets.keys()].sort((a, b) => {
    const rank = (k: string): number => (k === currentProjectId ? 0 : k === '' ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const groups: MApprovalGroup[] = keys.map((key) => ({
    projectId: key === '' ? null : key,
    cards: buckets.get(key)!,
  }));
  return { pendingCount: pending.length, groups, cards: groups.flatMap((g) => g.cards) };
}
