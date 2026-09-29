import type { ThreadInfo, ScheduleInfo, ExecutionInfo, SystemDaemonStatus } from '@cortex-agent/ui-contract';
import {
  buildDaemonVm as buildSharedDaemonVm,
  daemonStatusTone,
  type DaemonProcessVm,
  type DaemonRebuildVm,
  type DaemonVm,
} from '@/features/daemon/daemon-vm';
import { relTime, type TimeLang } from '@/lib/time-format';

export type MDaemonProcess = DaemonProcessVm;

/** Real last-restart event surfaced in the 最近事件 card (null when the daemon never recorded one). */
export interface MDaemonRestart {
  /** Relative time label from the real `lastRestart.at`. */
  time: string;
}

export type MEventTone = 'default' | 'fail';
export interface MDaemonEvent {
  id: string;
  /** Relative time label from the real `startedAt`. */
  time: string;
  /** Honest real reference: execution type + optional task id. */
  ref: string;
  /** Raw execution status (the View maps it to a localized word). */
  status: ExecutionInfo['status'];
  tone: MEventTone;
}

export interface MDaemonVm {
  /** Daemon reachable — threads/schedules queries returned without error. Drives the header pill. */
  ok: boolean;
  /** Real active-thread count (running + waiting), from `threads.list`. */
  threadCount: number;
  /** Real schedule count, from `schedules.list`. */
  scheduleCount: number;
  /** Real process rows from `system.daemonStatus` (or an honest fallback when it has not resolved). */
  processes: MDaemonProcess[];
  /** Real last-restart event from `system.daemonStatus`, or null. */
  lastRestart: MDaemonRestart | null;
  /** Recent activity mapped from `executions.list` (may be empty — honest). */
  events: MDaemonEvent[];
  /** The supervisor's hot rebuild — in flight, or the last one it finished. Null on a plain install
   *  (nothing ever rebuilds) and while no record exists yet. Shared with the desktop modal. */
  rebuild: DaemonRebuildVm | null;
}

const MAX_EVENTS = 5;
const FAIL_STATUS = new Set<ExecutionInfo['status']>(['failed', 'cancelled', 'stale']);

function fallbackProcesses(facts: DaemonVm, ok: boolean): MDaemonProcess[] {
  if (facts.processes.length > 0) return facts.processes;
  const status = ok ? 'running' : 'unknown';
  const process = (name: string): MDaemonProcess => ({
    name, label: '', status, tone: daemonStatusTone(status),
    pid: null, port: null, uptime: null,
  });
  return [process('cortex-server'), process('cortex-daemon')];
}

const EXECUTION_TYPE_ZH: Record<ExecutionInfo['type'], string> = { local: '本地', dispatch: '派发' };

function mapEvents(executions: ExecutionInfo[], now: number, lang: TimeLang): MDaemonEvent[] {
  return executions.slice(0, MAX_EVENTS).map((execution) => {
    const type = lang === 'zh' ? EXECUTION_TYPE_ZH[execution.type] ?? execution.type : execution.type;
    return {
      id: execution.id,
      time: relTime(execution.startedAt, now, lang),
      ref: execution.taskId ? `${type} · ${execution.taskId}` : type,
      status: execution.status,
      tone: FAIL_STATUS.has(execution.status) ? 'fail' : 'default',
    };
  });
}

function restartEvent(facts: DaemonVm, now: number, lang: TimeLang): MDaemonRestart | null {
  const at = facts.lastRestart?.at;
  if (!at) return null;
  return { time: relTime(at, now, lang) };
}

export function buildDaemonVm(input: {
  threads: ThreadInfo[]; schedules: ScheduleInfo[]; executions: ExecutionInfo[];
  ok: boolean; daemon?: SystemDaemonStatus | null; now?: number; lang: TimeLang;
}): MDaemonVm {
  const now = input.now ?? Date.now();
  const facts = buildSharedDaemonVm(input.daemon, input.lang, now);
  return {
    ok: input.ok,
    threadCount: input.threads.length,
    scheduleCount: input.schedules.length,
    processes: fallbackProcesses(facts, input.ok),
    lastRestart: restartEvent(facts, now, input.lang),
    events: mapEvents(input.executions, now, input.lang),
    rebuild: facts.rebuild,
  };
}
