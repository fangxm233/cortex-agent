import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { STORE_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';

const log = createLogger('pending-task-tracker');

interface PendingTaskEntry {
  channel: string;
  machine: string;
  launchedAt: number;
  scheduleTaskId: string | null;
  taskText: string | null;
  taskHash: string | null;
  project: string | null;
  trackingTs: string | null;
  sessionName: string | null;
  tmuxName: string | null;
  pid: string | null;
  dispatchGeneration: string | null;
}

const PENDING_TASKS_FILE = path.join(STORE_DIR, 'pending-tasks.json');
const TASK_STALE_MS = 4 * 60 * 60 * 1000;

// --- Persistence ---

function loadPendingTasks(): Map<string, PendingTaskEntry> {
  try {
    const data = JSON.parse(readFileSync(PENDING_TASKS_FILE, 'utf8'));
    return new Map(Object.entries(data)) as Map<string, PendingTaskEntry>;
  } catch { return new Map(); }
}

function savePendingTasks(): void {
  const obj = Object.fromEntries(pendingTasks);
  writeFileSync(PENDING_TASKS_FILE, JSON.stringify(obj, null, 2));
}

const pendingTasks: Map<string, PendingTaskEntry> = loadPendingTasks();
if (pendingTasks.size > 0) {
  log.info(`Restored ${pendingTasks.size} pending task(s) from disk`);
}

// --- Public API ---

function clearTask(taskId: string): void {
  if (pendingTasks.has(taskId)) {
    const t = pendingTasks.get(taskId);
    pendingTasks.delete(taskId);
    savePendingTasks();
    log.info(`Task cleared: ${taskId} on ${t.machine} (pending: ${pendingTasks.size})`);
  }
}

function getPendingTasksForSchedule(scheduleTaskId: string): Array<PendingTaskEntry & { taskId: string }> {
  const now = Date.now();
  let changed = false;
  for (const [tid, t] of pendingTasks) {
    if (now - t.launchedAt > TASK_STALE_MS) {
      log.info(`Clearing stale task ${tid} on ${t.machine} (${((now - t.launchedAt) / 60000).toFixed(0)}m old)`);
      pendingTasks.delete(tid);
      changed = true;
    }
  }
  if (changed) savePendingTasks();
  return [...pendingTasks.entries()]
    .filter(([, t]) => t.scheduleTaskId === scheduleTaskId)
    .map(([tid, t]) => ({ taskId: tid, ...t }));
}

function getTask(taskId: string): PendingTaskEntry | null {
  return pendingTasks.get(taskId) || null;
}

function isTaskTracked(taskHash: string, project: string, generation: string | null): boolean {
  return [...pendingTasks.entries()].some(([taskId, task]) =>
    (task.taskHash === taskHash || taskId === taskHash)
      && task.project === project
      && (task.dispatchGeneration ?? null) === generation);
}

export {
  clearTask,
  getPendingTasksForSchedule,
  getTask,
  isTaskTracked,
};
