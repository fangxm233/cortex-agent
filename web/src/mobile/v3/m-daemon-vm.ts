// Pure view-model for the 1r Daemon 状态 screen (scheme-mobile.dc.html 1r L888-932). Drilled from
// 1l 设置 「Daemon ›」. Maps the REAL data the mobile tRPC surface exposes into the screen model:
//   • `system.daemonStatus` → per-process name / label / status / pid / port / uptime / extras + the
//     lastRestart {at, reason}. This is the SAME query the desktop 17a DaemonStatusModal consumes, so
//     the process card now shows REAL liveness + pid/port/uptime instead of an "在 Web 不可见" note.
//   • `threads.list` (active count) + `schedules.list` (count) → the real summary line (kept).
//   • `executions.list` → recent-activity rows (kept, honestly disclosed as NOT the daemon.log).
//
// Framework-free so it is unit-tested in isolation (TDD).
//
// 守则11 no-fabrication:
//   • Any DTO field that is null (pid / port / uptime null on a stale PID or non-Linux host) stays null
//     and is rendered as an honest `—` by the View — never fabricated.
//   • The daemon event log (scheme `daemon.log`, `watchdog ok`, `backend fallback` lines) has no query
//     scope → the 最近事件 card surfaces the REAL `lastRestart` (at/reason) plus `executions.list`
//     recent activity, explicitly disclosed as such — no synthetic log lines.
//   • When `system.daemonStatus` has not resolved (loading / error / empty payload) the process card
//     falls back to the two known process names with status derived from reachability (running when the
//     other queries succeed, otherwise `unknown`) and null metrics — honest, not fabricated.
import type {
  ThreadInfo,
  ScheduleInfo,
  ExecutionInfo,
  SystemDaemonStatus,
} from '@cortex-agent/ui-contract';
import { relTimeZh } from '@/mobile/ui/format';

export type MProcStatus = 'running' | 'stopped' | 'unknown';

export interface MDaemonProcess {
  /** Fixed process name (mono, not localized), from the DTO. */
  name: string;
  /** Short role label from the DTO (e.g. `server`, `daemon`). */
  label: string;
  /** Liveness status straight from the DTO — drives the dot color (running/stopped/unknown). */
  status: MProcStatus;
  /** Real OS pid, or null (stale / not readable) → honest `—`. */
  pid: number | null;
  /** Real listening port, or null (process has none / not readable) → honest `—`. */
  port: number | null;
  /** Real uptime string, or null (no /proc on non-Linux) → honest `—`. */
  uptime: string | null;
  /** Extra process metrics from the DTO, flattened to ordered pairs (may be empty). */
  extras: Array<{ k: string; v: string | number }>;
}

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

function mapProcesses(daemon: SystemDaemonStatus | null | undefined, ok: boolean): MDaemonProcess[] {
  if (daemon && daemon.processes.length > 0) {
    return daemon.processes.map((p) => ({
      name: p.name,
      label: p.label,
      status: p.status,
      pid: p.pid,
      port: p.port,
      uptime: p.uptime,
      extras: p.extras ? Object.entries(p.extras).map(([k, v]) => ({ k, v })) : [],
    }));
  }
  // Honest fallback: no daemonStatus payload yet → known names, status from reachability, null metrics.
  const status: MProcStatus = ok ? 'running' : 'unknown';
  return [
    { name: 'cortex-server', label: '', status, pid: null, port: null, uptime: null, extras: [] },
    { name: 'cortex-daemon', label: '', status, pid: null, port: null, uptime: null, extras: [] },
  ];
}

export function buildDaemonVm(input: {
  threads: ThreadInfo[];
  schedules: ScheduleInfo[];
  executions: ExecutionInfo[];
  ok: boolean;
  daemon?: SystemDaemonStatus | null;
  now?: number;
}): MDaemonVm {
  const now = input.now ?? Date.now();
  const events: MDaemonEvent[] = input.executions.slice(0, MAX_EVENTS).map((e) => ({
    id: e.id,
    time: relTimeZh(e.startedAt, now),
    ref: e.taskId ? `${e.type} · ${e.taskId}` : e.type,
    status: e.status,
    tone: FAIL_STATUS.has(e.status) ? 'fail' : 'default',
  }));
  const restartAt = input.daemon?.lastRestart?.at ?? null;
  const lastRestart: MDaemonRestart | null = restartAt
    ? { time: relTimeZh(restartAt, now), reason: input.daemon?.lastRestart?.reason ?? null }
    : null;
  return {
    ok: input.ok,
    threadCount: input.threads.length,
    scheduleCount: input.schedules.length,
    processes: mapProcesses(input.daemon, input.ok),
    lastRestart,
    events,
  };
}
