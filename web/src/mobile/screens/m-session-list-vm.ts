// Pure view-model for the 1a 会话列表 screen. Maps real `sessions.list` (origin='direct', scoped to
// the current project) into one flat row list, in the same order as a desktop rail folder (unread
// first, then most recent). Each row carries its own relative time, so there are no day buckets.
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { orderSessions } from '@/features/session/list/session-groups';
import { relTimeZh } from '@/mobile/ui/format';

export type MSessionStatus = ReturnType<typeof sessionStatusLine>;

export interface MSessionRow {
  id: string;
  title: string;
  /** Relative time label (real, from lastUsedAt||createdAt). */
  time: string;
  running: boolean;
  /** Real agent-turn count; null when unknown. */
  numTurns: number | null;
  unread: boolean;
  status: MSessionStatus;
}

/**
 * The status-line for a session row. Awaiting user action (pending ask-user / plan approval) →
 * `awaiting` + `等待操作` — the ONLY state that renders the amber「需要你」dot; it wins even while a
 * turn or a background task is technically live (the agent is blocked on the interaction).
 * Background-held (web bg-hold snapshot: foreground turn done, background task still running) →
 * `background` + `后台运行`, now rendered with the SAME run-blue dot as running (background is no
 * longer amber — only a needed user action is). Running → `running · N turns` (turns only when
 * known); idle-but-waiting-on-a-waitpoint → `等 N 个信号` with a hollow ring; idle → `空闲`. Per-session cost has NO DTO source (SessionInfo carries none) →
 * deliberately omitted, never fabricated (the scheme's `· $0.31` is a design mock).
 */
export function sessionStatusLine(s: SessionInfo): { kind: 'running' | 'background' | 'awaiting' | 'waiting-external' | 'idle'; text: string } {
  if (s.awaitingInput) {
    return { kind: 'awaiting', text: '等待操作' };
  }
  if (s.running && s.backgroundRunning) {
    return { kind: 'background', text: '后台运行' };
  }
  if (s.running) {
    return { kind: 'running', text: s.numTurns != null ? `running · ${s.numTurns} turns` : 'running' };
  }
  // Idle, but an external signal is still expected (an armed waitpoint). Ranked below every live
  // state and below `awaiting`: nothing here needs the user, so it must not borrow amber.
  if ((s.waitingOn ?? 0) > 0) {
    return { kind: 'waiting-external', text: `等 ${s.waitingOn} 个信号` };
  }
  return { kind: 'idle', text: '空闲' };
}

function toRow(s: SessionInfo, now: number): MSessionRow {
  return {
    id: s.sessionId,
    title: s.label || s.name || s.sessionId,
    time: relTimeZh(s.lastUsedAt || s.createdAt, now),
    running: s.running,
    numTurns: s.numTurns,
    unread: s.unread,
    status: sessionStatusLine(s),
  };
}

/** Rows for the 会话 list, in desktop rail-folder order. */
export function buildSessionRows(sessions: SessionInfo[], now: number = Date.now()): MSessionRow[] {
  return orderSessions(sessions).map((s) => toRow(s, now));
}
