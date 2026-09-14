// input:  a run whose foreground turn ended while background work remains, plus ONE surface's
//         renderer (platform status message / web event stream)
// output: the whole hold lifecycle — busy bracket, `SessionHolds` registration, running:true/false,
//         the run subscription, and the six verdicts a background phase can reach
// pos:    orchestration/turn — the single owner of "the turn is over but the session is not".
//         This replaces three holds that had drifted apart (audit §4): `status-renderer.ts` held
//         Slack/Feishu without registering anything, so the hold was invisible to `sessionState`
//         and unreachable by Stop; `web-status-renderer.ts` held web and published its own
//         running:false; `subagent-delivery.ts` held for a delegated run. The verdict table
//         (grace / max-wait / interrupted / rate-limited / complete / chained) was written twice
//         and is written once here; the two renderers now only turn events into a surface.

import { createLogger } from '@core/log.js';
import type { AgentResult, ContextUsage } from '@core/types/agent-types.js';
import type { ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import type { AgentRun } from '@domain/runs/run.js';
import type { RunEvent } from '@domain/runs/events.js';
import type { RunObserver } from '@domain/runs/request.js';
import { recordDirectResume } from '@domain/runs/observers/resume-recorder.js';
import { runRegistry } from '@core/run-registry.js';
import { sessionHolds, type SessionHoldHandles } from '@core/session-holds.js';
import { isBgContinuationEnabled } from '../../agent-adapter/bg-wait.js';
import { trackPendingTask } from '../busy-tracker.js';
import { publishSessionStatus } from '../session-events.js';

const log = createLogger('background-hold');

/** Owner key of the Claude background-continuation hold. One per session: a session has at most
 *  one turn whose continuation is being awaited. */
export const HOLD_OWNER_BG_CONTINUATION = 'bg-continuation';

// ── the hold itself ───────────────────────────────────────────────────────────

export interface HoldSessionOptions {
  /** Stable Cortex tracking id. Null for a run with no session — the busy bracket is still taken. */
  sessionId: string | null;
  channel: string | null | undefined;
  /** `'bg-continuation'` | `agent-run:<id>`. Keyed per owner because one session can be held by
   *  more than one thing at a time, and each must end without erasing the others. */
  owner: string;
  /** Stop / supersede semantics, unchanged (`SessionHoldHandles`). A hold that owns STATUS points
   *  both verbs at its seal; a hold that owns live WORK sets `onStop` only. */
  handles: SessionHoldHandles & { onStop: () => void };
  /** Busy bracket. Injected so tests can watch it; production is `trackPendingTask`. */
  track?: (delta: number) => void;
  /** The execution this hold is the tail of. Excluded from the seal's "is anything ELSE still
   *  live" test: a run keeps its execution registered for the whole of its background phase, so
   *  the hold's own run would otherwise veto its own idle publish. */
  ownExecutionId?: string | null;
}

/**
 * A live hold on a session.
 *
 * `seal` is the whole contract for a caller that just wants the hold to end; the other three exist
 * because a background phase has more states than "held" and "over":
 * - `releaseWait` — the run is done waiting (phase done / either timeout) but the surface has not
 *   settled yet. Releases the busy bracket ONLY.
 * - `idle` — publish running:false without ending the hold (the max-wait cap: a never-ending task
 *   must not hold the session "running" forever, but a very late continuation still merges).
 * - `reassert` — re-publish the held state and re-register the handles. Chained background work
 *   uses it, and so does a work-owning hold whose session was sealed by someone else's turn.
 */
export interface SessionHold {
  /** True once the hold has been sealed. (`released` in the plan's sketch.) */
  readonly released: boolean;
  seal(): void;
  idle(): void;
  reassert(): void;
  releaseWait(): void;
}

/**
 * Take a hold on a session: busy bracket +1, the status (`running:true, backgroundRunning:true`)
 * and the Stop/supersede handles, all of them released exactly once by `seal()`.
 *
 * The seal publishes running:false only when nothing ELSE is live on the session — another
 * execution or another owner's hold. That rule is `subagent-delivery`'s (it was the only hold that
 * had it) applied to all three: the common case is a background run that outlived nothing at all,
 * with the parent's turn still in flight.
 */
export function holdSession(opts: HoldSessionOptions): SessionHold {
  const track = opts.track ?? trackPendingTask;
  const { sessionId, channel, owner } = opts;
  // Today's rule, kept: a hold with no session (or no channel to publish on) is bracket-only.
  const publishes = !!sessionId && !!channel;
  let sealed = false;
  let waitReleased = false;

  track(+1);

  const releaseWait = (): void => {
    if (waitReleased) return;
    waitReleased = true;
    track(-1);
  };

  const assertHeld = (): void => {
    if (!publishes) return;
    publishSessionStatus({ sessionId: sessionId!, channel: channel!, running: true, backgroundRunning: true });
    sessionHolds.setHoldHandles(sessionId!, owner, opts.handles);
  };

  const publishIdle = (): void => {
    if (!publishes) return;
    if (otherWorkLive(sessionId!, opts.ownExecutionId ?? null, owner)) return;
    publishSessionStatus({ sessionId: sessionId!, channel: channel!, running: false, backgroundRunning: false });
  };

  assertHeld();

  return {
    get released(): boolean { return sealed; },
    seal(): void {
      if (sealed) return;
      sealed = true;
      releaseWait();
      if (sessionId) sessionHolds.dropHoldHandles(sessionId, owner);
      publishIdle();
    },
    idle(): void {
      if (sealed) return;
      publishIdle();
    },
    reassert(): void {
      // Once the wait is over the hold cannot come back: publishing running:true here would leave
      // the session "running" with nothing left to seal it (observed 2026-09-06).
      if (sealed || waitReleased) return;
      assertHeld();
    },
    releaseWait,
  };
}

/** Anything OTHER than this hold still keeping the session busy: another live execution, or
 *  another owner's hold. Both exclusions matter — a run keeps its execution registered for the
 *  whole of its background phase, and a hold that publishes idle at its max-wait cap has not
 *  dropped its own handles yet. */
function otherWorkLive(sessionId: string, ownExecutionId: string | null, owner: string): boolean {
  for (const exec of runRegistry.getAll()) {
    if (exec.trackSessionId !== sessionId && exec.backendSessionId !== sessionId) continue;
    if (ownExecutionId && exec.executionId === ownExecutionId) continue;
    return true;
  }
  return sessionHolds.hasHoldHandles(sessionId, owner);
}

// ── the surfaces a hold renders through ───────────────────────────────────────

/** The part of a run a hold touches: subscribe to its events, and claim the background transcript
 *  so no second observer writes the same rows (see `AgentRun.backgroundTranscriptOwned`). */
export type HeldRun = Pick<AgentRun, 'subscribe' | 'claimBackgroundTranscript'>;

/**
 * How a background phase can end — decided ONCE, here, for both surfaces.
 *
 * - `complete` — a continuation settled with no work left (`background_result`, remaining 0).
 * - `chained` — a continuation settled but more work is queued (`background_result`, remaining > 0).
 *   The only non-terminal verdict: it re-renders the waiting state and re-asserts the hold, so it
 *   is delivered as `onWaiting`, never as `onSealed`.
 * - `grace` — `background_timeout` reason `grace`: finished-but-unnotified work never produced its
 *   notification. The model already saw the outcome inside the turn, so this reads as a completion.
 * - `max-wait` — `background_timeout` reason `max-wait`: still-running work passed the cap. The
 *   bracket is released and the session goes idle, but the subscription is KEPT.
 * - `interrupted` — `background_result` with `backgroundInterrupted` (the backend died), or the
 *   user pressing Stop / a new turn superseding the hold.
 * - `rate-limited` — `background_result` with `rateLimited`. The turn is registered for
 *   provider-reset auto-resume before the surface renders it.
 */
export type HoldVerdict = 'complete' | 'chained' | 'grace' | 'max-wait' | 'interrupted' | 'rate-limited';

/** Every verdict except the one that does not seal. */
export type SealedVerdict = Exclude<HoldVerdict, 'chained'>;

/** The merged tally a terminal verdict is rendered with: the foreground turn plus its continuation. */
export interface HoldTotals {
  /** base + continuation cost; `0` when neither reported one. */
  costUsd: number | null;
  numTurns: number | null;
  /** The continuation result that produced the verdict; null for grace / max-wait / Stop. */
  continuation: AgentResult | null;
  /** `rate-limited` only: true when the turn was actually queued for auto-resume (false means the
   *  failure is terminal and its error card must be shown instead of the resume notice). */
  resumable: boolean;
}

/**
 * One surface's rendering of a held turn. Everything below is "event → surface"; no member decides
 * anything about the hold's lifetime, and none of them publishes session status (the hold does).
 */
export interface HoldRenderer {
  /** Background work outstanding: at install, and again on every chained continuation. Awaited at
   *  install only, so the first waiting line is on screen before the hold is reported as taken. */
  onWaiting(remaining: number): void | Promise<void>;
  onText(text: string, subagent?: ToolUseSubagent): void;
  onTool(name: string, input: unknown, toolUseId: string, subagent?: ToolUseSubagent): void;
  onToolResult(toolUseId: string, content: string, isError: boolean): void;
  onContext(usage: ContextUsage): void;
  /** The authoritative end of one backgrounded subagent (web only — a status message has no row
   *  to correct). */
  onSubagentEnd?(parentToolUseId: string, status: 'completed' | 'failed' | 'killed'): void;
  onSealed(kind: SealedVerdict, totals: HoldTotals): void;
}

// ── the Claude background-continuation hold ───────────────────────────────────

export interface BackgroundContinuationOptions {
  /** The settled run. Its background phase drives everything below. */
  run: HeldRun;
  /** The foreground result: its remaining-task counts open the hold, its totals are the base. */
  result: AgentResult;
  channel: string;
  /** Stable Cortex tracking id — the hold's key in `SessionHolds` and the resume record's. */
  sessionId: string | null;
  /** RAW user text: what an auto-resume replays, never the assembled prompt. */
  userMessage: string;
  /** The turn's execution, excluded from the seal's "anything else still live" test. */
  executionId?: string | null;
  renderer: HoldRenderer;
  track?: (delta: number) => void;
}

/**
 * Hold a session open for its background-task continuation.
 *
 * The turn's foreground work has ended but background work remains — either still running
 * (`pendingBackgroundTasks`) or finished-but-unnotified (`undeliveredBackgroundTasks`; the backend
 * may deliver that notification seconds later, or never — 2026-07-10 investigation). Instead of
 * sealing, render the waiting state and let the run drive: its continuation streams through the
 * renderer, and its result — or its grace / max-wait verdict — seals.
 *
 * Returns the hold, or null when there was nothing to hold (the caller's gate already decided;
 * the remaining-count test here is a defensive re-guard).
 */
export async function holdBackgroundContinuation(
  opts: BackgroundContinuationOptions,
): Promise<SessionHold | null> {
  const { run, result: base, channel, renderer } = opts;
  const remaining0 = remainingBg(base);
  if (remaining0 <= 0) return null;

  // Exactly one terminal verdict may win. `max-wait` deliberately does NOT claim it: the run stays
  // in its background phase, so a very late continuation still merges and re-seals.
  let finalized = false;
  let hold: SessionHold | null = null;

  const settle = (kind: SealedVerdict, cont: AgentResult | null): void => {
    if (finalized) return;
    if (kind !== 'max-wait') finalized = true;
    let resumable = false;
    if (kind === 'rate-limited') {
      // Record for auto-resume when the rate-limit window resets. Both surfaces did this; the web
      // one also needs the answer, to tell a pause from a terminal failure.
      const provider = cont?.rateLimitProvider ?? base?.rateLimitProvider ?? null;
      resumable = recordDirectResume({
        provider, channel, trackSessionId: opts.sessionId, userMessage: opts.userMessage,
      });
    }
    try {
      renderer.onSealed(kind, {
        costUsd: (base?.total_cost_usd ?? 0) + (cont?.total_cost_usd ?? 0),
        numTurns: (base?.num_turns ?? 0) + (cont?.num_turns ?? 0),
        continuation: cont, resumable,
      });
    } catch (e) {
      log.error(`hold renderer (${kind}) failed:`, (e as Error)?.message ?? e);
    }
    if (kind === 'max-wait') hold?.idle();
    else hold?.seal();
  };

  hold = holdSession({
    sessionId: opts.sessionId, channel, owner: HOLD_OWNER_BG_CONTINUATION,
    // This hold owns STATUS, not work — there is no child process to outlive it — so the same seal
    // is the right answer to a user Stop AND to a new foreground turn taking the session over.
    // Holds that own live work answer those two differently (see `SessionHoldHandles`).
    handles: {
      onStop: () => settle('interrupted', null),
      onSuperseded: () => settle('interrupted', null),
    },
    track: opts.track, ownExecutionId: opts.executionId ?? null,
  });

  await renderer.onWaiting(remaining0);

  // This surface both streams and persists the background turn, so it owns those rows; any other
  // observer watching the same run (today: the mid-turn injection ledger) must not write them again.
  run.claimBackgroundTranscript();
  run.subscribe(backgroundHoldObserver({ renderer, hold, settle }));
  return hold;
}

interface ObserverWiring {
  renderer: HoldRenderer;
  hold: SessionHold;
  settle: (kind: SealedVerdict, cont: AgentResult | null) => void;
}

/** Pure dispatch: background-phase events → verdicts and renderer calls. Exported for tests. */
export function backgroundHoldObserver(w: ObserverWiring): RunObserver {
  const { renderer, hold } = w;
  return {
    onEvent(event: RunEvent): void {
      switch (event.type) {
        case 'assistant_text':
          if (event.phase !== 'background') return;
          renderer.onText(event.text, event.subagent);
          return;
        case 'tool_use':
          if (event.phase !== 'background') return;
          renderer.onTool(event.name, event.input, event.toolUseId ?? '', event.subagent);
          return;
        case 'tool_result':
          if (event.phase !== 'background') return;
          renderer.onToolResult(event.toolUseId, event.content, !event.ok);
          return;
        case 'subagent_end':
          if (event.phase !== 'background') return;
          renderer.onSubagentEnd?.(event.parentToolUseId, event.status);
          return;
        case 'context_usage':
          if (event.phase !== 'background') return;
          renderer.onContext(event);
          return;
        case 'background_result': {
          const cont = event.result;
          if (cont.backgroundInterrupted) { w.settle('interrupted', cont); return; }
          if (cont.rateLimited) { w.settle('rate-limited', cont); return; }
          const left = remainingBg(cont);
          if (left > 0) {
            // Chained: the run re-arms its own bound, so keep rendering the waiting state and keep
            // the hold. `reassert` is a no-op once the wait is over.
            void renderer.onWaiting(left);
            hold.reassert();
          } else {
            w.settle('complete', cont);
          }
          return;
        }
        case 'background_timeout':
          // Release the bracket first, then report the verdict — the order the guard this replaced
          // used, and the one that keeps a deferred restart from firing inside the seal.
          hold.releaseWait();
          w.settle(event.reason === 'grace' ? 'grace' : 'max-wait', null);
          return;
        case 'phase':
          if (event.phase === 'done') hold.releaseWait();
          return;
        default:
          return;
      }
    },
  };
}

function remainingBg(result: { pendingBackgroundTasks?: number | null; undeliveredBackgroundTasks?: number | null } | null | undefined): number {
  if (!result) return 0;
  return (result.pendingBackgroundTasks ?? 0) + (result.undeliveredBackgroundTasks ?? 0);
}

// ── the gate ──────────────────────────────────────────────────────────────────

/** Which surface would hold this turn, if any. */
export type HoldKind = 'platform' | 'web';

/**
 * The single gate for the background-task hold decision: feature enabled + sink capability + a
 * channel that has a surface to hold + not rate-limited + work remaining (running or undelivered —
 * the latter is bounded by the grace watchdog upstream).
 *
 * One function instead of the two that differed only in their channel-prefix test; the channel now
 * picks the RENDERER rather than a second copy of the rule.
 */
export function shouldHoldForBg(
  result: { pendingBackgroundTasks?: number; undeliveredBackgroundTasks?: number; rateLimited?: boolean } | null | undefined,
  channel: string,
  canRegisterSink: boolean,
): HoldKind | null {
  if (!isBgContinuationEnabled() || !canRegisterSink) return null;
  const kind: HoldKind | null = isInteractiveChannel(channel) ? 'platform'
    : isWebChannel(channel) ? 'web' : null;
  if (!kind) return null;
  if (!result || result.rateLimited) return null;
  return remainingBg(result) > 0 ? kind : null;
}

/** Feature gate (shared with the thread inline wait): re-exported from agent-adapter/bg-wait,
 *  the single source of truth for CORTEX_BG_CONTINUATION. */
export { isBgContinuationEnabled };

/** Scope gate: only interactive user conduits (Slack / Feishu), never thread/dispatch. */
export function isInteractiveChannel(channel: string): boolean {
  return !!channel && (channel.startsWith('slack:') || channel.startsWith('feishu:'));
}

/** Scope gate for the Web UI: the `web:` conduit. Kept SEPARATE from isInteractiveChannel because
 *  the two surfaces render a held turn differently — Slack/Feishu edit a status message
 *  (`hold-render-platform.ts`), web streams session events (`hold-render-web.ts`). */
export function isWebChannel(channel: string): boolean {
  return !!channel && channel.startsWith('web:');
}
