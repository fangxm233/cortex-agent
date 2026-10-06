import { fmt, type Vocab } from '@/i18n';
import { formatSpanOrDash, type TimeLang } from '@/i18n/time-format';
import { formatUsd } from '@/lib/format';
import { browserStartupHint, browserStartupPending } from '@/features/browser/browser-status';
import { deriveSessionRunStatus, type SessionRunStatus } from '@/features/session/list/session-run-status';
import { turnClockElapsedMs, type TurnClock } from '@/features/session/transcript/transcript-vm';

const DASH = '—';

export interface RunStatusFacts {
  status: SessionRunStatus;
  elapsed: string;
  /** Real agent-turn count; null renders as —. */
  turns: number | null;
  /** Last run's cost; only printed once the run is finalized. */
  cost: number | null;
  /** Armed waitpoints. Appended, never substituted: an idle session waiting for a machine is still
   *  idle, but it must not read as "nothing is happening". */
  waitingOn: number;
}

function runLabel(status: SessionRunStatus, L: Vocab): string {
  if (status.phase === 'background') return L.pillBackground;
  if (status.phase === 'foreground') return L.pillRunning;
  return L.wbIdle;
}

/** The run line both chat surfaces print: label · elapsed · turns · cost, then any waitpoints. */
export function runStatusText(facts: RunStatusFacts, L: Vocab): string {
  const label = runLabel(facts.status, L);
  const turns = facts.turns == null ? DASH : `${facts.turns} ${L.wbTurnsUnit}`;
  const cost = facts.cost == null ? DASH : formatUsd(facts.cost);
  const metrics = [label, facts.elapsed, turns, ...(facts.status.showCost ? [cost] : [])];
  const base = facts.status.showMetrics ? metrics.join(' · ') : label;
  return facts.waitingOn > 0 ? `${base} · ${fmt(L.chatWaitingOn, { n: facts.waitingOn })}` : base;
}

export interface RunStatusLineInput {
  isDraft: boolean;
  running: boolean;
  backgroundRunning: boolean;
  /** A locally queued message reads as running before the authoritative session event arrives. */
  starting: boolean;
  turns: number | null;
  cost: number | null;
  turnClock: TurnClock | null;
  waitingOn: number;
  /** The browser the session runs (or a draft will run) with. */
  browserDevice: string | null;
  /** True after this turn emits its first agent progress or streamed output. */
  turnProgressStarted: boolean;
}

export interface RunStatusLine {
  active: boolean;
  text: string;
  /** Present while the turn clock runs: the line re-renders itself from it every second, so the
   *  ticking stays inside that leaf instead of re-rendering the chat. */
  liveText?: (now: number) => string;
}

/** Browser start-up outranks the ordinary run line; the clock ticks only while the turn runs. */
export function runStatusLine(input: RunStatusLineInput, L: Vocab, lang: TimeLang): RunStatusLine {
  const status = deriveSessionRunStatus({
    running: input.running || input.starting,
    backgroundRunning: input.backgroundRunning,
    hasRun: !input.isDraft && input.turns != null,
  });
  const device = input.browserDevice;
  if (device && browserStartupPending({ ...input, running: status.active, device })) {
    return { active: status.active, text: browserStartupHint(device, L.wbBrowserStarting) };
  }
  const textAt = (now: number | null): string => runStatusText({
    status,
    elapsed: formatSpanOrDash(turnClockElapsedMs(input.turnClock, now), lang),
    turns: input.turns,
    cost: input.cost,
    waitingOn: input.waitingOn,
  }, L);
  const clockLive = input.running && status.showMetrics && input.turnClock != null;
  return { active: status.active, text: textAt(null), ...(clockLive ? { liveText: textAt } : {}) };
}
