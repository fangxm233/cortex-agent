// Pure view-model for the 1a 会话列表 screen. Maps real `sessions.list` (origin='direct', scoped to
// the current project) into one flat row list, in the same order as a desktop rail folder (unread
// first, then most recent). Each row carries its own relative time, so there are no day buckets.
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { orderSessions } from '@/features/session/list/session-groups';
import { relTime } from '@/mobile/ui/format';

type Lang = 'en' | 'zh';

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

const STATUS_TEXT: Record<Lang, {
  awaiting: string;
  background: string;
  running: (turns: number | null) => string;
  waiting: (n: number) => string;
  idle: string;
}> = {
  en: {
    awaiting: 'Needs your input',
    background: 'Running in background',
    running: (turns) => (turns != null ? `Running · ${turns} turns` : 'Running'),
    waiting: (n) => `Waiting on ${n} signal${n === 1 ? '' : 's'}`,
    idle: 'Idle',
  },
  zh: {
    awaiting: '等待操作',
    background: '后台运行',
    running: (turns) => (turns != null ? `运行中 · ${turns} 轮` : '运行中'),
    waiting: (n) => `等 ${n} 个信号`,
    idle: '空闲',
  },
};

/**
 * The status-line for a session row. Awaiting user action (pending ask-user / plan approval) wins
 * even while a turn or a background task is live — it is the ONLY amber「需要你」state. Background-held
 * (foreground turn done, background task still running) and running share the run-blue dot; an idle
 * session still expecting a waitpoint signal gets a hollow ring. Per-session cost has no DTO source
 * (SessionInfo carries none), so it is deliberately omitted.
 */
export function sessionStatusLine(s: SessionInfo, lang: Lang = 'en'): { kind: 'running' | 'background' | 'awaiting' | 'waiting-external' | 'idle'; text: string } {
  const t = STATUS_TEXT[lang];
  if (s.awaitingInput) return { kind: 'awaiting', text: t.awaiting };
  if (s.running) {
    return s.backgroundRunning
      ? { kind: 'background', text: t.background }
      : { kind: 'running', text: t.running(s.numTurns) };
  }
  if ((s.waitingOn ?? 0) > 0) return { kind: 'waiting-external', text: t.waiting(s.waitingOn ?? 0) };
  return { kind: 'idle', text: t.idle };
}

function toRow(s: SessionInfo, now: number, lang: Lang): MSessionRow {
  return {
    id: s.sessionId,
    title: s.label || s.name || s.sessionId,
    time: relTime(s.lastUsedAt || s.createdAt, now, lang),
    running: s.running,
    numTurns: s.numTurns,
    unread: s.unread,
    status: sessionStatusLine(s, lang),
  };
}

/** Rows for the 会话 list, in desktop rail-folder order. */
export function buildSessionRows(sessions: SessionInfo[], now: number = Date.now(), lang: Lang = 'en'): MSessionRow[] {
  return orderSessions(sessions).map((s) => toRow(s, now, lang));
}
