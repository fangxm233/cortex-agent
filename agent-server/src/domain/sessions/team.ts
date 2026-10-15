import { getSettings } from '@core/settings.js';

/** The most workers one lead may have running at once. Pi workers run inside the daemon process. */
export const MAX_RUNNING_WORKERS = 8;

/** A worker's name: a short slug, unique within its lead's team. */
export const WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A worker with nothing running or pending folds out of its lead's roster after this long idle.
 *  The web client folds by the same rule (`web/src/features/team/worker-groups.ts`). */
export const WORKER_FOLD_MS = 3 * 60 * 60 * 1000;

/** Whether a worker's last activity (`lastUsedAt`, stamped as a turn opens and ends) is old enough to
 *  fold. The caller checks it has nothing running or pending. */
export function isWorkerStale(worker: { lastUsedAt: string }, now: number): boolean {
  const at = Date.parse(worker.lastUsedAt);
  return !Number.isNaN(at) && now - at > WORKER_FOLD_MS;
}

interface TeamSessionFields {
  origin?: string | null;
  channel?: string | null;
  teamLeadId?: string | null;
}

/**
 * Whether a session may lead a team: team mode is on and it is a web direct session that is not
 * itself a worker. No per-session flag — every qualifying session gets the worker tools, and one
 * with no workers otherwise looks like any other session.
 */
export function isTeamLead(
  session: TeamSessionFields | null | undefined,
  enabled: boolean = getSettings().teamEnabled,
): boolean {
  return enabled
    && !!session
    && (session.origin ?? 'direct') === 'direct'
    && !!session.channel?.startsWith('web:')
    && !session.teamLeadId;
}

/** Whether a session acts as a worker right now. With team mode off a worker is an ordinary session. */
export function isTeamWorker(
  session: TeamSessionFields | null | undefined,
  enabled: boolean = getSettings().teamEnabled,
): boolean {
  return enabled && !!session?.teamLeadId;
}
