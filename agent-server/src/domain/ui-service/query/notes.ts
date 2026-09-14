import * as path from 'node:path';
import { projectNotesRepository } from '@store/project-notes-repo.js';
import type { NoteInfo, NotesListParams, UiServiceDeps } from '../types.js';

function notFound(projectId: string): Error {
  return Object.assign(new Error(`Project not found: ${projectId}`), { code: 'not-found' });
}

export function resolveNotesPath(deps: UiServiceDeps, projectId: string): string {
  const project = deps.projectStore.get(projectId);
  if (!project) throw notFound(projectId);
  return path.join(project.contextDir, 'NOTES.md');
}

export async function handleNotesList(
  deps: UiServiceDeps,
  params: NotesListParams,
): Promise<NoteInfo[]> {
  return projectNotesRepository.list(resolveNotesPath(deps, params.projectId));
}
