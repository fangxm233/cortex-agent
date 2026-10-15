import type { SessionInfo } from '@cortex-agent/ui-contract';
import { orderSessions } from '@/features/session/list/session-groups';

// A worker is an ordinary direct session that names its lead (SessionInfo.teamLeadId). Lists nest
// workers under their lead only when that lead is in the SAME list — a worker whose lead is pruned,
// starred elsewhere or scoped out stays a plain row, so no session ever drops out of view. Nesting is
// one level deep: a lead that is itself nested keeps its own workers flat beside it.

export interface WorkerGrouping {
  /** Rows at the list's own level: ordinary sessions, leads and orphaned workers, in input order. */
  top: SessionInfo[];
  /** Lead sessionId → its workers: active ones in list order, inactive ones last. */
  workers: Map<string, SessionInfo[]>;
}

/** How long a worker with nothing running or pending stays in view after its last activity. The
 *  server folds its lead's roster by the same age (`WORKER_FOLD_MS` in agent-server
 *  `domain/sessions/team.ts`). */
export const WORKER_FOLD_MS = 3 * 60 * 60 * 1000;

/** A worker with nothing running or pending whose last activity is older than the fold age. Never a
 *  session that is not a worker. */
export function isInactiveWorker(s: SessionInfo, now: number = Date.now()): boolean {
  if (!s.teamLeadId || s.running || s.awaitingInput || (s.waitingOnLead ?? 0) > 0 || (s.waitingOn ?? 0) > 0) return false;
  const at = Date.parse(s.lastUsedAt);
  return !Number.isNaN(at) && now - at > WORKER_FOLD_MS;
}

/** Active first (unread, then recency — the list's own order), inactive after. */
export function orderWorkers(workers: SessionInfo[], now: number = Date.now()): SessionInfo[] {
  const ordered = orderSessions(workers);
  const inactive = (w: SessionInfo) => isInactiveWorker(w, now);
  return [...ordered.filter((w) => !inactive(w)), ...ordered.filter(inactive)];
}

export function groupWorkers(sessions: SessionInfo[], now: number = Date.now()): WorkerGrouping {
  const ids = new Set(sessions.map((s) => s.sessionId));
  const leadOf = (s: SessionInfo): string | null =>
    s.teamLeadId && s.teamLeadId !== s.sessionId && ids.has(s.teamLeadId) ? s.teamLeadId : null;
  // Only a session that is not itself nested may hold workers.
  const roots = new Set(sessions.filter((s) => leadOf(s) === null).map((s) => s.sessionId));
  const top: SessionInfo[] = [];
  const workers = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const lead = leadOf(s);
    if (lead === null || !roots.has(lead)) {
      top.push(s);
      continue;
    }
    const list = workers.get(lead);
    if (list) list.push(s);
    else workers.set(lead, [s]);
  }
  for (const [lead, list] of workers) workers.set(lead, orderWorkers(list, now));
  return { top, workers };
}

/** A lead's workers out of a session list — what the lead's own view shows. */
export function workersOf(leadId: string, sessions: SessionInfo[], now: number = Date.now()): SessionInfo[] {
  return orderWorkers(sessions.filter((s) => s.teamLeadId === leadId && s.sessionId !== leadId), now);
}

export interface TeamContext {
  /** The open session's lead, when it is a worker and the lead is in the list. */
  lead: SessionInfo | null;
  /** The open session's own workers (inactive included; the strip drops those). */
  workers: SessionInfo[];
}

const NO_TEAM: TeamContext = { lead: null, workers: [] };

/** What a chat view shows of the team around the open session — nothing at all with team mode off. */
export function teamContext(enabled: boolean, active: SessionInfo | null, sessions: SessionInfo[]): TeamContext {
  if (!enabled || !active) return NO_TEAM;
  const lead = active.teamLeadId && active.teamLeadId !== active.sessionId
    ? sessions.find((s) => s.sessionId === active.teamLeadId) ?? null
    : null;
  const workers = workersOf(active.sessionId, sessions);
  return lead || workers.length > 0 ? { lead, workers } : NO_TEAM;
}
