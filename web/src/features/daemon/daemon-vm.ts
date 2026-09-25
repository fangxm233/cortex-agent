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

export interface DaemonExtraVm {
  key: string;
  value: string | number;
}

export interface DaemonProcessVm extends Omit<DaemonProcessInfo, 'extras'> {
  tone: Tone;
  extras: DaemonExtraVm[];
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
function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function spanBetween(from: string | null, to: string | null, now: number): string | null {
  if (!from) return null;
  const start = Date.parse(from);
  if (Number.isNaN(start)) return null;
  const end = to ? Date.parse(to) : now;
  return formatSpan((Number.isNaN(end) ? now : end) - start);
}

function stepVm(step: DaemonRebuildStep, now: number): DaemonRebuildStepVm {
  return {
    name: step.name,
    status: step.status,
    tone: rebuildStepTone(step.status),
    detail: step.detail,
    duration: spanBetween(step.startedAt, step.endedAt, now),
  };
}

function rebuildVm(progress: DaemonRebuildProgress, now: number): DaemonRebuildVm {
  const steps = progress.steps.map((step) => stepVm(step, now));
  return {
    status: progress.status,
    running: progress.status === 'running',
    reason: progress.reason,
    current: progress.current,
    steps,
    completed: steps.filter((step) => step.status === 'done').length,
    total: steps.length,
    elapsed: spanBetween(progress.startedAt, progress.endedAt, now) ?? '0s',
    startedAt: progress.startedAt,
    endedAt: progress.endedAt,
    detail: progress.detail,
  };
}

/** `now` is a parameter so a running rebuild's clock is the caller's, not a hidden one — the poll
 *  that refreshes the status is what advances it, and tests can pin it. */
export function buildDaemonVm(
  status: SystemDaemonStatus | null | undefined,
  now: number = Date.now(),
): DaemonVm {
  if (!status) return { processes: [], lastRestart: null, rebuild: null };
  return {
    processes: status.processes.map(processVm),
    lastRestart: status.lastRestart,
    rebuild: status.rebuild ? rebuildVm(status.rebuild, now) : null,
  };
}

function processVm(process: DaemonProcessInfo): DaemonProcessVm {
  const extras = process.extras
    ? Object.entries(process.extras).map(([key, value]) => ({ key, value }))
    : [];
  return { ...process, tone: daemonStatusTone(process.status), extras };
}
