import { createLogger } from '@core/log.js';
import type { Session } from '@store/session-registry-repo.js';
import {
  busySessionsAmong, deleteSessions, sessionDeleteTargets, type SessionDeleteDeps,
} from '@domain/sessions/session-delete.js';
import type { ProjectStore } from './project-store.js';

const log = createLogger('project-delete');

export interface ProjectDeleteDeps {
  projects: Pick<ProjectStore, 'get' | 'removeProject'>;
  sessions: SessionDeleteDeps;
  listProjectSessions: (projectId: string) => Promise<Session[]>;
  /** The project's schedules: listed, then removed one by one (disarming their timers). */
  schedules: {
    listIds: (projectId: string) => Promise<string[]>;
    remove: (scheduleId: string) => Promise<unknown>;
  };
  /** Unbind the project's IM channels so inbound messages stop resolving to it. */
  unbindConduits: (projectId: string) => Promise<void>;
  /** Drop the project's records in other stores: boards, machine directories, budget override. */
  forgetProject: (projectId: string) => Promise<void>;
}

export type ProjectDeleteResult =
  | { ok: true; sessions: number; schedules: number }
  | { ok: false; reason: 'not-found' | 'protected' }
  | { ok: false; reason: 'busy'; busyIds: string[] };

/**
 * Delete a project with everything filed under it: its schedules go first so none fires midway,
 * then its IM bindings, its sessions, its records elsewhere and finally its context directory.
 * Each step is idempotent, so a delete interrupted midway is finished by running it again. Cost,
 * execution and waitpoint history keep the old id.
 */
export async function deleteProject(deps: ProjectDeleteDeps, projectId: string): Promise<ProjectDeleteResult> {
  const project = deps.projects.get(projectId);
  if (!project) return { ok: false, reason: 'not-found' };
  if (project.kind !== 'user') return { ok: false, reason: 'protected' };
  const sessionIds = (await deps.listProjectSessions(projectId)).map(session => session.sessionId);
  const busyIds = busySessionsAmong(deps.sessions, await sessionDeleteTargets(deps.sessions.registry, sessionIds));
  if (busyIds.length > 0) return { ok: false, reason: 'busy', busyIds };

  const scheduleIds = await deps.schedules.listIds(projectId);
  for (const id of scheduleIds) await deps.schedules.remove(id);
  await deps.unbindConduits(projectId);
  const deleted = sessionIds.length > 0 ? await deleteSessions(deps.sessions, sessionIds) : null;
  if (deleted && 'busyIds' in deleted) return deleted;
  await deps.forgetProject(projectId);
  await deps.projects.removeProject(projectId);
  const sessions = deleted && 'deletedIds' in deleted ? deleted.deletedIds.length : 0;
  log.info(`Deleted project ${projectId}: ${sessions} session(s), ${scheduleIds.length} schedule(s)`);
  return { ok: true, sessions, schedules: scheduleIds.length };
}
