// input:  ThreadInfo/ThreadDetail DTOs, shared formatters
// output: mobile thread card metadata, steps, and budget models
// pos:    Pure view model for the mobile Threads screen
// >>> If I am updated, update my header comment and CORTEX.md <<<
import type { ThreadInfo, ThreadDetail } from '@cortex-agent/ui-contract';
import { fmtMoney } from '@/mobile/ui/format';
import { formatAge, formatCost } from '@/features/workbench/right-panel-vm';

// ── 今日 budget band (scheme L188–192) ────────────────────────────────────────
// numerator = real scoped `cost.summary.today`; denominator = real `dailyBudget`, resolved against
// the same scope (a project's own budget.json override, else the global cap; `—` when the daemon
// reports no budget — honest, never the scheme's mocked $10.00). pct = today ÷ dailyBudget (0 when
// no denominator so the bar reads empty rather than fabricating a fill).
export interface MBudgetBand {
  numerator: string;
  denominator: string;
  pct: number;
}
export function threadsBudgetBand(
  today: number | undefined,
  dailyBudget: number | undefined,
): MBudgetBand {
  const hasBudget = typeof dailyBudget === 'number' && dailyBudget > 0;
  const t = typeof today === 'number' ? today : 0;
  return {
    numerator: fmtMoney(typeof today === 'number' ? today : null),
    denominator: hasBudget ? fmtMoney(dailyBudget) : '—',
    pct: hasBudget ? Math.max(0, Math.min(100, (t / dailyBudget!) * 100)) : 0,
  };
}

// ── Live (non-terminal) thread test ───────────────────────────────────────────
// `running` and `waiting` are both active threads that drill into detail and warrant a per-card
// `threads.get`. Waiting is a generic UI pause state, distinct from the approval queue.
export function isLiveThread(status: ThreadInfo['status']): boolean {
  return status === 'running' || status === 'waiting';
}

// ── Horizontal 4-step pipeline (scheme L201–209) ──────────────────────────────
export type MStepState = 'done' | 'active' | 'pending';
export interface MPipelineStep {
  label: string;
  state: MStepState;
}

/**
 * The pipeline steps for a running card. Prefers the REAL per-step stages from `threads.get`
 * (`ThreadDetail.steps` — stage name + completed/running/pending status). When the detail has not
 * loaded yet it falls back to the list summary (`ThreadInfo.currentStep.index` / `totalSteps`): steps
 * before the current index are done, the current one is active, the rest pending — labels `#N` (the real
 * stage names arrive with the detail). The scheme's 计划/执行/评审/提交 are design mocks.
 */
export function pipelineSteps(info: ThreadInfo, detail?: ThreadDetail): MPipelineStep[] {
  if (detail && detail.steps.length > 0) {
    return detail.steps.map((s, i) => ({
      label: s.stage ?? `#${i + 1}`,
      state: s.status === 'completed' ? 'done' : s.status === 'running' ? 'active' : 'pending',
    }));
  }
  if (info.totalSteps > 0) {
    const cur = info.currentStep?.index ?? -1;
    return Array.from({ length: info.totalSteps }, (_, i) => ({
      label: i === cur && info.currentStep?.name ? info.currentStep.name : `#${i + 1}`,
      state: i < cur ? 'done' : i === cur ? 'active' : 'pending',
    }));
  }
  return [];
}

// ── Running card meta line "thr_8f2c · task a293 · 42m · $2.31 · 2 子线程" ─────
// id + optional task + age come from the list summary. Cost and child count require threads.get.
export function runningMeta(
  info: ThreadInfo,
  detail: ThreadDetail | undefined,
  now: number,
  subthreadWord: string,
): string {
  const parts: string[] = [info.id];
  if (info.taskId) parts.push(`task ${info.taskId}`);
  parts.push(formatAge(info.createdAt, now));
  if (detail) {
    parts.push(formatCost(detail.totalCostUsd));
    const n = detail.children.length;
    if (n > 0) parts.push(`${n} ${subthreadWord}`);
  }
  return parts.join(' · ');
}
