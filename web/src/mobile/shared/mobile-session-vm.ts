import type { ThreadDetail } from '@cortex-agent/ui-contract';
import { formatUsd } from '@/lib/format';
import { clockTime, dayLabel, formatSpanPrecise, type TimeLang } from '@/lib/time-format';
import { pickVocab, type Vocab } from '@/i18n';

/**
 * Day-divider label for the mobile chat stream (scheme L2946 "今天 07:42"): Today / Yesterday for
 * the current & previous calendar day, else the date — in the UI language, suffixed with local HH:MM.
 */
export function mobileDivider(lang: TimeLang): (ts: string, now: Date) => string {
  return (ts, now) => `${dayLabel(ts, now, lang)} ${clockTime(ts)}`;
}

export type StepperState = 'done' | 'running' | 'pending';

export interface StepperNode {
  label: string;
  state: StepperState;
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

// Thread status → localized pill word (aborted reads as failed, like the thread list).
function statusWord(status: ThreadDetail['status'], vocab: Vocab): string {
  switch (status) {
    case 'running': return vocab.pillRunning;
    case 'waiting': return vocab.pillWaiting;
    case 'completed': return vocab.pillDone;
    case 'failed':
    case 'aborted': return vocab.pillFailed;
    case 'cancelled': return vocab.pillCancelled;
    default: return status;
  }
}

/**
 * Build the horizontal stepper card model from a live ThreadDetail (scheme L2954-2973). Nodes come
 * from the real `steps` (data-driven — not the scheme's fixed 计划/执行/评审/提交); elapsed derives
 * from createdAt→updatedAt, cost from totalCostUsd, sub-thread count from children.length.
 */
export function buildMobileStepper(detail: ThreadDetail, lang: TimeLang): MobileStepper {
  const vocab = pickVocab(lang);
  const nodes: StepperNode[] = detail.steps.map((s) => ({
    label: s.stage ?? vocab.cmStepN.replace('{n}', String(s.stepIndex + 1)),
    state: stepState(s.status),
  }));

  const pillText =
    detail.status === 'running' && detail.currentStep
      ? `${detail.currentStep.name} ${detail.currentStep.index + 1}/${detail.totalSteps}`
      : statusWord(detail.status, vocab);

  const elapsedMs = new Date(detail.updatedAt).getTime() - new Date(detail.createdAt).getTime();

  return {
    name: detail.templateName,
    pillText,
    nodes,
    footer: {
      elapsed: formatSpanPrecise(Math.floor(Math.max(0, elapsedMs) / 60000) * 60000, lang),
      cost: formatUsd(detail.totalCostUsd),
      subCount: detail.children.length,
    },
  };
}
