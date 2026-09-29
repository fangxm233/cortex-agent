import type {
  DaemonProcessInfo,
  DaemonRebuildProgress,
  DaemonRebuildStatus,
  DaemonRebuildStep,
  DaemonRebuildStepName,
  DaemonRebuildStepStatus,
  SystemDaemonStatus,
} from '@cortex-agent/ui-contract';
import type { Tone } from '@/design/tone';
import { formatSpanPrecise, type TimeLang } from '@/lib/time-format';

export interface DaemonProcessVm extends DaemonProcessInfo {
  tone: Tone;
}

export interface DaemonRebuildStepVm {
  name: DaemonRebuildStepName;
  status: DaemonRebuildStepStatus;
  tone: Tone;
  /** Which install path ran, why a step failed — whatever the supervisor qualified it with. */
  detail: string | null;
  /** How long it took, or has been running for. Null until it starts. */
  duration: string | null;
}

export interface DaemonRebuildVm {
  status: DaemonRebuildStatus;
  running: boolean;
  /** What triggered the pipeline, verbatim ('src change: core/foo.ts'). */
  reason: string;
  current: DaemonRebuildStepName | null;
  steps: DaemonRebuildStepVm[];
  /** Steps that finished, out of the plan — the honest denominator, not a percentage guess. */
  completed: number;
  total: number;
  /** Elapsed so far, or total taken once terminal. */
  elapsed: string;
  startedAt: string;
  endedAt: string | null;
  /** Abort reason, or the note attached to a terminal record. */
  detail: string | null;
}

export interface DaemonVm {
  processes: DaemonProcessVm[];
  lastRestart: SystemDaemonStatus['lastRestart'] | null;
  rebuild: DaemonRebuildVm | null;
}

export function daemonStatusTone(status: DaemonProcessInfo['status']): Tone {
  if (status === 'running') return 'done';
  if (status === 'stopped') return 'failed';
  return 'cancelled';
}

export function rebuildStepTone(status: DaemonRebuildStepStatus): Tone {
  if (status === 'running') return 'running';
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'skipped') return 'cancelled';
  return 'waiting';
}

export function rebuildStatusTone(status: DaemonRebuildStatus): Tone {
  if (status === 'running') return 'running';
  if (status === 'succeeded') return 'done';
  // A deferral is not a failure: it built, and it is waiting for the app to finish a turn.
  if (status === 'deferred') return 'waiting';
  return 'failed';
}

/** Compact duration: sub-minute work reads in seconds (one decimal while it is short), longer
 *  work in minutes. A rebuild is a ten-second-to-two-minute affair, so this is the whole range. */
function formatSpan(ms: number, lang: TimeLang): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (safe < 10_000) return `${(safe / 1000).toFixed(1)}${lang === 'zh' ? '秒' : 's'}`;
  return formatSpanPrecise(Math.round(safe / 1000) * 1000, lang);
}

function spanBetween(from: string | null, to: string | null, now: number, lang: TimeLang): string | null {
  if (!from) return null;
  const start = Date.parse(from);
  if (Number.isNaN(start)) return null;
  const end = to ? Date.parse(to) : now;
  return formatSpan((Number.isNaN(end) ? now : end) - start, lang);
}

function stepVm(step: DaemonRebuildStep, now: number, lang: TimeLang): DaemonRebuildStepVm {
  return {
    name: step.name,
    status: step.status,
    tone: rebuildStepTone(step.status),
    detail: step.detail,
    duration: spanBetween(step.startedAt, step.endedAt, now, lang),
  };
}

function rebuildVm(progress: DaemonRebuildProgress, now: number, lang: TimeLang): DaemonRebuildVm {
  const steps = progress.steps.map((step) => stepVm(step, now, lang));
  return {
    status: progress.status,
    running: progress.status === 'running',
    reason: progress.reason,
    current: progress.current,
    steps,
    completed: steps.filter((step) => step.status === 'done').length,
    total: steps.length,
    elapsed: spanBetween(progress.startedAt, progress.endedAt, now, lang) ?? formatSpan(0, lang),
    startedAt: progress.startedAt,
    endedAt: progress.endedAt,
    detail: progress.detail,
  };
}

/** `now` is a parameter so a running rebuild's clock is the caller's, not a hidden one — the poll
 *  that refreshes the status is what advances it, and tests can pin it. */
export function buildDaemonVm(
  status: SystemDaemonStatus | null | undefined,
  lang: TimeLang,
  now: number = Date.now(),
): DaemonVm {
  if (!status) return { processes: [], lastRestart: null, rebuild: null };
  return {
    processes: status.processes.map(processVm),
    lastRestart: status.lastRestart,
    rebuild: status.rebuild ? rebuildVm(status.rebuild, now, lang) : null,
  };
}

function processVm(process: DaemonProcessInfo): DaemonProcessVm {
  return { ...process, tone: daemonStatusTone(process.status) };
}
