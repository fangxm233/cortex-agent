import type {
  ThreadInfo,
  ThreadStepDetail,
  ThreadDetail,
  MachineInfo,
} from '@cortex-agent/ui-contract';
import { treeMaxLevel, MAX_LEVEL } from '@/features/thread/nested-threads';
import { formatUsd } from '@/lib/format';
import { formatSpanPrecise, relTime, type TimeLang } from '@/lib/time-format';
import { pickVocab } from '@/i18n';
import { fillStep, workbenchCopy } from '@/features/workbench/workbench-copy';

type ThreadSubtaskInfo = ThreadDetail['subtasks'][number];

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
export function threadPill(status: ThreadInfo['status'], lang: TimeLang): Pill {
  const L = pickVocab(lang);
  switch (status) {
    case 'running':
      return { bg: 'var(--pill-running-bg)', fg: 'var(--pill-running-fg)', text: L.pillRunning };
    case 'waiting':
      return { bg: 'var(--pill-waiting-bg)', fg: 'var(--pill-waiting-fg)', text: L.pillWaiting };
    case 'completed':
      return { bg: 'var(--pill-done-bg)', fg: 'var(--pill-done-fg)', text: L.pillDone };
    case 'failed':
      return { bg: 'var(--pill-failed-bg)', fg: 'var(--pill-failed-fg)', text: L.pillFailed };
    default:
      return { bg: 'var(--pill-cancelled-bg)', fg: 'var(--pill-cancelled-fg)', text: L.pillCancelled };
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
  return formatUsd(v);
}

export interface RightPanelBudget {
  todayLabel: string;
  limitLabel: string;
  percent: number;
}

/** Project-scoped daily spend, limit, and clamped progress for the right-panel budget bar. */
export function rightPanelBudget(
  today: number | undefined,
  dailyLimit: number | undefined,
): RightPanelBudget {
  const todayLabel = typeof today === 'number' ? formatCost(today) : '—';
  if (dailyLimit == null || dailyLimit <= 0) {
    return { todayLabel, limitLabel: '—', percent: 0 };
  }
  const percent = Math.max(0, Math.min(100, ((today ?? 0) / dailyLimit) * 100));
  return { todayLabel, limitLabel: formatCost(dailyLimit), percent };
}

/** Collapsed step meta "39m · $2.10" (duration then cost); omits null parts. */
export function stepMeta(step: ThreadStepDetail, lang: TimeLang): string {
  const parts: string[] = [];
  if (step.durationS != null) parts.push(formatSpanPrecise(Math.round(step.durationS) * 1000, lang));
  if (step.costUsd != null) parts.push(formatCost(step.costUsd));
  return parts.join(' · ');
}

export type ActivityTone = 'running' | 'done' | 'failed' | 'idle';
export interface ActivityState { label: string; tone: ActivityTone }

export function subtaskActivity(task: ThreadSubtaskInfo, lang: TimeLang): ActivityState {
  const L = pickVocab(lang);
  if (task.status === 'done') return { label: L.pillDone, tone: 'done' };
  if (task.blockedBy) return { label: L.mBlockedPill, tone: 'failed' };
  if (task.claimedBy) return { label: L.pillRunning, tone: 'running' };
  if (task.actionable) return { label: workbenchCopy(lang).actOpen, tone: 'idle' };
  return { label: L.pillWaiting, tone: 'idle' };
}

/** Relative age of an ISO timestamp: "now" / "42m" / "3h" / "2d" · "刚刚" / "42分钟前". */
export function formatAge(iso: string, now: number, lang: TimeLang): string {
  return relTime(iso, now, lang);
}

/** Thread card meta line "thr_8f2c · task a293 · step 3/4 · 42m". */
export function threadMetaLine(info: ThreadInfo, now: number, lang: TimeLang): string {
  const parts: string[] = [info.id];
  if (info.taskId) parts.push(pickVocab(lang).cmTaskRef.replace('{id}', info.taskId));
  if (info.currentStep) parts.push(fillStep(workbenchCopy(lang).metaStep, info.currentStep.index + 1, info.totalSteps));
  parts.push(formatAge(info.createdAt, now, lang));
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
export function machinePill(online: boolean, lang: TimeLang): Pill {
  const copy = workbenchCopy(lang);
  return online
    ? { bg: 'var(--pill-done-bg)', fg: 'var(--pill-done-fg)', text: copy.machineOnline }
    : { bg: 'var(--pill-cancelled-bg)', fg: 'var(--pill-cancelled-fg)', text: copy.machineOffline };
}
