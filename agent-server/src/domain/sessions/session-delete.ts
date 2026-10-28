import { createLogger } from '@core/log.js';
import type { Session } from '@store/session-registry-repo.js';
import { commitDeletes, prepareDeleteCleanup, type SessionDeleteCommitDeps } from './session-retention.js';

const log = createLogger('session-delete');

export interface SessionDeleteDeps extends SessionDeleteCommitDeps {
  /** Sessions in use right now: a live execution, a background hold, a turn's lease. */
  busySessionIds: () => Iterable<string>;
  /** Settle what still waits on an idle session (a pending question or plan, a promised resume)
   *  before it goes. Absent ⇒ skipped. */
  settleSession?: (session: Session) => Promise<void>;
}

export type SessionDeleteResult =
  | { ok: true; deletedIds: string[] }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'busy'; busyIds: string[] };

/** The sessions deleting `ids` takes: each live one and, for a lead, its workers. */
export async function sessionDeleteTargets(
  registry: SessionDeleteDeps['registry'],
  ids: Iterable<string>,
): Promise<Session[]> {
  const targets = new Map<string, Session>();
  for (const id of new Set(ids)) {
    const session = await registry.getById(id);
    if (!session) continue;
    targets.set(id, session);
    for (const worker of await registry.listWorkers(id)) targets.set(worker.sessionId, worker);
  }
  return [...targets.values()];
}

export function busySessionsAmong(deps: Pick<SessionDeleteDeps, 'busySessionIds'>, sessions: Session[]): string[] {
  const busy = new Set(deps.busySessionIds());
  return sessions.map(session => session.sessionId).filter(id => busy.has(id));
}

/**
 * Delete sessions the user picked, through the retention pipeline's crash-safe steps: delete
 * intents first, then the channel release, the files and the commit. Unlike retention, a star or a
 * board binding does not keep a session, but one in use is refused whole — stop it first.
 *
 * A session whose cleanup fails stays pending: it is already gone from every list, and the next
 * retention sweep finishes it.
 */
export async function deleteSessions(deps: SessionDeleteDeps, ids: Iterable<string>): Promise<SessionDeleteResult> {
  const targets = await sessionDeleteTargets(deps.registry, ids);
  if (targets.length === 0) return { ok: false, reason: 'not-found' };
  const busyIds = busySessionsAmong(deps, targets);
  if (busyIds.length > 0) return { ok: false, reason: 'busy', busyIds };
  for (const session of targets) await deps.settleSession?.(session);
  const pending = await deps.registry.beginDelete(
    targets.map(session => session.sessionId),
    (session, turns) => prepareDeleteCleanup(deps, session, turns),
  );
  const errors: string[] = [];
  const committed = await commitDeletes(deps, pending, errors);
  if (errors.length > 0) {
    log.warn(`Deleted ${committed}/${pending.length} session(s); the rest finish at the next sweep: ${errors.join('; ')}`);
  }
  return { ok: true, deletedIds: pending.map(entry => entry.session.sessionId) };
}
