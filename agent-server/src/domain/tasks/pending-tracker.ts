// input:  pending-tasks.json + channel/execution registries + dispatch generation
// output: generation-aware launch/progress tracking and status messages
// pos:    Durable dispatch tracking used by stop and orphan-claim recovery
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import type { PlatformAdapter, MessageRef } from '@platform/index.js';
import { STORE_DIR, formatDurationCompact } from '@core/utils.js';
import { Icons } from '../../core/icons.js';
import { createLogger } from '@core/log.js';
import * as executionRegistry from '../executions/registry.js';

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

let _adapter: PlatformAdapter | null = null;

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

// --- Message builders ---

function buildTrackingMetaParts({ startedAtMs, elapsed_s }: { startedAtMs?: number; elapsed_s?: number }): string {
  const elapsed = elapsed_s ?? ((Date.now() - startedAtMs) / 1000);
  return `${Icons.stopwatch} ${formatDurationCompact(elapsed || 0)}`;
}

function buildTrackingMessage({ taskId, machine, taskText, startedAtMs, elapsed_s, turn_count, status, cost_usd, duration_s, num_turns, finalOutput }: {
  taskId: string; machine?: string; taskText?: string | null; startedAtMs?: number;
  elapsed_s?: number; turn_count?: number; status: string;
  cost_usd?: number | null; duration_s?: number | null; num_turns?: number | null;
  finalOutput?: string | null;
}): string {
  const label = taskText ? `${taskText}` : `Task ${taskId}`;
  if (status === 'completed') {
    const dur = formatDurationCompact(duration_s || elapsed_s || 0);
    const costStr = cost_usd != null ? ` | $${cost_usd.toFixed(4)}` : '';
    const outputStr = finalOutput ? `\n\n${finalOutput}` : '';
    return `${Icons.ok} *[${taskId}]* ${label}\nCompleted on ${machine} | ${Icons.stopwatch} ${dur} | ${num_turns || turn_count || '?'} turns${costStr}${outputStr}`;
  }
  if (status === 'failed') {
    const dur = formatDurationCompact(duration_s || elapsed_s || 0);
    const costStr = cost_usd != null ? ` | $${cost_usd.toFixed(4)}` : '';
    const outputStr = finalOutput ? `\n\n${finalOutput}` : '';
    return `${Icons.error} *[${taskId}]* ${label}\nFailed on ${machine} | ${Icons.stopwatch} ${dur} | ${num_turns || turn_count || '?'} turns${costStr}${outputStr}`;
  }
  return `${Icons.satellite} *[${taskId}]* ${label}\nRunning on ${machine} | ${buildTrackingMetaParts({ startedAtMs, elapsed_s })}`;
}

// --- Public API ---

function init(adapter: PlatformAdapter): void {
  _adapter = adapter;
}

async function onTaskLaunched({ taskId, machine, channel, scheduleTaskId, taskText, taskHash, project, sessionName, tmuxName, pid, dispatchGeneration }: {
  taskId: string; machine: string; channel: string; scheduleTaskId?: string | null;
  taskText?: string | null; taskHash?: string | null; project?: string | null;
  sessionName?: string | null; tmuxName?: string | null; pid?: string | null;
  dispatchGeneration?: string | null;
}): Promise<void> {
  executionRegistry.registerDispatchExecution({
    taskId,
    machine,
    channel,
    project,
    scheduleTaskId,
    taskText,
    taskHash,
    sessionName,
    tmuxName,
    pid,
  });

  pendingTasks.set(taskId, {
    channel: channel, machine, launchedAt: Date.now(),
    scheduleTaskId: scheduleTaskId || null, taskText: taskText || null, taskHash: taskHash || null,
    project: project || null, trackingTs: null,
    sessionName: sessionName || null, tmuxName: tmuxName || null, pid: pid || null,
    dispatchGeneration: dispatchGeneration ?? null,
  });
  savePendingTasks();
  log.info(`Task registered: ${taskId} on ${machine} (channel: ${channel}, project: ${project || 'none'}, schedule: ${scheduleTaskId || 'none'}, pending: ${pendingTasks.size})`);

  const trackingText = buildTrackingMessage({ taskId, machine, taskText, startedAtMs: Date.now(), elapsed_s: 0, turn_count: 0, status: 'running' });
  if (channel && _adapter) {
    (async () => {
      try {
        const trackingDest = { type: 'project-report' as const, projectId: project || 'general', trigger: 'dispatch', sessionId: '' };
        const ref = await _adapter!.postMessage(trackingDest, { text: trackingText });
        const t = pendingTasks.get(taskId);
        if (t) {
          t.trackingTs = ref.messageId;
          savePendingTasks();
        }
      } catch (e) {
        log.error(`Failed to send tracking message for ${taskId}:`, (e as Error).message);
      }
    })();
  }
}

function handleTaskProgress({ task_id, machine, cost_usd, turn_count, elapsed_s }: {
  task_id?: string; machine?: string; cost_usd?: number | null; turn_count?: number; elapsed_s?: number;
}): void {
  if (!task_id) return;
  const t = pendingTasks.get(task_id);
  const execution = executionRegistry.getExecutionByTaskId(task_id);
  if (execution) {
    executionRegistry.touchExecution(execution.id, {
      metrics: {
        costUsd: cost_usd ?? execution.metrics.costUsd,
        numTurns: turn_count ?? execution.metrics.numTurns,
      },
    });
  }
  if (!t || !t.trackingTs || !_adapter) return;

  const channel = t.channel;
  const text = buildTrackingMessage({ taskId: task_id, machine: machine || t.machine, taskText: t.taskText, startedAtMs: t.launchedAt, elapsed_s, turn_count, cost_usd, status: 'running' });
  (async () => {
    try {
      await _adapter!.updateMessage({ conduit: channel, messageId: t.trackingTs! }, { text });
    } catch (e) {
      log.error(`Failed to update tracking for ${task_id}:`, (e as Error).message);
    }
  })();
}

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

function findPendingTaskMatch({ scheduleTaskId, taskHash, project, taskText }: {
  scheduleTaskId: string; taskHash?: string | null; project?: string; taskText?: string;
}): (PendingTaskEntry & { taskId: string }) | null {
  return getPendingTasksForSchedule(scheduleTaskId).find((task) => {
    if (taskHash && task.taskHash) return task.taskHash === taskHash;
    return task.project === project && task.taskText === taskText;
  }) || null;
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

function hasPendingTasks(): boolean {
  return pendingTasks.size > 0;
}

function pendingTaskCount(): number {
  return pendingTasks.size;
}

export {
  init,
  onTaskLaunched,
  handleTaskProgress,
  clearTask,
  getPendingTasksForSchedule,
  findPendingTaskMatch,
  getTask,
  isTaskTracked,
  hasPendingTasks,
  pendingTaskCount,
  buildTrackingMessage,
  buildTrackingMetaParts,
};
