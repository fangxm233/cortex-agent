import type { ApprovalInfo, ApprovalStatus } from '@cortex-agent/ui-contract';

// Pure view-model for the approval center overlay (design 7a, prototype.dc.html L1317-1405).
// Maps the REAL `ApprovalInfo` DTO (parsed from PENDING_APPROVALS.md) into the prototype's slots.
// §12 C item 13 source verification: the origin/from/task slots are backed by the REAL (optional)
// `provenance` bullet — origin/from = the verbatim provenance text, task = its parsed 4-hex `taskRef`;
// both are honest null when the entry has no provenance bullet (never fabricated). The prototype's
// `ttl` slot has ZERO source (the markdown queue has no expiry concept — the 30-min hook-bridge plan
// TTL is a different channel) → it stays omitted, never fabricated. The `tag` safety-class pill + the
// ESTIMATE cost table + the why rationale likewise have no field → omitted (the mono block shows the
// real COMMAND, no invented cost numbers). Framework-free so the DTO→value mapping is unit-tested.

/** Explicit missing-field placeholder. */
export const DASH = '—';

export interface ApprovalPill {
  text: string;
  bg: string;
  fg: string;
}

/** Status → the prototype's amber/green/red pill (prototype L1357 uses the pending amber pair). */
export function statusPill(status: ApprovalStatus): ApprovalPill {
  switch (status) {
    case 'pending':
      return { text: '● pending', bg: '#F7ECCE', fg: '#8A5B06' };
    case 'approved':
      return { text: '✓ approved', bg: '#E9F4EE', fg: '#23854F' };
    case 'rejected':
      return { text: '✕ rejected', bg: '#FBEDEB', fg: '#C03D33' };
    case 'failed':
      return { text: 'failed', bg: '#FBEDEB', fg: '#C03D33' };
  }
}

/** Header badge / banner copy: "N approval pending" (singular) / "N approvals pending". */
export function pendingLabel(n: number): string {
  return `${n} ${n === 1 ? 'approval pending' : 'approvals pending'}`;
}

export interface ApprovalListCard {
  id: string;
  title: string;
  /** queuedAt date shown in the card's age slot; null → omit (no fabricated relative age). */
  age: string | null;
  /** Verbatim provenance = the left-card origin slot; null → omit (no fabricated origin). */
  origin: string | null;
  /** Real project attribution (ApprovalInfo.projectId); null = unattributed / global entry. */
  project: string | null;
}

export function toListCard(a: ApprovalInfo): ApprovalListCard {
  return { id: a.id, title: a.title, age: a.queuedAt, origin: a.provenance, project: a.projectId };
}

export interface ApprovalDetailVm {
  id: string;
  title: string;
  pill: ApprovalPill;
  /** "queued <date>" or null when queuedAt is absent. */
  queued: string | null;
  operation: string;
  reason: string;
  impact: string;
  /** Raw Command/Action string for the mono block; null when absent. */
  command: string | null;
  hasCommand: boolean;
  /** Parenthetical feedback captured from a rejected entry (resolved entries only). */
  feedback: string | null;
  /** Verbatim provenance = the detail meta-row `from` slot; null → omit (no fabricated origin). */
  origin: string | null;
  /** Parsed 4-hex task ref = the detail meta-row `task` slot; null → omit (no fabricated ref). */
  task: string | null;
  /** Real project attribution (ApprovalInfo.projectId); null = unattributed / global entry. */
  project: string | null;
}

export function toDetail(a: ApprovalInfo): ApprovalDetailVm {
  const command = a.command;
  return {
    id: a.id,
    title: a.title,
    project: a.projectId,
    pill: statusPill(a.status),
    queued: a.queuedAt ? `queued ${a.queuedAt}` : null,
    operation: a.operation ?? DASH,
    reason: a.reason ?? DASH,
    impact: a.impact ?? DASH,
    command,
    hasCommand: command != null && command.trim() !== '',
    feedback: a.feedback,
    origin: a.provenance,
    task: a.taskRef,
  };
}

/** Keep the current selection if it still exists, else default to the first entry (or null). */
export function defaultSelectedId(entries: ApprovalInfo[], current: string | null): string | null {
  if (current && entries.some((e) => e.id === current)) return current;
  return entries[0]?.id ?? null;
}
