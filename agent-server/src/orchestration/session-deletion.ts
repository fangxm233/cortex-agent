import * as path from 'node:path';
import { DATA_DIR, WORKSPACE_DIR } from '@core/paths.js';
import { runRegistry } from '@core/run-registry.js';
import { sessionHolds } from '@core/session-holds.js';
import type { EventBus } from '@events/index.js';
import { boardRepo } from '@store/board-repo.js';
import { CONVERSATION_HISTORY_DIR, conversationHistory } from '@store/conversation-history-repo.js';
import { pendingInjectionRepo } from '@store/pending-injection-repo.js';
import { projectDirRepo } from '@store/project-dir-repo.js';
import { sessionStore, type Session } from '@store/session-registry-repo.js';
import { teamInboxRepo } from '@store/team-inbox-repo.js';
import { teamOutboxRepo } from '@store/team-outbox-repo.js';
import { TOOL_IMAGES_DIR } from '@store/tool-image-files.js';
import { clearProjectBudget } from '@domain/costs/cost-tracker.js';
import { removeDirectResumesForSessions } from '@domain/costs/resume-registry.js';
import { projectStore } from '@domain/projects/index.js';
import { deleteProject, type ProjectDeleteResult } from '@domain/projects/project-delete.js';
import type { Scheduler } from '@domain/scheduling/scheduler.js';
import { deleteSessions, type SessionDeleteDeps, type SessionDeleteResult } from '@domain/sessions/session-delete.js';
import type { SessionRetentionPaths } from '@domain/sessions/session-retention.js';
import { getProjectDir } from '@domain/sessions/session-transcript.js';
import { activeSessionUseIds } from '@domain/sessions/session-use.js';
import { cancelWaitpointsForSessions } from '@domain/waitpoints/service.js';
import { interactionRecords } from './interactions/interaction-records.js';
import { forgetTeamSessions } from './team-state.js';

/** Where a session's files live — shared by the retention sweep and a user's delete. */
export function sessionFilePaths(): SessionRetentionPaths {
  return {
    historyDir: CONVERSATION_HISTORY_DIR,
    piSessionsDir: path.join(DATA_DIR, 'logs', 'sessions-pi'),
    claudeCaptureDir: path.join(DATA_DIR, 'logs', 'sessions'),
    claudeProjectDir: getProjectDir(),
    toolImagesDir: TOOL_IMAGES_DIR,
    sessionDirRoots: [
      path.join(WORKSPACE_DIR, 'outputs'),
      path.join(WORKSPACE_DIR, 'attachments'),
      TOOL_IMAGES_DIR,
    ],
  };
}

/** What other stores keep about deleted sessions: queued injections and team mail. */
export async function forgetDeletedSessions(sessionIds: string[]): Promise<void> {
  await pendingInjectionRepo.removeBySessionIds(sessionIds);
  await teamInboxRepo.forgetSessions(sessionIds);
  await teamOutboxRepo.forgetSessions(sessionIds);
  forgetTeamSessions(sessionIds);
}

function busySessionIds(): string[] {
  const busy = new Set<string>(activeSessionUseIds());
  for (const execution of runRegistry.getAll()) if (execution.trackSessionId) busy.add(execution.trackSessionId);
  for (const id of sessionHolds.listIds()) busy.add(id);
  return [...busy];
}

/** An idle session can still have a question or plan waiting on the user, or a promised resume. */
async function settleSession(session: Session): Promise<void> {
  await interactionRecords.resolvePendingBySession(session.sessionId, 'cancelled', 'web');
  removeDirectResumesForSessions([session.sessionId]);
}

function sessionDeleteDeps(): SessionDeleteDeps {
  return {
    registry: sessionStore,
    historyRepo: conversationHistory,
    cancelWaitpoints: (ids) => cancelWaitpointsForSessions(ids),
    forgetSessions: forgetDeletedSessions,
    paths: sessionFilePaths(),
    busySessionIds,
    settleSession,
  };
}

async function forgetProject(projectId: string): Promise<void> {
  await boardRepo.removeByProject(projectId);
  await projectDirRepo.removeProject(projectId);
  await clearProjectBudget(projectId);
}

export interface SessionDeletionWiring {
  bus: Pick<EventBus, 'publish'>;
  scheduler: Pick<Scheduler, 'list' | 'remove'>;
  unbindConduits: (projectId: string) => Promise<void>;
}

export interface SessionDeletion {
  deleteSession: (sessionId: string) => Promise<SessionDeleteResult>;
  deleteProject: (projectId: string) => Promise<ProjectDeleteResult>;
}

export function createSessionDeletion(w: SessionDeletionWiring): SessionDeletion {
  return {
    async deleteSession(sessionId) {
      const projectId = (await sessionStore.getById(sessionId))?.projectId ?? 'general';
      const result = await deleteSessions(sessionDeleteDeps(), [sessionId]);
      if ('deletedIds' in result) w.bus.publish({ type: 'session.deleted', sessionIds: result.deletedIds, projectId });
      return result;
    },
    async deleteProject(projectId) {
      const result = await deleteProject({
        projects: projectStore,
        sessions: sessionDeleteDeps(),
        listProjectSessions: (id) => sessionStore.listByProject(id),
        schedules: {
          listIds: async (id) => (await w.scheduler.list()).filter(task => task.projectId === id).map(task => task.id),
          remove: (id) => w.scheduler.remove(id),
        },
        unbindConduits: w.unbindConduits,
        forgetProject,
      }, projectId);
      if ('sessions' in result) w.bus.publish({ type: 'project.deleted', projectId });
      return result;
    },
  };
}
