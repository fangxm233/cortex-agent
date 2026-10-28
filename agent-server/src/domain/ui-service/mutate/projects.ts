import { t } from '@core/i18n.js';
import type { UiServiceDeps, Result, ProjectCreateReturn, ProjectDeleteReturn } from '../types.js';

export async function handleCreateProject(
  deps: UiServiceDeps,
  args: { name: string },
): Promise<Result<ProjectCreateReturn>> {
  const created = deps.projectStore.createProject(args.name);
  if ('project' in created) {
    return { ok: true, data: { id: created.project.id } };
  }
  return { ok: false, code: created.code, message: created.message };
}

export async function handleDeleteProject(
  deps: UiServiceDeps,
  args: { projectId: string },
): Promise<Result<ProjectDeleteReturn>> {
  const result = await deps.deleteProject(args.projectId);
  if ('sessions' in result) return { ok: true, data: { sessions: result.sessions, schedules: result.schedules } };
  if ('busyIds' in result) return { ok: false, code: 'session-running', message: t('ui.project.runningDelete') };
  if (result.reason === 'protected') return { ok: false, code: 'invalid-args', message: t('ui.project.protected') };
  return { ok: false, code: 'not-found', message: t('ui.project.notFound', { id: args.projectId }) };
}
