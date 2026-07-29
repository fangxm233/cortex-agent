// input:  notes mutation args, project path resolver, projectNotesRepository
// output: Result envelopes for add/edit/complete/delete/clear operations
// pos:    Write handlers for user-private project notes
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { projectNotesRepository } from '@store/project-notes-repo.js';
import type {
  NoteActionArgs,
  NoteAddArgs,
  NoteInfo,
  NotesClearCompletedArgs,
  NotesClearCompletedReturn,
  NotesDeleteReturn,
  NoteSetCompletedArgs,
  NoteUpdateArgs,
  Result,
  UiServiceDeps,
} from '../types.js';
import { resolveNotesPath } from '../query/notes.js';

async function asResult<T>(operation: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error: any) {
    const known = ['not-found', 'invalid-args', 'invalid-notes-file'];
    const code = known.includes(error?.code) ? error.code : 'internal';
    return { ok: false, code, message: error?.message || String(error) };
  }
}

export async function handleNotesAdd(deps: UiServiceDeps, args: NoteAddArgs): Promise<Result<NoteInfo>> {
  return asResult(() => projectNotesRepository.add(resolveNotesPath(deps, args.projectId), args.text));
}

export async function handleNotesUpdate(deps: UiServiceDeps, args: NoteUpdateArgs): Promise<Result<NoteInfo>> {
  return asResult(() => projectNotesRepository.update(resolveNotesPath(deps, args.projectId), args.id, args.text));
}

export async function handleNotesSetCompleted(
  deps: UiServiceDeps,
  args: NoteSetCompletedArgs,
): Promise<Result<NoteInfo>> {
  return asResult(() => projectNotesRepository.setCompleted(
    resolveNotesPath(deps, args.projectId),
    args.id,
    args.completed,
  ));
}

export async function handleNotesDelete(
  deps: UiServiceDeps,
  args: NoteActionArgs,
): Promise<Result<NotesDeleteReturn>> {
  return asResult(async () => {
    await projectNotesRepository.delete(resolveNotesPath(deps, args.projectId), args.id);
    return { id: args.id, deleted: true };
  });
}

export async function handleNotesClearCompleted(
  deps: UiServiceDeps,
  args: NotesClearCompletedArgs,
): Promise<Result<NotesClearCompletedReturn>> {
  return asResult(async () => ({
    cleared: await projectNotesRepository.clearCompleted(resolveNotesPath(deps, args.projectId)),
  }));
}
