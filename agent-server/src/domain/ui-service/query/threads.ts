// input:  UiServiceDeps, thread query params, task DTO mapper
// output: task-linked thread detail with optional artifact text
// pos:    Thread list/detail query handlers
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { readFile } from 'node:fs/promises';
import type {
  UiServiceDeps,
  ThreadInfo,
  ThreadsListParams,
  ThreadsGetParams,
  ThreadDetail,
  ThreadStepDetail,
  ThreadAgentFlow,
  ThreadDispatchInfo,
  ThreadChildNode,
  TaskInfo,
} from '../types.js';
import { toTaskInfo } from './tasks.js';

// Detail status vocabulary matches ThreadInfo (6 values). ThreadRecord additionally has
// 'rate_limited', which we collapse to 'waiting' so the frontend keeps one status set
// (DR-0018 §6.3 B1 decision D1).
type DetailStatus = ThreadInfo['status'];
function mapStatus(status: string): DetailStatus {
  return status === 'rate_limited' ? 'waiting' : (status as DetailStatus);
}

const OUTPUT_SUMMARY_MAX = 200;
function summarizeOutput(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.length > OUTPUT_SUMMARY_MAX ? text.slice(0, OUTPUT_SUMMARY_MAX) : text;
}

// Max levels of descendants below the requested thread: depth 0 (direct child) .. depth 4.
const MAX_CHILD_DEPTH = 4;

export async function handleThreadsList(
  deps: UiServiceDeps,
  params: ThreadsListParams,
): Promise<ThreadInfo[]> {
  const { projectId, status, sessionId } = params;

  let threads = deps.threadStore.getAll();

  if (projectId) {
    threads = threads.filter((t: any) => t.projectId === projectId);
  }
  if (status && status.length > 0) {
    const statusSet = new Set(status);
    threads = threads.filter((t: any) => statusSet.has(t.status));
  }
  // Session scoping: a thread spawned from a chat runs on that session's channel, so resolve the
  // session → channel and keep only threads on it. An unknown session (or one with no channel)
  // yields an empty list — the inline card then simply hides rather than showing a stray thread.
  if (sessionId) {
    const session = await deps.sessionStore.getById(sessionId);
    const channel = session?.channel ?? null;
    threads = channel ? threads.filter((t: any) => t.channel === channel) : [];
  }

  return threads.map((t: any): ThreadInfo => ({
    id: t.id,
    templateName: t.templateName || 'unknown',
    currentStep: t.currentStepIndex != null
      ? { index: t.currentStepIndex, name: t.currentStepName || `step-${t.currentStepIndex}` }
      : null,
    status: t.status,
    projectId: t.projectId,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    totalSteps: (t.template?.agents?.length) || t.steps?.length || 0,
    artifactPath: t.artifactPath ?? null,
    taskId: t.metadata?.taskId ?? null,
  }));
}

async function readArtifactContent(path: string | null, include: boolean | undefined): Promise<string | null> {
  if (!include || !path) return null;
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function buildArtifactRefs(t: any, content: string | null): ThreadDetail['artifacts'] {
  return {
    artifactPath: t.artifactPath ?? null,
    workspacePath: t.workspacePath ?? null,
    taskId: t.metadata?.taskId ?? null,
    taskProject: t.metadata?.taskProject ?? null,
    content,
  };
}

export async function handleThreadsGet(
  deps: UiServiceDeps,
  params: ThreadsGetParams,
): Promise<ThreadDetail> {
  const t: any = deps.threadStore.get(params.threadId);
  if (!t) throw new Error(`thread not found: ${params.threadId}`);

  const steps = buildSteps(t);
  const content = await readArtifactContent(t.artifactPath ?? null, params.includeArtifactContent);
  return {
    id: t.id, templateName: t.templateName || 'unknown', projectId: t.projectId,
    currentStep: t.currentStepIndex != null
      ? { index: t.currentStepIndex, name: t.currentStepName || `step-${t.currentStepIndex}` }
      : null,
    status: mapStatus(t.status), createdAt: t.createdAt, updatedAt: t.updatedAt,
    totalSteps: (t.template?.agents?.length) || t.steps?.length || 0,
    artifactPath: t.artifactPath ?? null, endedAt: t.endedAt ?? null,
    error: t.error ?? null, abortReason: t.abortReason ?? null,
    activeAgent: t.activeAgent ?? null, activeStage: t.activeStage ?? null,
    totalCostUsd: t.totalCostUsd ?? 0, steps, agentFlow: buildAgentFlow(t),
    dispatches: buildDispatches(deps, t, steps), subtasks: buildSubtasks(deps, t),
    children: buildChildTree(deps, t.metadata?.childThreadIds ?? [], 0, new Set([t.id])),
    artifacts: buildArtifactRefs(t, content),
  };
}

// Completed steps live in t.steps[] (append-only). When the thread is still live the active
// step (index === steps.length) is not yet an AgentStep row — synthesize it from the active
// AgentSlot so the UI can render the in-flight step.
function buildSteps(t: any): ThreadStepDetail[] {
  const out: ThreadStepDetail[] = (t.steps ?? []).map((s: any): ThreadStepDetail => ({
    stepIndex: s.stepIndex,
    agentSlotId: s.agentSlotId,
    stage: s.stage ?? null,
    status: s.endedAt ? 'completed' : 'running',
    executionId: s.executionId ?? null,
    sessionId: s.sessionId ?? null,
    sessionName: s.sessionName ?? null,
    costUsd: s.costUsd ?? null,
    numTurns: s.numTurns ?? null,
    durationS: s.durationS ?? null,
    startedAt: s.startedAt ?? null,
    endedAt: s.endedAt ?? null,
    outputSummary: summarizeOutput(s.output),
  }));

  const terminal = ['completed', 'failed', 'cancelled', 'aborted'].includes(t.status);
  const stepCount = t.steps?.length ?? 0;
  if (!terminal && t.currentStepIndex === stepCount && t.activeAgent) {
    const slot = t.agents?.[t.activeAgent];
    out.push({
      stepIndex: t.currentStepIndex,
      agentSlotId: t.activeAgent,
      stage: t.activeStage ?? null,
      status: 'running',
      executionId: null,
      sessionId: slot?.sessionId ?? null,
      sessionName: slot?.sessionName ?? null,
      costUsd: null,
      numTurns: null,
      durationS: null,
      startedAt: null,
      endedAt: null,
      outputSummary: summarizeOutput(slot?.lastOutput),
    });
  }
  return out;
}

function buildAgentFlow(t: any): ThreadAgentFlow | null {
  const slot = t.activeAgent ? t.agents?.[t.activeAgent] : null;
  if (!slot) return null;
  return {
    slotId: slot.slotId,
    profile: slot.profile,
    status: slot.status,
    stage: t.activeStage ?? null,
    sessionId: slot.sessionId ?? null,
    sessionName: slot.sessionName ?? null,
    lastOutput: slot.lastOutput ?? null,
  };
}

function findLaunchStep(steps: ThreadStepDetail[], thread: any, startedAt: string) {
  const launchedAt = Date.parse(startedAt);
  if (!Number.isFinite(launchedAt)) return null;

  const completed = steps.find((step) => {
    const start = step.startedAt ? Date.parse(step.startedAt) : NaN;
    const end = step.endedAt ? Date.parse(step.endedAt) : NaN;
    return Number.isFinite(start) && Number.isFinite(end) && launchedAt >= start && launchedAt < end;
  });
  if (completed) return completed;

  const active = steps.find((step) => step.status === 'running');
  if (!active) return null;
  const priorEnd = steps.reduce((latest, step) => {
    const end = step.endedAt ? Date.parse(step.endedAt) : NaN;
    return Number.isFinite(end) ? Math.max(latest, end) : latest;
  }, Date.parse(thread.createdAt));
  return launchedAt >= priorEnd ? active : null;
}

function toThreadDispatch(e: any, step: ThreadStepDetail): ThreadDispatchInfo {
  const startedAt = e.runtime?.startedAt || '';
  const finishedAt = e.runtime?.endedAt || null;
  const endMs = finishedAt ? Date.parse(finishedAt) : null;
  return {
    executionId: e.id,
    status: e.status,
    machine: e.dispatch.machine ?? null,
    type: 'dispatch',
    agentSlotId: step.agentSlotId,
    stepIndex: step.stepIndex,
    taskId: e.dispatch.taskId,
    runName: e.dispatch.runName,
    startedAt,
    finishedAt,
    durationMs: endMs ? endMs - Date.parse(startedAt) : null,
    cost: e.metrics?.costUsd ?? null,
  };
}

// Real cortex-runs have a runName and owning task but no caller-thread field. Launch time is the
// remaining provenance seam: attribute only runs launched inside one of this thread's step windows.
function buildDispatches(
  deps: UiServiceDeps,
  thread: any,
  steps: ThreadStepDetail[],
): ThreadDispatchInfo[] {
  const taskId = thread.metadata?.taskId;
  if (!taskId) return [];
  return deps.executionRegistry.getAll()
    .filter((e: any) => e.dispatch?.taskId === taskId && e.dispatch?.runName)
    .sort((a: any, b: any) => (a.runtime?.startedAt || '').localeCompare(b.runtime?.startedAt || ''))
    .flatMap((e: any): ThreadDispatchInfo[] => {
      const step = findLaunchStep(steps, thread, e.runtime?.startedAt || '');
      return step ? [toThreadDispatch(e, step)] : [];
    });
}

function buildSubtasks(deps: UiServiceDeps, thread: any): TaskInfo[] {
  const taskId = thread.metadata?.taskId;
  if (!taskId) return [];
  deps.taskStore.refresh();
  const project = thread.metadata?.taskProject ?? thread.projectId;
  return deps.taskStore.getAll(project).filter((task: any) => task.parent === taskId).map(toTaskInfo);
}

// Recurse over metadata.childThreadIds, depth-capped at MAX_CHILD_DEPTH (≤5 levels).
// `seen` breaks cycles; a node whose children are cut by the cap is marked truncated.
function buildChildTree(
  deps: UiServiceDeps,
  childIds: string[],
  depth: number,
  seen: Set<string>,
): ThreadChildNode[] {
  const nodes: ThreadChildNode[] = [];
  for (const id of childIds) {
    if (seen.has(id)) continue;
    const c: any = deps.threadStore.get(id);
    if (!c) continue;
    seen.add(id);
    const grandIds: string[] = c.metadata?.childThreadIds ?? [];
    const atCap = depth >= MAX_CHILD_DEPTH;
    const children = atCap ? [] : buildChildTree(deps, grandIds, depth + 1, seen);
    nodes.push({
      id: c.id,
      templateName: c.templateName ?? null,
      status: mapStatus(c.status),
      activeAgent: c.activeAgent ?? null,
      costUsd: c.totalCostUsd ?? 0,
      depth,
      createdAt: c.createdAt,
      taskId: c.metadata?.taskId ?? null,
      children,
      truncated: atCap && grandIds.length > 0,
    });
  }
  return nodes;
}
