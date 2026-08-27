// input:  ThreadDetail DTO and wall-clock milliseconds
// output: locale- and CSS-free lifecycle, timing, dispatch, agent, and depth facts
// pos:    Canonical desktop/mobile thread detail semantics
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type {
  ThreadDetail,
  ThreadDispatchInfo,
  ThreadInfo,
  ThreadStepDetail,
} from '@cortex-agent/ui-contract';
import { dispatchesForStep } from './thread-steps';
import { MAX_LEVEL, treeMaxLevel } from './nested-threads';

export type ThreadStepKind = 'done' | 'running' | 'pending';

export interface ThreadDetailStepFacts {
  step: ThreadStepDetail;
  kind: ThreadStepKind;
  elapsedSeconds: number | null;
  durationSeconds: number | null;
  dispatch: ThreadDispatchInfo | null;
  machine: string | null;
}

export interface ThreadDetailFacts {
  live: boolean;
  elapsedSeconds: number;
  activeProfile: string | null;
  activeOutput: string | null;
  machine: string | null;
  depth: { level: number; limit: number };
  steps: ThreadDetailStepFacts[];
}

export function threadIsLive(status: ThreadInfo['status']): boolean {
  return status === 'running' || status === 'waiting';
}

export function threadStepKind(step: ThreadStepDetail): ThreadStepKind {
  if (step.status === 'completed') return 'done';
  if (step.status === 'running') return 'running';
  return 'pending';
}

export function elapsedSeconds(startedAt: string, endedAt: string | null, now: number): number {
  const end = endedAt ? Date.parse(endedAt) : now;
  return Math.max(0, Math.floor((end - Date.parse(startedAt)) / 1000));
}

function stepDispatches(detail: ThreadDetail, step: ThreadStepDetail): ThreadDispatchInfo[] {
  return dispatchesForStep(detail, step);
}

function stepFacts(detail: ThreadDetail, step: ThreadStepDetail, now: number): ThreadDetailStepFacts {
  const dispatches = stepDispatches(detail, step);
  return {
    step,
    kind: threadStepKind(step),
    elapsedSeconds: step.startedAt ? elapsedSeconds(step.startedAt, step.endedAt, now) : null,
    durationSeconds: step.durationS,
    dispatch: dispatches[0] ?? null,
    machine: dispatches.find((item) => item.machine)?.machine ?? null,
  };
}

function activeStep(facts: ThreadDetailStepFacts[]): ThreadDetailStepFacts | undefined {
  return facts.find((item) => item.kind === 'running');
}

function threadMachine(detail: ThreadDetail, active: ThreadDetailStepFacts | undefined): string | null {
  return active?.machine ?? detail.dispatches.find((item) => item.machine)?.machine ?? null;
}

export function buildThreadDetailFacts(detail: ThreadDetail, now: number): ThreadDetailFacts {
  const steps = detail.steps.map((step) => stepFacts(detail, step, now));
  const active = activeStep(steps);
  return {
    live: threadIsLive(detail.status),
    elapsedSeconds: elapsedSeconds(detail.createdAt, detail.endedAt, now),
    activeProfile: detail.agentFlow?.profile ?? detail.activeAgent ?? active?.step.agentSlotId ?? null,
    activeOutput: detail.agentFlow?.lastOutput ?? active?.step.outputSummary ?? null,
    machine: threadMachine(detail, active),
    depth: { level: treeMaxLevel(detail.children), limit: MAX_LEVEL },
    steps,
  };
}
