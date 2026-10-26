// Clean-mode children: which delegated tasks get a workspace of their own, what is copied into it,
// and how the parent learns where the child left its work. Shared by the daemon runner and the
// in-process PI tool, so a clean child behaves the same whichever side launched it.

import { existsSync } from 'node:fs';
import { copyIntoInputs, createWorkspace, resolveGivenPath } from '../../workspace.js';
import type { Invocation, SubagentResult, SubagentTask } from './types.js';

export interface CleanTaskContext {
  /** Where relative `files` paths resolve: the delegating agent's working directory. */
  cwd: string;
  /** The delegating session's own workspace when it is clean; its children are clean and share it. */
  parentWorkspace: string | null;
}

/**
 * Settle every task's clean mode before any child starts. A task is clean when it asks to be, when
 * it is given files, or when its parent is clean; its files become absolute paths. A path that does
 * not exist rejects the whole call: a half-run fan-out is worse than none.
 */
export function prepareCleanTasks(invocation: Invocation, context: CleanTaskContext): Invocation {
  return { ...invocation, tasks: invocation.tasks.map((task) => prepareTask(task, context)) };
}

function prepareTask(task: SubagentTask, context: CleanTaskContext): SubagentTask {
  const files = (task.files ?? []).map((given) => {
    const resolved = resolveGivenPath(given, context.cwd);
    if (!existsSync(resolved)) throw new Error(`Agent task file not found: ${given}`);
    return resolved;
  });
  const clean = task.clean === true || files.length > 0 || context.parentWorkspace !== null;
  if (!clean) return task;
  return { ...task, clean: true, ...(files.length > 0 ? { files } : {}) };
}

/** Folder-name-safe form of a run id; tool-call ids carry characters a path should not. */
function safeId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'run';
}

/**
 * The workspace a prepared task runs in, with its files copied into `inputs/`: the parent's own
 * when the parent is clean, else a new `sub-<runId>-<index>` folder. Null for a task that is not
 * clean — it runs where its parent does.
 */
export async function openChildWorkspace(
  task: SubagentTask,
  where: { parentWorkspace: string | null; runId: string; index: number },
): Promise<string | null> {
  if (!task.clean) return null;
  const workspace = where.parentWorkspace ?? createWorkspace(`sub-${safeId(where.runId)}-${where.index}`);
  for (const file of task.files ?? []) await copyIntoInputs(workspace, file);
  return workspace;
}

/** The child's result with its workspace named at the end, so the parent can collect its output. */
export function withWorkspaceNote(result: SubagentResult, workspace: string | null): SubagentResult {
  if (!workspace) return result;
  const note = `Workspace: ${workspace}`;
  return { ...result, output: result.output ? `${result.output}\n\n${note}` : note };
}
