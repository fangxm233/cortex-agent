// input:  fs/path, git process, task generation, lifecycle storage
// output: ownership-first completeTask/uncompleteTask transitions
// pos:    Verifies completion ownership, state and evidence
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { type Task, type TaskGenerationExpectation } from '@core/task-parser.js';
import { DATA_DIR, INSTALL_ROOT, PROJECTS_DIR, STORE_DIR, WORKSPACE_DIR } from '@core/utils.js';
import {
  clearDependsOnAll, findTask, getTasksPath, readTasks, taskFileProjects,
  withTaskFileMutationLock, withTaskFileMutationLocks, writeTasks,
} from './task-lifecycle-edit.js';

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(fs.readFileSync(filePath, 'utf8'))) ?? {};
  } catch {
    return {};
  }
}

function readConfiguredProjectRepos(project: string): string[] {
  const data = readJsonRecord(path.join(STORE_DIR, 'project-dirs.json'));
  const configured = asRecord(data[project]);
  if (!configured) return [];
  return Object.values(configured).filter((value): value is string => typeof value === 'string');
}

function hasVerifiedImplementationSha(note: string, project: string): boolean {
  const refs = extractExplicitShas(note).map((sha) => `${sha}^{commit}`);
  if (refs.length === 0) return false;
  const input = `${refs.join('\n')}\n`;
  const repos = [...new Set([process.cwd(), INSTALL_ROOT, DATA_DIR, ...readConfiguredProjectRepos(project)])];
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

function currentThreadArtifactPath(threads: Record<string, unknown>): string | null {
  const threadId = process.env.CORTEX_THREAD_ID;
  if (!threadId || !/^thr_[a-zA-Z0-9_-]+$/.test(threadId)) return null;
  const persisted = asRecord(threads[threadId])?.artifactPath;
  return typeof persisted === 'string'
    ? persisted
    : path.join(WORKSPACE_DIR, 'threads', threadId, 'artifact.md');
}

function matchingTaskArtifactPath(value: unknown, project: string, taskId: string): string | null {
  const thread = asRecord(value);
  const metadata = asRecord(thread?.metadata);
  if (!thread || !metadata) return null;
  const matches = metadata.taskId === taskId && metadata.taskProject === project;
  return matches && typeof thread.artifactPath === 'string' ? thread.artifactPath : null;
}

function completionArtifactPaths(project: string, taskId: string | null): string[] {
  const threads = readJsonRecord(path.join(STORE_DIR, 'threads.json'));
  const current = currentThreadArtifactPath(threads);
  const taskPaths = taskId
    ? Object.values(threads)
      .map((value) => matchingTaskArtifactPath(value, project, taskId))
      .filter((value): value is string => value !== null)
    : [];
  return [...new Set([...(current ? [current] : []), ...taskPaths])];
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

function hasCompletionArtifact(project: string, taskId: string | null): boolean {
  return completionArtifactPaths(project, taskId).some(isNonEmptyAuthorizedFile);
}

function verifyCompletionEvidence(
  project: string,
  taskId: string | null,
  doneWhen: string | null,
  completionNote: string,
): boolean {
  return hasVerifiedImplementationSha(completionNote, project)
    || hasCompletionArtifact(project, taskId)
    || hasTaskCommit(taskId)
    || hasDoneWhenArtifact(doneWhen);
}

function completionStateError(task: Task): string | null {
  if (task.status === 'done') return 'Task is already completed';
  if (task.paused) return 'Cannot complete a paused task — resume it first';
  if (task.blocked_by) return 'Cannot complete a blocked task — unblock it first';
  return null;
}

function loadCompletionTask(taskText: string | null, project: string, taskId: string | null) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { error: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  return 'error' in found ? found : { tasks, task: found.task };
}

function completionWarning(
  project: string, task: Task, completionNote: string,
  skipVerify: boolean, skipVerifyReason: string | null,
): string | null {
  if (skipVerify) return `verify skipped: ${skipVerifyReason ?? 'no reason given'}`;
  if (verifyCompletionEvidence(project, task.id, task.done_when, completionNote)) return null;
  return 'no evidence of work: no verified implementation SHA, persisted thread artifact, matching git commit, or Done-when artifact. Re-run with --skip-verify to bypass.';
}

function markTaskCompleted(
  task: Task, completionNote: string, completedAt: string,
  ownership: TaskGenerationExpectation | undefined,
): void {
  task.status = 'done';
  task.claimed_by = null;
  task.claimed_at = null;
  task.dispatch_generation = ownership?.generation ?? null;
  task.blocked_by = null;
  task.approval_needed = false;
  task.paused = false;
  task.pending_at = null;
  task.completed_at = completedAt;
  task.completed_note = completionNote || null;
}

function completeTaskUnlocked(
  taskText: string | null, project: string,
  completionNote: string = '', taskId: string | null = null,
  skipVerify: boolean = false, skipVerifyReason: string | null = null,
  ownership?: TaskGenerationExpectation,
) {
  const loaded = loadCompletionTask(taskText, project, taskId);
  if ('error' in loaded) return { success: false, message: loaded.error };
  const { task, tasks } = loaded;
  if (ownership && task.dispatch_generation !== ownership.generation) {
    return { success: false, message: 'Stale task dispatch generation; completion ignored', stale: true };
  }
  const stateError = completionStateError(task);
  if (stateError) return { success: false, message: stateError };
  const verifyWarning = completionWarning(project, task, completionNote, skipVerify, skipVerifyReason);
  const completedAt = new Date().toISOString();
  const today = completedAt.slice(0, 10);
  markTaskCompleted(task, completionNote, completedAt, ownership);
  writeTasks(project, tasks);

  const unblockResult = task.id ? clearDependsOnAll(task.id) : { count: 0, tasks: [] };
  let message = `Task completed on ${today}`;
  if (unblockResult.count > 0) {
    const details = unblockResult.tasks.map((t) => `  ${t.taskId ? `[${t.taskId}]` : '(?)'} ${t.project}: ${t.preview}`).join('\n');
    message += ` (unblocked ${unblockResult.count} dependent task(s)):\n${details}`;
  }
  return { success: true, message, task_id: task.id, unblocked: unblockResult.tasks, verify_warning: verifyWarning };
}

function uncompleteTaskUnlocked(
  taskText: string | null, project: string, taskId: string | null = null,
  ownership?: TaskGenerationExpectation,
) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;
  if (ownership && task.dispatch_generation !== ownership.generation) {
    return { success: false, message: 'Stale task dispatch generation; mutation ignored', stale: true };
  }

  if (task.status !== 'done') return { success: false, message: 'Task is not completed' };

  task.status = 'open';
  task.completed_at = null;
  task.completed_note = null;
  task.dispatch_generation = null;
  writeTasks(project, tasks);
  return { success: true, message: 'Task marked as incomplete' };
}

function lockCompletionMutation<T extends (...args: any[]) => any>(mutation: T): T {
  return ((...args: Parameters<T>) => withTaskFileMutationLock(
    args[1], () => mutation(...args),
  )) as T;
}

const completeTask = ((...args: Parameters<typeof completeTaskUnlocked>) =>
  withTaskFileMutationLocks(
    [...taskFileProjects(), args[1]], () => completeTaskUnlocked(...args),
  )) as typeof completeTaskUnlocked;
const uncompleteTask = lockCompletionMutation(uncompleteTaskUnlocked);

export { completeTask, uncompleteTask };
