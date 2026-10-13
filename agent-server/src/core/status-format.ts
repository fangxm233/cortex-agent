import { formatDurationCompact } from './utils.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';
import { shortSessionId } from './short-session-id.js';

export function computeElapsed(startTime: number): { elapsedStr: string; elapsedS: number } {
  const elapsedS = (Date.now() - startTime) / 1000;
  return { elapsedStr: formatDurationCompact(elapsedS), elapsedS };
}

export function formatMetricsSuffix({ costUsd, numTurns }: { costUsd: number | null; numTurns: number | null }): string {
  const turnsStr = numTurns != null ? ` · ${t('notice.turns', { n: numTurns })}` : '';
  const costStr = costUsd != null ? ` · $${costUsd.toFixed(4)}` : '';
  return `${turnsStr}${costStr}`;
}

/** Build a compact stable-ID tag for Slack status messages. */
export function buildSessionTag(sessionId: string | null): string {
  return sessionId ? `\`${shortSessionId(sessionId)}\` | ` : '';
}

/** `todoProgress` is a pre-rendered task-list line (see core/todo.ts renderTodoProgress).
 *  Passing the rendered string rather than a snapshot keeps this formatter free of todo parsing
 *  and lets every caller decide whether the surface shows task progress at all. */
export function buildUserProcessingMessage({ startTime, elapsed_s = null, num_turns = null, profileName, sessionId = null, todoProgress = null }: { startTime: number; elapsed_s?: number | null; num_turns?: number | null; profileName: string; sessionId?: string | null; todoProgress?: string | null }): string {
  const elapsed = elapsed_s ?? ((Date.now() - startTime) / 1000);
  const sessionTag = buildSessionTag(sessionId);
  const turnsStr = num_turns != null ? ` | ${Icons.repeat} ${t('notice.turns', { n: num_turns })}` : '';
  const todoStr = todoProgress ? ` | ${Icons.todo} ${todoProgress}` : '';
  return `${Icons.processing} ${t('status.processing')} | ${sessionTag}${profileName || 'default'} | ${Icons.stopwatch} ${formatDurationCompact(elapsed || 0)}${turnsStr}${todoStr}`;
}

/** Every line a chat turn's status message can end on. `processing` — the live line this replaces
 *  — is {@link buildUserProcessingMessage} just above; the two belong together, which is why these
 *  live here rather than in orchestration: what the line SAYS is pure, only deciding WHEN to write
 *  it needs an adapter. */
export type TurnStatus =
  | { kind: 'done' }
  | { kind: 'awaiting-user' }
  /** Foreground work is over, background tasks remain. `remaining` = running + undelivered. */
  | { kind: 'background-waiting'; remaining: number }
  /** The max-wait cap fired on work that legitimately never ends (a tunnel, a monitor). */
  | { kind: 'background-capped' }
  /** The backend died while background work was pending — never seal that as "done". */
  | { kind: 'background-interrupted' }
  | { kind: 'rate-limited' }
  | { kind: 'cancelled' }
  /** The user edited the message that started this turn, so this turn no longer answers anything. */
  | { kind: 'superseded' }
  | { kind: 'error' };

export interface TurnStatusContext {
  sessionId: string | null;
  elapsedStr: string;
  /** {@link formatMetricsSuffix} output. Absent on the paths that seal without a result to count
   *  (a thrown error, a cancel) — those show the elapsed time alone. */
  metrics?: string;
}

/**
 * Render one turn-status line. These strings are what a user reads in Slack/Feishu, so the shapes
 * below are the shipped ones, character for character.
 *
 * Note the asymmetry, which is deliberate and load-bearing: `done` leads with the OUTCOME and puts
 * the session tag after a `|`, while every other line leads with the tag. A finished turn is read
 * at a glance in a busy channel; a turn that is still holding is read for which session it is.
 */
export function renderTurnStatus(status: TurnStatus, ctx: TurnStatusContext): string {
  const tag = buildSessionTag(ctx.sessionId);
  const tail = `(${ctx.elapsedStr}${ctx.metrics ?? ''})`;
  switch (status.kind) {
    case 'done':
      return `${Icons.ok} ${t('status.done')} | ${tag}${tail}`;
    case 'awaiting-user':
      return `${Icons.waiting} ${tag}${t('status.waitingForUserInput')} ${tail}`;
    case 'background-waiting':
      return `${Icons.waiting} ${tag}${t('status.backgroundRunning')} (${status.remaining}) ${tail}`;
    case 'background-capped':
      return `${Icons.waiting} ${tag}${t('status.backgroundStillRunning')} ${tail}`;
    case 'background-interrupted':
      return `${Icons.warning} ${tag}${t('status.backgroundInterrupted')} ${tail}`;
    case 'rate-limited':
      return `${Icons.warning} ${tag}${t('status.rateLimitedExhausted')} ${tail}`;
    case 'cancelled':
      return `${Icons.stopped} ${tag}${t('status.cancelled')} ${tail}`;
    case 'superseded':
      return `${Icons.superseded} ${tag}${t('status.supersededByEdit')} ${tail}`;
    case 'error':
      return `${Icons.error} ${tag}${t('status.error')} ${tail}`;
  }
}
