// input:  UiServiceDeps + ExecutionsListParams / ExecutionsGetParams
// output: handleExecutionsList → ExecutionInfo[]; handleExecutionsGet → ExecutionDetailInfo
// pos:    query handlers for 'executions.list' and 'executions.get'

import type {
  UiServiceDeps,
  ExecutionInfo,
  ExecutionsListParams,
  ExecutionDetailInfo,
  ExecutionsGetParams,
} from '../types.js';

export async function handleExecutionsList(
  deps: UiServiceDeps,
  params: ExecutionsListParams,
): Promise<ExecutionInfo[]> {
  const { status, limit } = params;

  let executions = deps.executionRegistry.getAll();

  if (status && status.length > 0) {
    const statusSet = new Set(status);
    executions = executions.filter((e: any) => statusSet.has(e.status));
  }

  // Sort by startedAt descending
  executions.sort((a: any, b: any) =>
    (b.runtime?.startedAt || '').localeCompare(a.runtime?.startedAt || ''),
  );

  if (limit && limit > 0) {
    executions = executions.slice(0, limit);
  }

  return executions.map((e: any): ExecutionInfo => {
    const startedAt = e.runtime?.startedAt || '';
    const finishedAt = e.runtime?.endedAt || null;
    const startMs = new Date(startedAt).getTime();
    const endMs = finishedAt ? new Date(finishedAt).getTime() : null;

    return {
      id: e.id,
      type: e.kind === 'dispatch' ? 'dispatch' : 'local',
      status: e.status,
      taskId: e.dispatch?.taskId ?? null,
      sessionId: e.session?.sessionId ?? null,
      projectId: e.project ?? null,
      machine: e.dispatch?.machine ?? null,
      startedAt,
      finishedAt,
      durationMs: endMs ? endMs - startMs : null,
      cost: e.metrics?.costUsd ?? null,
    };
  });
}

export async function handleExecutionsGet(
  deps: UiServiceDeps,
  params: ExecutionsGetParams,
): Promise<ExecutionDetailInfo> {
  const e = deps.executionRegistry.getExecution(params.executionId);
  if (!e) {
    throw Object.assign(new Error(`Execution not found: ${params.executionId}`), {
      code: 'not-found',
    });
  }

  return {
    id: e.id,
    type: e.kind === 'dispatch' ? 'dispatch' : 'local',
    kind: e.kind,
    status: e.status,
    projectId: e.project ?? null,
    sessionId: e.session?.sessionId ?? null,
    threadId: e.thread?.threadId ?? null,
    runtime: {
      startedAt: e.runtime?.startedAt ?? '',
      updatedAt: e.runtime?.updatedAt ?? '',
      endedAt: e.runtime?.endedAt ?? null,
    },
    dispatch: e.dispatch
      ? {
          taskId: e.dispatch.taskId ?? null,
          machine: e.dispatch.machine ?? null,
          pid: e.dispatch.pid ?? null,
          tmuxName: e.dispatch.tmuxName ?? null,
          sessionName: e.dispatch.sessionName ?? null,
          scheduleTaskId: e.dispatch.scheduleTaskId ?? null,
        }
      : null,
    metrics: {
      costUsd: e.metrics?.costUsd ?? null,
      numTurns: e.metrics?.numTurns ?? null,
      durationS: e.metrics?.durationS ?? null,
    },
    text: {
      label: e.text?.label ?? null,
      finalOutput: e.text?.finalOutput ?? null,
      error: e.text?.error ?? null,
    },
  };
}
