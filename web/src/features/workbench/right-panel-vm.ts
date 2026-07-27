// input:  ui-contract DTOs, nested-thread helpers
// output: right-panel formatting and status view models
// pos:    Pure view-model helpers for the workbench right panel
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type {
  ThreadInfo,
  ThreadStepDetail,
  ThreadDetail,
  ThreadDispatchInfo,
  TaskInfo,
  MachineInfo,
} from '@cortex-agent/ui-contract';
import { treeMaxLevel, MAX_LEVEL } from '@/features/thread/nested-threads';

export interface Pill {
  bg: string;
  fg: string;
  text: string;
}

/**
 * Thread status → status-pill colors + label, VERBATIM from the prototype `pill()` (L1841–1848).
 * Real thread vocabulary: running | waiting | completed | failed | cancelled | aborted.
 * `completed` maps to the prototype's 'done' pill; `cancelled`/`aborted` to the default (Cancelled).
 */
export function threadPill(status: ThreadInfo['status']): Pill {
  switch (status) {
    case 'running':
      return { bg: '#EEF0FA', fg: '#4655D4', text: 'Running' };
    case 'waiting':
      return { bg: '#F7ECCE', fg: '#8A5B06', text: 'Waiting' };
    case 'completed':
      return { bg: '#E9F4EE', fg: '#23854F', text: 'Done' };
    case 'failed':
      return { bg: '#FBEDEB', fg: '#C03D33', text: 'Failed' };
    default:
      return { bg: '#F1F2F5', fg: '#8A93A2', text: 'Cancelled' };
  }
}

export type StepDotKind = 'done' | 'running' | 'pending';

/** ThreadStepDetail.status → the prototype's three step-dot kinds (L1137–1139). */
export function stepDotKind(step: ThreadStepDetail): StepDotKind {
  if (step.status === 'completed') return 'done';
  if (step.status === 'running') return 'running';
  return 'pending';
}

/** 2-decimal dollar amount, e.g. "$2.10" (prototype money()). */
export function formatCost(v: number): string {
  return '$' + v.toFixed(2);
}

/** Compact clock: "45s" / "1m" / "3m 27s" / "39m", rounding fractional seconds. */
export function formatDurationS(s: number): string {
  const total = Math.round(s);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return sec === 0 ? `${m}m` : `${m}m ${sec}s`;
}

/** Collapsed step meta "39m · $2.10" (duration then cost); omits null parts. */
export function stepMeta(step: ThreadStepDetail): string {
  const parts: string[] = [];
  if (step.durationS != null) parts.push(formatDurationS(step.durationS));
  if (step.costUsd != null) parts.push(formatCost(step.costUsd));
  return parts.join(' · ');
}

export type ActivityTone = 'running' | 'done' | 'failed' | 'idle';
export interface ActivityState { label: string; tone: ActivityTone }

export function cortexRunLabel(run: ThreadDispatchInfo): string {
  return run.runName ? `cortex-run ${run.runName}` : 'cortex-run';
}

export function runActivity(status: string): ActivityState {
  if (status === 'running') return { label: 'Running', tone: 'running' };
  if (status === 'completed') return { label: 'Done', tone: 'done' };
  if (status === 'failed' || status === 'cancelled') return { label: 'Failed', tone: 'failed' };
  return { label: status || 'Unknown', tone: 'idle' };
}

export function subtaskActivity(task: TaskInfo): ActivityState {
  if (task.status === 'done') return { label: 'Done', tone: 'done' };
  if (task.blockedBy) return { label: 'Blocked', tone: 'failed' };
  if (task.claimedBy) return { label: 'Running', tone: 'running' };
  if (task.actionable) return { label: 'Open', tone: 'idle' };
  return { label: 'Waiting', tone: 'idle' };
}

/** Relative age of an ISO timestamp: "just now" / "42m" / "3h" / "2d". */
export function formatAge(iso: string, now: number): string {
  const diffS = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (diffS < 60) return 'just now';
  const m = Math.floor(diffS / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/** Thread card meta line "thr_8f2c · step 3/4 · 42m" (prototype expThread.metaLine). */
export function threadMetaLine(info: ThreadInfo, now: number): string {
  const parts: string[] = [info.id];
  if (info.currentStep) parts.push(`step ${info.currentStep.index + 1}/${info.totalSteps}`);
  parts.push(formatAge(info.createdAt, now));
  return parts.join(' · ');
}

export interface DepthInfo {
  filled: number;
  total: number;
  text: string;
}

/**
 * Depth dots + "k/5" text (prototype expThread.dots + depthText). `filled` = deepest level present
 * in the subthread tree (root=1), clamped to MAX_LEVEL; `total` = MAX_LEVEL (5).
 */
export function depthInfo(detail: ThreadDetail): DepthInfo {
  const filled = treeMaxLevel(detail.children);
  return { filled, total: MAX_LEVEL, text: `${filled}/${MAX_LEVEL}` };
}

/** Count of machines currently online (the Machines-tab badge = online, not total). */
export function onlineMachineCount(machines: MachineInfo[] | undefined): number {
  return machines ? machines.filter((m) => m.online).length : 0;
}

/**
 * Machine online status → status-pill colors + label, mirroring threadPill convention.
 * Online maps to the done-green pair; offline to the default grey.
 */
export function machinePill(online: boolean): Pill {
  return online
    ? { bg: '#E9F4EE', fg: '#23854F', text: 'Online' }
    : { bg: '#F1F2F5', fg: '#8A93A2', text: 'Offline' };
}
