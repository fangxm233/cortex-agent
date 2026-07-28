import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR, listProjectDirs } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { loadConfig, listTemplateNames } from '../../threads/template-loader.js';
import { type LockState, type Task, parseTasksFile, parseTasksFileWithLock, serializeTasksFile, serializeTasksFileWithLock } from '@core/task-parser.js';

const log = createLogger('task-lifecycle');

// ── Atomic write ──

function atomicWriteSync(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

const sweptPaths = new Set<string>();

function sweepTaskOrphans(tasksPath: string): void {
  try {
    const dir = path.dirname(tasksPath);
    const base = path.basename(tasksPath);
    const prefix = `${base}.tmp.`;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(prefix)) {
        try { fs.unlinkSync(path.join(dir, entry)); } catch {}
      }
    }
  } catch {}
}

function ensureSwept(tasksPath: string): void {
  if (sweptPaths.has(tasksPath)) return;
  sweptPaths.add(tasksPath);
  sweepTaskOrphans(tasksPath);
}

// ── Template validation ──

const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);

let cachedTemplateNames: Set<string> | null = null;

const FORBIDDEN_TEMPLATES = new Set(['default', 'scheduler']);

function getValidTemplateNames(): Set<string> {
  if (cachedTemplateNames !== null) return cachedTemplateNames;
  try { loadConfig(); } catch { /* suppress loadConfig output */ }
  const allNames = listTemplateNames();
  cachedTemplateNames = new Set(allNames.filter((n) => !FORBIDDEN_TEMPLATES.has(n)));
  return cachedTemplateNames;
}

function _resetTemplateNameCacheForTests(): void {
  cachedTemplateNames = null;
}

function validateTemplateName(name: string): string | null {
  if (FORBIDDEN_TEMPLATES.has(name)) {
    return `Template '${name}' is forbidden. The 'default' and 'scheduler' templates are single-agent templates with no review pipeline and are not allowed for task dispatch. Use a multi-agent review template instead (e.g. stage-gate, coder-review, analyst-review).`;
  }
  const valid = getValidTemplateNames();
  if (valid.size === 0) return null;
  if (!valid.has(name)) {
    return `Unknown template: '${name}'. Valid templates: ${[...valid].sort().join(', ')}`;
  }
  return null;
}

// ── YAML file I/O ──

function getTasksPath(project: string): string {
  return path.join(PROJECTS_DIR, project, 'TASKS.yaml');
}

function readTasks(project: string): Task[] {
  const tasksPath = getTasksPath(project);
  if (!fs.existsSync(tasksPath)) return [];
  return parseTasksFile(fs.readFileSync(tasksPath, 'utf8'), project);
}

function writeTasks(project: string, tasks: Task[]): void {
  const tasksPath = getTasksPath(project);
  ensureSwept(tasksPath);
  let lock: LockState | null = null;
  if (fs.existsSync(tasksPath)) {
    const parsed = parseTasksFileWithLock(fs.readFileSync(tasksPath, 'utf8'), project);
    lock = parsed.lock;
  }
  atomicWriteSync(tasksPath, serializeTasksFileWithLock({ tasks, lock }));
}

function findTaskById(tasks: Task[], taskId: string): Task | undefined {
  return tasks.find((t) => t.id === taskId);
}

function findTask(tasks: Task[], taskText: string | null, taskId: string | null): { task: Task; index: number } | { error: string } {
  if (taskId) {
    const index = tasks.findIndex((t) => t.id === taskId);
    if (index >= 0) return { task: tasks[index], index };
  }
  if (taskText) {
    const needle = taskText.toLowerCase().trim();
    const matches: { task: Task; index: number }[] = [];
    for (const [index, t] of tasks.entries()) {
      const text = t.text.toLowerCase();
      if (needle.includes(text) || text.includes(needle)) {
        matches.push({ task: t, index });
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const previews = matches.map((m) => `  [${m.task.id}] ${m.task.text.substring(0, 80)}`).join('\n');
      return { error: `Ambiguous match: "${taskText}" matches ${matches.length} tasks. Use --task-id instead.\n${previews}` };
    }
  }
  return { error: `Task not found: ${taskId || taskText}` };
}

// ── Cross-project dependency clearing ──

function clearDependsOnAll(completedHash: string): { count: number; tasks: { taskId: string | null; project: string; preview: string }[] } {
  if (!fs.existsSync(PROJECTS_DIR)) return { count: 0, tasks: [] };
  const unblockedTasks: { taskId: string | null; project: string; preview: string }[] = [];

  for (const projectName of listProjectDirs()) {
    const tasksPath = path.join(PROJECTS_DIR, projectName, 'TASKS.yaml');
    if (!fs.existsSync(tasksPath)) continue;

    const tasks = parseTasksFile(fs.readFileSync(tasksPath, 'utf8'), projectName);
    let modified = false;
    for (const task of tasks) {
      const idx = task.depends_on.indexOf(completedHash);
      if (idx >= 0) {
        task.depends_on.splice(idx, 1);
        unblockedTasks.push({ taskId: task.id || null, project: projectName, preview: task.text.substring(0, 60) });
        modified = true;
      }
    }
    if (modified) {
      ensureSwept(tasksPath);
      atomicWriteSync(tasksPath, serializeTasksFile(tasks));
    }
  }
  return { count: unblockedTasks.length, tasks: unblockedTasks };
}

// ── Edit task ──

type TaskLineTransformResult = { success: true; message?: string; [k: string]: any } | { success: false; message: string };

function editTask(project: string, options: any = {}): TaskLineTransformResult {
  const {
    taskText = null,
    taskId = null,
    text = null,
    why = null,
    doneWhen = null,
    plan = null,
    priority = null,
    setDependsOn = null,
    addDependsOn = [],
    removeDependsOn = [],
    clearDependsOn = false,
  } = options;

  if (priority && !VALID_PRIORITIES.has(priority)) {
    return { success: false, message: `Invalid priority: ${priority}` };
  }

  const expandIdList = (list: string[] | null): string[] | null => {
    if (!list) return null;
    return list.flatMap((d: string) => d.includes(',') ? d.split(',').map((s) => s.trim()).filter(Boolean) : [d]);
  };
  const expandedSetDependsOn = expandIdList(setDependsOn);
  const expandedAddDependsOn = expandIdList(addDependsOn) ?? [];
  const expandedRemoveDependsOn = expandIdList(removeDependsOn) ?? [];

  for (const dep of [...(expandedSetDependsOn ?? []), ...expandedAddDependsOn, ...expandedRemoveDependsOn]) {
    if (!(/^[0-9a-fA-F]{4}$/).test(dep)) {
      return { success: false, message: `Invalid depends-on id: ${dep}` };
    }
  }

  const tasks = readTasks(project);
  if (tasks.length === 0) {
    const tasksPath = getTasksPath(project);
    if (!fs.existsSync(tasksPath)) return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;
  const updatedFields: string[] = [];

  if (text != null) { task.text = text; updatedFields.push('text'); }
  if (why != null) { task.why = why; updatedFields.push('why'); }
  if (doneWhen != null) { task.done_when = doneWhen; updatedFields.push('done-when'); }
  if (plan != null) { task.plan = plan.trim(); updatedFields.push('plan'); }
  if (priority != null) { task.priority = priority; updatedFields.push('priority'); }

  if (clearDependsOn || expandedSetDependsOn != null) {
    task.depends_on = expandedSetDependsOn ?? [];
    updatedFields.push('depends-on');
  } else if (expandedAddDependsOn.length > 0 || expandedRemoveDependsOn.length > 0) {
    task.depends_on = task.depends_on.filter((id) => !expandedRemoveDependsOn.includes(id));
    for (const id of expandedAddDependsOn) {
      if (!task.depends_on.includes(id)) task.depends_on.push(id);
    }
    updatedFields.push('depends-on');
  }

  writeTasks(project, tasks);
  return { success: true, message: 'Task updated', task_id: taskId, updated_fields: updatedFields };
}

// Base of the TASKS.yaml write path: this module owns the file I/O and the line-level primitives;
// task-state / task-completion / task-mutations / task-process build on top of it. There is no
// barrel for this folder on purpose — task-store.ts and the CLI import each sub-module directly.
export {
  VALID_PRIORITIES,
  _resetTemplateNameCacheForTests,
  clearDependsOnAll,
  editTask,
  findTask,
  findTaskById,
  getTasksPath,
  readTasks,
  sweepTaskOrphans,
  validateTemplateName,
  writeTasks,
};
export type { TaskLineTransformResult };
