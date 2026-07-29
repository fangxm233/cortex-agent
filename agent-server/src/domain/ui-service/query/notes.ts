// input:  UiServiceDeps, NotesListParams, projectNotesRepository
// output: resolved project NOTES.md entries
// pos:    Read handler for user-private project notes
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

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
