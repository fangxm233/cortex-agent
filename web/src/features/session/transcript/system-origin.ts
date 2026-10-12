import type { SystemTurnOrigin } from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';

// ── System-authored user turns ──────────────────────────────────────────────────────────────────
//
// Cortex steers work back into a session by routing a synthetic user message: a resume signal
// after a rate limit, a task or thread completion callback, a subtask's question, a backgrounded
// agent's result. The model must read those as user turns — but the reader must not, and showing
// them as a user bubble claims the human said something they never said. They render as one quiet
// hint line instead; the full text stays available through the DEBUG inspector.

const SYSTEM_REMINDER_LINE = /^<\/?system-reminder>$/i;

/** Localized name of what produced this turn. An unknown value (newer server, older client) falls
 *  back to the generic label rather than printing a raw enum at the reader. */
export function systemOriginLabel(origin: SystemTurnOrigin, L: Vocab): string {
  switch (origin) {
    case 'resume': return L.chatSystemOriginResume;
    case 'task-callback': return L.chatSystemOriginTaskCallback;
    case 'thread-callback': return L.chatSystemOriginThreadCallback;
    case 'subtask-question': return L.chatSystemOriginSubtaskQuestion;
    case 'agent-result': return L.chatSystemOriginAgentResult;
    case 'external-signal': return L.chatSystemOriginExternalSignal;
    case 'team-lead': return L.chatSystemOriginTeamLead;
    case 'worker-result': return L.chatSystemOriginWorkerResult;
    case 'worker-question': return L.chatSystemOriginWorkerQuestion;
    case 'scheduled': return L.chatSystemOriginScheduled;
    default: return unlabelledOrigin(origin, L);
  }
}

/** Compile-time exhaustiveness plus the runtime fallback: a value the compiler knows about must
 *  have its own case, or `origin` stops being `never` here and the build fails. A value only a
 *  newer server knows about still reaches this at runtime and renders as the generic label
 *  instead of a raw enum. */
function unlabelledOrigin(origin: never, L: Vocab): string {
  void origin;
  return L.chatSystemOriginGeneric;
}

/**
 * How a system-authored turn renders. Most are a one-line hint. A lead's message to its worker is
 * an instruction the worker acts on — the human's own words relayed — so it keeps the user bubble,
 * labelled with where it came from. A worker's report or request to its lead is the substance the
 * lead answers from, so its hint line expands to the full text.
 */
export type SystemTurnDisplay = 'hint' | 'expandable' | 'bubble';

export function systemOriginDisplay(origin: SystemTurnOrigin): SystemTurnDisplay {
  switch (origin) {
    case 'team-lead':
    case 'scheduled': return 'bubble';
    case 'worker-result':
    case 'worker-question': return 'expandable';
    default: return 'hint';
  }
}

/** Opens the trailing section of a worker's message that lists the lead's unread routine updates.
 *  The lead's chat already shows each of those as a row of its own. */
const UNREAD_ROUTINE_LINE = /^\[Unread routine updates\]$/;

/** The full text of a system-authored turn without its `<system-reminder>` envelope lines, and
 *  without a worker message's unread routine updates (from their heading line to the end). */
export function systemOriginBody(text: string): string {
  const lines = (text ?? '')
    .split('\n')
    .filter((l) => !SYSTEM_REMINDER_LINE.test(l.trim()));
  const routine = lines.findIndex((l) => UNREAD_ROUTINE_LINE.test(l.trim()));
  return (routine >= 0 ? lines.slice(0, routine) : lines).join('\n').trim();
}

/**
 * One line of the notice worth showing beside its label.
 *
 * These texts are wrapped in a `<system-reminder>` envelope the reader has no use for, so the
 * envelope lines are dropped and the first line of real prose is taken. Clipped rather than
 * wrapped: the row is a hint, and a hint that grows to six lines is just the bubble again.
 * Returns '' when there is nothing but the envelope — the label alone then carries the row.
 */
export function systemOriginSummary(text: string, max = 80): string {
  const line = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !SYSTEM_REMINDER_LINE.test(l));
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
