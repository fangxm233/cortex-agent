// input:  thread details, transcript timestamps, and tool calls
// output: mobile stepper, divider, and tool-chip models
// pos:    Active pure helpers retained from the legacy mobile session screen
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ThreadDetail } from '@cortex-agent/ui-contract';

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * ZH day-divider label for the mobile chat stream (scheme L2946 "今天 07:42"). 今天 / 昨天 for the
 * current & previous calendar day, else `${M}月${D}日`, all suffixed with the local HH:MM.
 */
export function zhDivider(ts: string, now: Date): string {
  const d = new Date(ts);
  const startOf = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDelta = Math.round((startOf(now) - startOf(d)) / 86400000);
  const time = hhmm(d);
  if (dayDelta <= 0) return `今天 ${time}`;
  if (dayDelta === 1) return `昨天 ${time}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

export type StepperState = 'done' | 'running' | 'pending';

export interface StepperNode {
  label: string;
  state: StepperState;
  /** the connecting line drawn BEFORE this node is "done" only when the previous node completed. */
  lineDone: boolean;
}

export interface MobileStepperFooter {
  elapsed: string;
  cost: string;
  subCount: number;
}

export interface MobileStepper {
  name: string;
  pillText: string;
  nodes: StepperNode[];
  footer: MobileStepperFooter;
}

function stepState(status: ThreadDetail['steps'][number]['status']): StepperState {
  return status === 'completed' ? 'done' : status === 'running' ? 'running' : 'pending';
}

function formatElapsed(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Build the horizontal stepper card model from a live ThreadDetail (scheme L2954-2973). Nodes come
 * from the real `steps` (data-driven — not the scheme's fixed 计划/执行/评审/提交); elapsed derives
 * from createdAt→updatedAt, cost from totalCostUsd, sub-thread count from children.length.
 */
export function buildMobileStepper(detail: ThreadDetail): MobileStepper {
  const nodes: StepperNode[] = detail.steps.map((s, i) => ({
    label: s.stage ?? `Step ${s.stepIndex + 1}`,
    state: stepState(s.status),
    lineDone: i > 0 && detail.steps[i - 1].status === 'completed',
  }));

  const pillText =
    detail.status === 'running' && detail.currentStep
      ? `${detail.currentStep.name} ${detail.currentStep.index + 1}/${detail.totalSteps}`
      : detail.status;

  const elapsedMs = new Date(detail.updatedAt).getTime() - new Date(detail.createdAt).getTime();

  return {
    name: detail.templateName,
    pillText,
    nodes,
    footer: {
      elapsed: formatElapsed(elapsedMs),
      cost: `$${detail.totalCostUsd.toFixed(2)}`,
      subCount: detail.children.length,
    },
  };
}

export interface ToolChips {
  names: string[];
  overflow: number;
}

/** First two tool names + overflow count for the collapsed tool-calls row (scheme L2950). */
export function toolChips(calls: { kind: string; input: string }[]): ToolChips {
  return { names: calls.slice(0, 2).map((c) => c.kind), overflow: Math.max(0, calls.length - 2) };
}
