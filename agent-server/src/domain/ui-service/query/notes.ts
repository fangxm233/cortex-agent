import { t } from '@core/i18n.js';
import * as path from 'node:path';
import { projectNotesRepository } from '@store/project-notes-repo.js';
import type { NoteInfo, UiServiceDeps, QueryParams } from '../types.js';

function notFound(projectId: string): Error {
  return Object.assign(new Error(t('ui.project.notFound', { id: projectId })), { code: 'not-found' });
}

export function resolveNotesPath(deps: UiServiceDeps, projectId: string): string {
  const project = deps.projectStore.get(projectId);
  if (!project) throw notFound(projectId);
  return path.join(project.contextDir, 'NOTES.md');
}

export async function handleNotesList(
  deps: UiServiceDeps,
  params: QueryParams<'notes.list'>,
): Promise<NoteInfo[]> {
  return projectNotesRepository.list(resolveNotesPath(deps, params.projectId));
}
