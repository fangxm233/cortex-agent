// input:  node fs/path/child_process, core paths, task lifecycle
// output: completeTask/uncompleteTask lifecycle transitions
// pos:    verifies bounded commit and confined artifact evidence
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { type Task } from '@core/task-parser.js';
import { DATA_DIR, INSTALL_ROOT, PROJECTS_DIR, STORE_DIR, WORKSPACE_DIR, todayISO } from '@core/utils.js';
import { clearDependsOnAll, findTask, getTasksPath, readTasks, writeTasks } from './task-lifecycle-edit.js';

const EXPLICIT_SHA = /\b(?:implementation\s+sha|commit(?:\s+sha)?|sha)\s*[:=#]?\s*`?([0-9a-f]{7,40})(?![0-9a-f])`?/gi;

function runGit(repo: string, args: string[], input?: string): string | null {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function extractExplicitShas(note: string): string[] {
  const shas = [...note.matchAll(EXPLICIT_SHA)].map((match) => match[1].toLowerCase());
  return [...new Set(shas)];
}

function hasVerifiedImplementationSha(note: string): boolean {
  const refs = extractExplicitShas(note).map((sha) => `${sha}^{commit}`);
  if (refs.length === 0) return false;
  const input = `${refs.join('\n')}\n`;
  const repos = [...new Set([process.cwd(), INSTALL_ROOT, DATA_DIR])];
  return repos.some((repo) =>
    runGit(repo, ['cat-file', '--batch-check=%(objecttype)'], input)?.split('\n').includes('commit') === true,
  );
}

function hasTaskCommit(taskId: string | null): boolean {
  if (!taskId) return false;
  const out = runGit(DATA_DIR, ['log', '--oneline', `--grep=${taskId}`]);
  if (out === null) return false;
  return out.split('\n').filter(Boolean)
    .some((line) => !/task-store:\s+(claim|unclaim)/i.test(line));
}

function hasDoneWhenArtifact(doneWhen: string | null): boolean {
  if (!doneWhen) return false;
  const tokens = doneWhen.match(/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_/.-]+/g) ?? [];
  return tokens.some((token) => fs.existsSync(path.join(DATA_DIR, token)));
}

function readPersistedArtifactPath(threadId: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(STORE_DIR, 'threads.json'), 'utf8'));
    const artifactPath = data[threadId]?.artifactPath;
    return typeof artifactPath === 'string' ? artifactPath : null;
  } catch {
    return null;
  }
}

function isInsideRoot(realFile: string, root: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    return realFile === realRoot || realFile.startsWith(`${realRoot}${path.sep}`);
  } catch {
    return false;
  }
}

function isNonEmptyAuthorizedFile(filePath: string): boolean {
  try {
    const realFile = fs.realpathSync(filePath);
    const authorized = [DATA_DIR, PROJECTS_DIR].some((root) => isInsideRoot(realFile, root));
    return authorized && fs.statSync(realFile).isFile() && fs.readFileSync(realFile, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

function hasCurrentThreadArtifact(): boolean {
  const threadId = process.env.CORTEX_THREAD_ID;
  if (!threadId || !/^thr_[a-zA-Z0-9_-]+$/.test(threadId)) return false;
  const fallback = path.join(WORKSPACE_DIR, 'threads', threadId, 'artifact.md');
  return isNonEmptyAuthorizedFile(readPersistedArtifactPath(threadId) ?? fallback);
}

function verifyCompletionEvidence(
  taskId: string | null,
  doneWhen: string | null,
  completionNote: string,
): boolean {
  return hasVerifiedImplementationSha(completionNote)
    || hasCurrentThreadArtifact()
    || hasTaskCommit(taskId)
    || hasDoneWhenArtifact(doneWhen);
}

function completionStateError(task: Task): string | null {
  if (task.status === 'done') return 'Task is already completed';
  if (task.paused) return 'Cannot complete a paused task — resume it first';
  if (task.blocked_by) return 'Cannot complete a blocked task — unblock it first';
  return null;
}

function loadCompletableTask(taskText: string | null, project: string, taskId: string | null) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { error: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return found;
  const stateError = completionStateError(found.task);
  return stateError ? { error: stateError } : { tasks, task: found.task };
}

function completionWarning(
  task: Task, completionNote: string, skipVerify: boolean, skipVerifyReason: string | null,
): string | null {
  if (skipVerify) return `verify skipped: ${skipVerifyReason ?? 'no reason given'}`;
  if (verifyCompletionEvidence(task.id, task.done_when, completionNote)) return null;
  return 'no evidence of work: no verified implementation SHA, current-thread artifact, matching git commit, or Done-when artifact. Re-run with --skip-verify to bypass.';
}

function markTaskCompleted(task: Task, completionNote: string, today: string): void {
  task.status = 'done';
  task.claimed_by = null;
  task.claimed_at = null;
  task.blocked_by = null;
  task.approval_needed = false;
  task.paused = false;
  task.pending_at = null;
  task.completed_at = today;
  task.completed_note = completionNote || null;
}

function completeTask(
  taskText: string | null, project: string,
  completionNote: string = '', taskId: string | null = null,
  skipVerify: boolean = false, skipVerifyReason: string | null = null,
) {
  const loaded = loadCompletableTask(taskText, project, taskId);
  if ('error' in loaded) return { success: false, message: loaded.error };
  const { task, tasks } = loaded;
  const verifyWarning = completionWarning(task, completionNote, skipVerify, skipVerifyReason);
  const today = todayISO();
  markTaskCompleted(task, completionNote, today);
  writeTasks(project, tasks);

  const unblockResult = task.id ? clearDependsOnAll(task.id) : { count: 0, tasks: [] };
  let message = `Task completed on ${today}`;
  if (unblockResult.count > 0) {
    const details = unblockResult.tasks.map((t) => `  ${t.taskId ? `[${t.taskId}]` : '(?)'} ${t.project}: ${t.preview}`).join('\n');
    message += ` (unblocked ${unblockResult.count} dependent task(s)):\n${details}`;
  }
  return { success: true, message, task_id: task.id, unblocked: unblockResult.tasks, verify_warning: verifyWarning };
}

function uncompleteTask(taskText: string | null, project: string, taskId: string | null = null) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;

  if (task.status !== 'done') return { success: false, message: 'Task is not completed' };

  task.status = 'open';
  task.completed_at = null;
  task.completed_note = null;
  writeTasks(project, tasks);
  return { success: true, message: 'Task marked as incomplete' };
}

export { completeTask, uncompleteTask };
