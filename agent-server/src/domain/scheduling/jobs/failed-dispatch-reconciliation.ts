// input:  task/thread stores, template graph, adapter
// output: failed-dispatch reconciliation
// pos:    Recovers unresolved reviews after thread failure
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { Icons } from '@core/icons.js';
import type { ThreadRecord, ThreadTemplate } from '@core/types/thread-types.js';
import { getOutboundQueue, durablePost } from '@store/outbound-queue.js';
import { threadStore } from '@store/thread-repo.js';
import { taskMutator } from '../../tasks/mutator.js';
import { taskStore } from '../../tasks/store.js';
import { getTemplate, readArtifact } from '../../threads/index.js';
import { ctx } from '../job-registry.js';

interface DispatchTask {
  id: string;
  project: string;
  template: string;
  plan?: string | null;
}

function regexEndsWith(pattern: string, output: string): boolean {
  try {
    return new RegExp(`(?:${pattern})$`).test(output);
  } catch {
    return false;
  }
}

function endsWithTerminalMarker(artifact: string, template: ThreadTemplate | null): boolean {
  if (!template) return false;
  const output = artifact.trimEnd();
  return template.transitions.some(({ condition }) => {
    if (condition.type === 'convergence') {
      return !!condition.marker && output.endsWith(condition.marker);
    }
    if (condition.type === 'output_not_contains') {
      return !!condition.pattern && regexEndsWith(condition.pattern, output);
    }
    return false;
  });
}

function failedStage(thread: ThreadRecord): string {
  return thread.activeStage
    ? `${thread.activeAgent}:${thread.activeStage}`
    : thread.activeAgent || 'unknown';
}

async function postReconciliationNotice(project: string, text: string): Promise<void> {
  const adapter = ctx.adapter;
  if (!adapter) throw new Error('No platform adapter for failed dispatch reconciliation');
  const destination = { type: 'project-report' as const, projectId: project, trigger: 'task-dispatch', sessionId: '' };
  const queue = getOutboundQueue();
  if (queue) await durablePost(queue, adapter, destination, { text });
  else await adapter.postMessage(destination, { text });
}

async function createFollowup(thread: ThreadRecord, task: DispatchTask): Promise<string> {
  const result = await taskMutator.add(
    task.project,
    `Close unresolved review left by failed thread ${thread.id} on completed task ${task.id}`,
    `Review artifact: ${thread.artifactPath}; failed stage: ${failedStage(thread)}.`,
    'Every open Blocker in the failed thread artifact is fixed or explicitly rebutted, and the full test suite is green.',
    'high',
    task.template,
    [],
    { plan: task.plan || '', system: true },
  );
  if (!result.success || !result.task_id) {
    throw new Error(`Failed to create review followup: ${result.message || 'unknown error'}`);
  }
  return result.task_id;
}

export async function reconcileFailedDispatchThread(threadId: string, selectedTask: Record<string, any>): Promise<void> {
  taskStore.refresh();
  const task = taskStore.getById(selectedTask.id) as DispatchTask & { status?: string } | null;
  if (task?.status !== 'done') return;

  const thread = threadStore.get(threadId);
  if (!thread) throw new Error(`Failed dispatch thread not found: ${threadId}`);
  const artifact = readArtifact(threadId) || '';
  const template = thread.templateName ? getTemplate(thread.templateName) : null;
  if (endsWithTerminalMarker(artifact, template)) {
    await postReconciliationNotice(
      task.project,
      `${Icons.warning} Review reconciliation: failed thread ${threadId} on completed task ${task.id} ended with a terminal marker; no followup task created.`,
    );
    return;
  }

  if (thread.metadata?.reviewLeakFollowupTaskId) return;
  const followupId = await createFollowup(thread, task);
  await threadStore.mutate(threadId, (record) => {
    (record.metadata ??= {}).reviewLeakFollowupTaskId = followupId;
  });
  await postReconciliationNotice(
    task.project,
    `${Icons.warning} Review reconciliation: created followup task ${followupId} for failed thread ${threadId} on completed task ${task.id}.`,
  );
}
