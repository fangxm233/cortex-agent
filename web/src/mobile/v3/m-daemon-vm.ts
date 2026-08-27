// input:  shared daemon facts plus mobile thread, schedule and recent-execution DTOs
// output: mobile daemon summary, fallback, restart and recent-activity view model
// pos:    Mobile projection over canonical daemon status semantics
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { ThreadInfo, ScheduleInfo, ExecutionInfo, SystemDaemonStatus } from '@cortex-agent/ui-contract';
import {
  buildDaemonVm as buildSharedDaemonVm,
  daemonStatusTone,
  type DaemonProcessVm,
  type DaemonVm,
} from '@/features/daemon/daemon-vm';
import { relTimeZh } from '@/mobile/ui/format';

export type MDaemonProcess = DaemonProcessVm;

/** Real last-restart event surfaced in the 最近事件 card (null when the daemon never recorded one). */
export interface MDaemonRestart {
  /** Relative time label from the real `lastRestart.at`. */
  time: string;
  /** Real restart reason, or null → honest `—`. */
  reason: string | null;
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
}

const MAX_EVENTS = 5;
const FAIL_STATUS = new Set<ExecutionInfo['status']>(['failed', 'cancelled', 'stale']);

function fallbackProcesses(facts: DaemonVm, ok: boolean): MDaemonProcess[] {
  if (facts.processes.length > 0) return facts.processes;
  const status = ok ? 'running' : 'unknown';
  const process = (name: string): MDaemonProcess => ({
    name, label: '', status, tone: daemonStatusTone(status),
    pid: null, port: null, uptime: null, extras: [],
  });
  return [process('cortex-server'), process('cortex-daemon')];
}

function mapEvents(executions: ExecutionInfo[], now: number): MDaemonEvent[] {
  return executions.slice(0, MAX_EVENTS).map((execution) => ({
    id: execution.id,
    time: relTimeZh(execution.startedAt, now),
    ref: execution.taskId ? `${execution.type} · ${execution.taskId}` : execution.type,
    status: execution.status,
    tone: FAIL_STATUS.has(execution.status) ? 'fail' : 'default',
  }));
}

function restartEvent(facts: DaemonVm, now: number): MDaemonRestart | null {
  const at = facts.lastRestart?.at;
  if (!at) return null;
  return { time: relTimeZh(at, now), reason: facts.lastRestart?.reason ?? null };
}

export function buildDaemonVm(input: {
  threads: ThreadInfo[]; schedules: ScheduleInfo[]; executions: ExecutionInfo[];
  ok: boolean; daemon?: SystemDaemonStatus | null; now?: number;
}): MDaemonVm {
  const now = input.now ?? Date.now();
  const facts = buildSharedDaemonVm(input.daemon);
  return {
    ok: input.ok,
    threadCount: input.threads.length,
    scheduleCount: input.schedules.length,
    processes: fallbackProcesses(facts, input.ok),
    lastRestart: restartEvent(facts, now),
    events: mapEvents(input.executions, now),
  };
}
