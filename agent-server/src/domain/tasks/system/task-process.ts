// input:  pending dispatch metadata, process signals, generation-fenced task state
// output: stopped dispatch process and ownership-safe task unclaim
// pos:    Cancels tracked task executions without unclaiming newer incarnations
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from '@core/utils.js';
import { unclaimTask } from './task-state.js';

function stopTask(taskId: string) {
  const pendingTasksFile = path.join(STORE_DIR, 'pending-tasks.json');
  let pendingTasks: Record<string, any> = {};
  try { pendingTasks = JSON.parse(fs.readFileSync(pendingTasksFile, 'utf8')); } catch {}

  let dispatchId: string | null = null;
  let taskInfo: any = null;

  if (pendingTasks[taskId]) {
    dispatchId = taskId;
    taskInfo = pendingTasks[taskId];
  } else {
    for (const [id, info] of Object.entries(pendingTasks)) {
      if ((info as any).taskHash === taskId) {
        dispatchId = id;
        taskInfo = info;
        break;
      }
    }
  }

  if (!taskInfo) {
    return { success: false, message: `No running dispatched task found for '${taskId}'. Use dispatch task ID or TASKS.yaml hash.` };
  }

  const machine = taskInfo.machine;
  const tmuxName = taskInfo.tmuxName;
  const steps: string[] = [];

  if (taskInfo.pid) {
    try {
      process.kill(taskInfo.pid, 'SIGTERM');
      steps.push(`Sent SIGTERM to PID ${taskInfo.pid} on ${machine}`);
    } catch (err: any) {
      steps.push(`Process kill warning: ${err.message}`);
    }
  } else if (tmuxName) {
    steps.push(`No PID tracked for ${tmuxName} — process may still be running`);
  }

  const tasksmdHash = taskInfo.taskHash;
  const project = taskInfo.project;
  if (project && tasksmdHash) {
    const unclaimed = unclaimTask(null, project, tasksmdHash, {
      generation: taskInfo.dispatchGeneration ?? null,
    });
    if (unclaimed.success) {
      steps.push(`Unclaimed task [${tasksmdHash}] in ${project}/TASKS.yaml`);
    } else {
      steps.push(`Unclaim skipped: ${unclaimed.message}`);
    }
  }

  delete pendingTasks[dispatchId!];
  fs.writeFileSync(pendingTasksFile, JSON.stringify(pendingTasks, null, 2));
  steps.push('Removed from pending-tasks.json');

  const executionsFile = process.env.CORTEX_EXECUTIONS_FILE || path.join(STORE_DIR, 'executions.json');
  try {
    const executions = JSON.parse(fs.readFileSync(executionsFile, 'utf8'));
    const timestamp = new Date().toISOString();
    for (const record of Object.values(executions) as any[]) {
      if (record.dispatch?.taskId === dispatchId && record.status === 'running') {
        record.status = 'cancelled';
        record.runtime.updatedAt = timestamp;
        record.runtime.endedAt = timestamp;
      }
    }
    fs.writeFileSync(executionsFile, JSON.stringify(executions, null, 2));
    steps.push('Marked cancelled in executions.json');
  } catch {}

  return { success: true, message: `Task [${dispatchId}] stopped on ${machine}`, dispatch_id: dispatchId, machine, task_hash: tasksmdHash || null, project: project || null, steps };
}

function stopTaskDryRun(taskId: string) {
  const pendingTasksFile = path.join(STORE_DIR, 'pending-tasks.json');
  let pendingTasks: Record<string, any> = {};
  try { pendingTasks = JSON.parse(fs.readFileSync(pendingTasksFile, 'utf8')); } catch {}

  let dispatchId: string | null = null;
  let taskInfo: any = null;

  if (pendingTasks[taskId]) {
    dispatchId = taskId;
    taskInfo = pendingTasks[taskId];
  } else {
    for (const [id, info] of Object.entries(pendingTasks)) {
      if ((info as any).taskHash === taskId) {
        dispatchId = id;
        taskInfo = info;
        break;
      }
    }
  }

  if (!taskInfo) {
    return { success: false, message: `No running dispatched task found for '${taskId}'.` };
  }

  const actions: string[] = [];
  if (taskInfo.tmuxName) actions.push(`Kill tmux session '${taskInfo.tmuxName}' on ${taskInfo.machine}`);
  if (taskInfo.project && taskInfo.taskHash) actions.push(`Unclaim task [${taskInfo.taskHash}] in ${taskInfo.project}/TASKS.yaml`);
  actions.push('Remove from pending-tasks.json');
  actions.push('Mark cancelled in executions.json');

  return {
    success: true, dry_run: true,
    message: `Would stop task [${dispatchId}] on ${taskInfo.machine}`,
    dispatch_id: dispatchId, machine: taskInfo.machine,
    task_hash: taskInfo.taskHash || null, project: taskInfo.project || null, actions,
  };
}

export { stopTask, stopTaskDryRun };
