// Pure view-model for the 1r Daemon 状态 screen (scheme-mobile.dc.html 1r L888-932). Drilled from
// 1l 设置 「Daemon ›」. Maps the REAL data the mobile tRPC surface exposes — `threads.list` (active
// count), `schedules.list` (count), and a best-effort `executions.list` (recent activity) — into the
// screen model. Framework-free so it is unit-tested in isolation (TDD).
//
// 守则11 no-fabrication — the scheme mocks a rich process panel that has NO tRPC query source here:
//   • pid / port / uptime / api p50 / ws connection count → NOT in any query scope on this surface →
//     rendered as an honest "在 Web 不可见" note (see MDaemonView), never fabricated.
//   • the daemon event log (scheme `daemon.log`, `watchdog ok`, `backend fallback` lines) → no
//     daemon-log query scope exists → the 最近事件 card is repurposed to honest `executions.list`
//     recent activity, explicitly disclosed as such (not presented as the daemon log).
//   • per-process liveness → no per-process status on this surface → `live` is derived from whether the
//     queries themselves succeeded (daemon reachable), the honest signal available.
// NOTE: `system.daemonStatus` DOES expose pid/port/uptime/status (desktop 17a uses it); it is out of
//   this screen's assigned data budget and intentionally NOT consumed here (flagged as a follow-up).
import type { ThreadInfo, ScheduleInfo, ExecutionInfo } from '@cortex-agent/ui-contract';
import { relTimeZh } from '@/mobile/ui/format';

export interface MDaemonProcess {
  /** Fixed process name (mono, not localized). */
  name: string;
  /** Liveness implied by successful queries (daemon reachable) — no per-process status DTO here. */
  live: boolean;
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
  /** Daemon reachable — queries returned without error. Drives the header pill + process dots. */
  ok: boolean;
  /** Real active-thread count (running + waiting), from `threads.list`. */
  threadCount: number;
  /** Real schedule count, from `schedules.list`. */
  scheduleCount: number;
  processes: MDaemonProcess[];
  /** Recent activity mapped from `executions.list` (may be empty — honest). */
  events: MDaemonEvent[];
}

const MAX_EVENTS = 5;
const FAIL_STATUS = new Set<ExecutionInfo['status']>(['failed', 'cancelled', 'stale']);

export function buildDaemonVm(input: {
  threads: ThreadInfo[];
  schedules: ScheduleInfo[];
  executions: ExecutionInfo[];
  ok: boolean;
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
  return {
    ok: input.ok,
    threadCount: input.threads.length,
    scheduleCount: input.schedules.length,
    processes: [
      { name: 'cortex-server', live: input.ok },
      { name: 'cortex-daemon', live: input.ok },
    ],
    events,
  };
}
