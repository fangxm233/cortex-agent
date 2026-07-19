// Pure view-model for the 1a 会话列表 screen (scheme-mobile.dc.html 1a L86-128). Maps real
// `sessions.list` (origin='direct', scoped to the current project) into day-grouped rows. Reuses the
// desktop `groupSessions` bucketing so mobile + desktop agree on TODAY/YESTERDAY/EARLIER.
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { groupSessions, type SessionGroupLabel } from '@/features/workbench/session-groups';
import { relTimeZh } from '@/mobile/ui/format';

export interface MSessionRow {
  id: string;
  title: string;
  /** Relative time label (real, from lastUsedAt||createdAt). */
  time: string;
  running: boolean;
  /** Real agent-turn count; null when unknown. */
  numTurns: number | null;
  unread: boolean;
}

export interface MSessionGroup {
  /** Stable key → the view maps it to a localized label (今天/昨天/更早). */
  key: SessionGroupLabel;
  rows: MSessionRow[];
}

/**
 * The status-line for a session row. Awaiting user action (pending ask-user / plan approval) →
 * `awaiting` + `等待操作` — the ONLY state that renders the amber「需要你」dot; it wins even while a
 * turn or a background task is technically live (the agent is blocked on the interaction).
 * Background-held (web bg-hold snapshot: foreground turn done, background task still running) →
 * `background` + `后台运行`, now rendered with the SAME run-blue dot as running (background is no
 * longer amber — only a needed user action is). Running → `running · N turns` (turns only when
 * known); idle → `空闲`. Per-session cost has NO DTO source (SessionInfo carries none) →
 * deliberately omitted, never fabricated (the scheme's `· $0.31` is a design mock).
 */
export function sessionStatusLine(s: SessionInfo): { kind: 'running' | 'background' | 'awaiting' | 'idle'; text: string } {
  if (s.awaitingInput) {
    return { kind: 'awaiting', text: '等待操作' };
  }
  if (s.running && s.backgroundRunning) {
    return { kind: 'background', text: '后台运行' };
  }
  if (s.running) {
    return { kind: 'running', text: s.numTurns != null ? `running · ${s.numTurns} turns` : 'running' };
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
  };
}

/** Day-grouped rows for the 会话 list, newest bucket first, empty buckets dropped. */
export function buildSessionGroups(sessions: SessionInfo[], now: number = Date.now()): MSessionGroup[] {
  return groupSessions(sessions, now).map((g) => ({
    key: g.label,
    rows: g.items.map((s) => toRow(s, now)),
  }));
}
