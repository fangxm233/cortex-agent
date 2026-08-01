// input:  task schema, lifecycle storage/locks, ids, template validation
// output: atomically locked add, edit, decompose, and bulk task mutations
// pos:    Constructs new task records and decomposition trees without lost updates
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as fs from 'node:fs';
import { type Task } from '@core/task-parser.js';
import { collectAllExistingHashes, generateHash } from './task-id-utils.js';
import {
  editTask, findTask, getTasksPath, readTasks, VALID_PRIORITIES, validateTemplateName,
  withTaskFileMutationLock, writeTasks,
} from './task-lifecycle-edit.js';

// ── Provenance for session→task wake (Problem 1) ──
// Captured from CORTEX_* / channel env at task-creation time so task.completed can wake the
// originating session. Only top-level `add` populates this; children created via decompose/spawn
// are owned by the thread-wait (thread_wait) resume path, not the session-wake path.
export interface TaskOrigin {
  sessionId?: string | null;
  channel?: string | null;
  threadId?: string | null;
}

// ── Bulk task input type ──

interface BulkTaskInput {
  key: string;
  text: string;
  why?: string;
  'done-when'?: string;
  priority?: string;
  template?: string;
  plan?: string;
  'depends-on'?: string[];
  gpu?: string;
  'gpu-count'?: number;
}

function addTaskUnlocked(
  project: string,
  text: string | null,
  why: string | null,
  doneWhen: string | null,
  priority: string = 'medium',
  template: string | null = null,
  dependsOn: string[] | null = null,
  plan: string | null = null,
  origin: TaskOrigin | null = null,
) {
  if (!text || text === 'null') {
    return { success: false, message: '--text is required and must not be empty' };
  }
  if (!template) {
    return { success: false, message: '--template is required (use --help to list available templates)' };
  }

  const templateError = validateTemplateName(template);
  if (templateError) return { success: false, message: templateError };

  const tasksPath = getTasksPath(project);
  if (!fs.existsSync(tasksPath)) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }

  const tasks = readTasks(project);
  const existingHashes = collectAllExistingHashes();
  const taskHash = generateHash(existingHashes);

  const dependsOnList = dependsOn
    ? dependsOn.flatMap((d) => d.includes(',') ? d.split(',').map((s) => s.trim()).filter(Boolean) : [d])
    : [];

  const newTask: Task = {
    id: taskHash,
    text,
    why: why || '',
    done_when: doneWhen || '',
    priority: (['high', 'medium', 'low'].includes(priority) ? priority : 'medium') as Task['priority'],
    status: 'open',
    template,
    plan: plan?.trim() || '',
    project,
    parent: null,
    depends_on: dependsOnList,
    gpu: null,
    gpu_count: 1,
    blocked_by: null,
    claimed_by: null,
    claimed_at: null,
    dispatch_generation: null,
    paused: false,
    approval_needed: false,
    approved_at: null,
    not_before: null,
    completed_at: null,
    completed_note: null,
    pending_at: null,
    origin_session_id: origin?.sessionId ?? null,
    origin_channel: origin?.channel ?? null,
    origin_thread_id: origin?.threadId ?? null,
  };

  tasks.push(newTask);
  writeTasks(project, tasks);
  return { success: true, message: `Task added to ${project}`, task_id: taskHash };
}

function batchEdit(project: string, taskIds: string[], options: any = {}) {
  const results: { taskId: string; success: boolean; message: string }[] = [];
  for (const id of taskIds) {
    const result = editTask(project, { ...options, taskId: id });
    results.push({ taskId: id, success: result.success, message: result.message || '' });
  }
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success);
  let message = `Batch edit: ${succeeded}/${taskIds.length} tasks updated`;
  if (failed.length > 0) {
    message += `\nFailed:\n${failed.map((r) => `  [${r.taskId}] ${r.message}`).join('\n')}`;
  }
  return { success: failed.length === 0, message, results };
}

/** Subtask input for decomposeTask. Accepts both kebab and snake key styles
 *  ([SPLIT] proposals are agent-written JSON; be liberal in what we accept). */
interface DecomposeSubtaskInput {
  key?: string;                      // local key for sibling depends-on references
  text: string;
  template?: string;
  why?: string;
  done_when?: string;
  'done-when'?: string;
  priority?: string;
  plan?: string;
  depends_on?: string[];
  'depends-on'?: string[];
}

const HEX_ID_RE = /^[0-9a-fA-F]{4}$/;

function decomposeTaskUnlocked(
  project: string,
  originalText: string | null,
  subtasks: DecomposeSubtaskInput[],
  taskId: string | null = null,
  options: { keepParent?: boolean } = {},
) {
  const keepParent = !!options.keepParent;
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }

  const found = findTask(tasks, originalText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const parentIndex = found.index;
  const parentTask = found.task;

  // First pass: ids for every subtask, keyed for sibling dependency resolution.
  const existingHashes = collectAllExistingHashes();
  const keyToId = new Map<string, string>();
  const ids: string[] = [];
  for (const sub of subtasks) {
    const hash = generateHash(existingHashes);
    existingHashes.add(hash);
    ids.push(hash);
    if (sub.key) keyToId.set(sub.key.trim(), hash);
  }

  // Second pass: build tasks, resolving depends-on entries (sibling key | existing hex id).
  const newTasks: Task[] = [];
  for (let i = 0; i < subtasks.length; i++) {
    const sub = subtasks[i];
    const rawDeps = sub.depends_on ?? sub['depends-on'] ?? [];
    const resolvedDeps: string[] = [];
    for (const rawDep of rawDeps) {
      const dep = String(rawDep).trim();
      if (keyToId.has(dep)) resolvedDeps.push(keyToId.get(dep)!);
      else if (HEX_ID_RE.test(dep)) resolvedDeps.push(dep);
      else return { success: false, message: `subtask[${i}]: unknown dependency "${dep}" — not a sibling key and not a 4-char hex id` };
    }
    newTasks.push({
      id: ids[i],
      text: sub.text,
      why: sub.why || '',
      done_when: sub.done_when ?? sub['done-when'] ?? '',
      priority: (sub.priority || 'medium') as Task['priority'],
      status: 'open',
      template: sub.template || parentTask.template,
      plan: (sub.plan?.trim()) || parentTask.plan,
      project,
      // keepParent: children hang under the retained parent. Replace mode: children
      // inherit the grandparent so the tree stays connected (DR-0014).
      parent: keepParent ? parentTask.id : (parentTask.parent ?? null),
      depends_on: resolvedDeps,
      gpu: null,
      gpu_count: 1,
      blocked_by: null,
      claimed_by: null,
      claimed_at: null,
      dispatch_generation: null,
      paused: false,
      approval_needed: false,
      approved_at: null,
      not_before: null,
      completed_at: null,
      completed_note: null,
      pending_at: null,
      origin_session_id: null,
      origin_channel: null,
      origin_thread_id: null,
    });
  }

  if (keepParent) {
    // Parent becomes the join/acceptance node: it stays in place and depends on all
    // children — getActionable keeps it dormant until every child is done, and
    // clearDependsOnAll unlocks it child by child. Zero new dispatch machinery.
    tasks.splice(parentIndex + 1, 0, ...newTasks);
    parentTask.depends_on = [...new Set([...parentTask.depends_on, ...ids])];
    writeTasks(project, tasks);
    return { success: true, message: `Task decomposed into ${subtasks.length} subtasks (parent ${parentTask.id} kept as join node)`, child_ids: ids };
  }

  tasks.splice(parentIndex, 1, ...newTasks);
  writeTasks(project, tasks);
  return { success: true, message: `Task decomposed into ${subtasks.length} subtasks`, child_ids: ids };
}

function bulkAddTasksUnlocked(project: string, inputs: BulkTaskInput[]) {
  // 1. Validate inputs array
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { success: false, message: 'Input must be a non-empty JSON array of tasks' };
  }

  const tasksPath = getTasksPath(project);
  if (!fs.existsSync(tasksPath)) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }

  // 2. Validate each input
  const seenKeys = new Set<string>();
  const VALID_PRIORITY_VALUES = VALID_PRIORITIES; // Set from task-lifecycle-edit

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    const idx = `[${i}]`;

    if (!inp.key || typeof inp.key !== 'string' || inp.key.trim() === '') {
      return { success: false, message: `${idx}: "key" is required and must be a non-empty string` };
    }
    const key = inp.key.trim();
    if (seenKeys.has(key)) {
      return { success: false, message: `${idx}: duplicate key "${key}" — keys must be unique within the batch` };
    }
    seenKeys.add(key);

    if (!inp.text || typeof inp.text !== 'string' || inp.text.trim() === '') {
      return { success: false, message: `${idx} (${key}): "text" is required and must be non-empty` };
    }

    if (!inp.template) {
      return { success: false, message: `${idx} (${key}): "template" is required` };
    }
    const templateError = validateTemplateName(inp.template);
    if (templateError) {
      return { success: false, message: `${idx} (${key}): ${templateError}` };
    }

    if (inp.priority && !VALID_PRIORITY_VALUES.has(inp.priority)) {
      return { success: false, message: `${idx} (${key}): invalid priority "${inp.priority}". Valid: ${[...VALID_PRIORITY_VALUES].join(', ')}` };
    }

    // Check self-references
    const deps = inp['depends-on'] || [];
    if (deps.includes(key)) {
      return { success: false, message: `${idx} (${key}): self-referencing depends-on is not allowed` };
    }
  }

  // 3. Collect existing hashes and generate IDs for all tasks
  const existingHashes = collectAllExistingHashes();
  const keyToId = new Map<string, string>();

  for (const inp of inputs) {
    const hash = generateHash(existingHashes);
    existingHashes.add(hash);
    keyToId.set(inp.key.trim(), hash);
  }

  // 4. Resolve depends-on
  const HEX_ID_RE = /^[0-9a-fA-F]{4}$/;
  const resolvedDeps = new Map<string, string[]>();

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    const deps = inp['depends-on'] || [];
    const resolved: string[] = [];

    for (const rawDep of deps) {
      if (rawDep == null || typeof rawDep !== 'string') {
        return {
          success: false,
          message: `[${i}] (${inp.key.trim()}): invalid depends-on entry (expected string, got ${typeof rawDep})`,
        };
      }
      const dep = rawDep.trim();
      // Check if it's a batch key
      if (keyToId.has(dep)) {
        resolved.push(keyToId.get(dep)!);
      } else if (HEX_ID_RE.test(dep)) {
        // Existing hex ID — pass through
        resolved.push(dep);
      } else {
        return {
          success: false,
          message: `[${i}] (${inp.key.trim()}): unknown dependency "${dep}" — not a batch key and not a valid 4-char hex ID`,
        };
      }
    }

    resolvedDeps.set(inp.key.trim(), resolved);
  }

  // 5. Build Task objects and append
  const tasks = readTasks(project);
  const created: { key: string; id: string; text: string }[] = [];

  for (const inp of inputs) {
    const taskId = keyToId.get(inp.key.trim())!;
    const newTask: Task = {
      id: taskId,
      text: inp.text,
      why: inp.why || '',
      done_when: inp['done-when'] || '',
      priority: (VALID_PRIORITY_VALUES.has(inp.priority || '') ? inp.priority! : 'medium') as Task['priority'],
      status: 'open',
      template: inp.template!,
      plan: (inp.plan || '').trim(),
      project,
      parent: null,
      depends_on: resolvedDeps.get(inp.key.trim()) || [],
      gpu: inp.gpu || null,
      gpu_count: typeof inp['gpu-count'] === 'number' ? inp['gpu-count'] : 1,
      blocked_by: null,
      claimed_by: null,
      claimed_at: null,
      dispatch_generation: null,
      paused: false,
      approval_needed: false,
      approved_at: null,
      not_before: null,
      completed_at: null,
      completed_note: null,
      pending_at: null,
      origin_session_id: null,
      origin_channel: null,
      origin_thread_id: null,
    };
    tasks.push(newTask);
    created.push({ key: inp.key.trim(), id: taskId, text: inp.text });
  }

  writeTasks(project, tasks);
  return {
    success: true,
    message: `Bulk-added ${inputs.length} task(s) to ${project}`,
    created,
  };
}

function lockProjectMutation<T extends (project: string, ...args: any[]) => any>(mutation: T): T {
  return ((project: string, ...args: any[]) => withTaskFileMutationLock(
    project, () => mutation(project, ...args),
  )) as T;
}

const addTask = lockProjectMutation(addTaskUnlocked);
const bulkAddTasks = lockProjectMutation(bulkAddTasksUnlocked);
const decomposeTask = lockProjectMutation(decomposeTaskUnlocked);

export { addTask, batchEdit, bulkAddTasks, decomposeTask };
