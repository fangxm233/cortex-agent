// input:  result, continuation registrar, status/notice/resume publishers
// output: web background hold forwarding, held rate-limit cards, and resume callbacks
// pos:    Web session background-continuation hold
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Why this exists (the gap): the background-task continuation machinery (BgTaskTracker /
// buildContinuationSink / bg-wait-guard) was wired only for slack:/feishu: channels
// (isInteractiveChannel). A web: turn that ended with a live background task fell through both
// hold paths — no ContinuationSink was registered, so when the task later completed the adapter
// dropped its continuation turn, AND the agent-runner finally published running:false immediately,
// so the Web UI showed the session "done" and stopped tracking. This module closes that gap using
// the same channel-agnostic primitives, rendering the hold through web's event surface instead of a
// Slack status message.

import { createLogger } from '@core/log.js';
import type {
  AgentResult, ChatNoticeLevel, ContextUsage, NoticeAction,
} from '@core/types/agent-types.js';
import { isApiRateLimitError } from '@domain/agents/config.js';
import type { ContinuationSink } from '../agent-adapter/types.js';
import type { ToolUseSubagent } from '../agent-adapter/normalize/event-types.js';
import { t } from '../core/i18n.js';
import { startBgWaitGuard, type BgWaitGuard } from './bg-wait-guard.js';

const log = createLogger('web-bg-hold');

export interface WebBgHoldDeps {
  /** The turn's terminal result (carries pending/undelivered background-task counts). */
  result: AgentResult;
  /** Register the continuation sink on the live agent process (proc.setContinuationSink). */
  registerSink: (sink: ContinuationSink) => void;
  /** Publish a session.status delta. During the hold: running:true, backgroundRunning:true;
   *  on seal: running:false. */
  publishStatus: (p: { running: boolean; backgroundRunning: boolean }) => void;
  /** Append + publish a continuation assistant message (history record + session.message).
   *  `subagent` is set when a native subagent produced the text — without it the transcript
   *  cannot tell a subagent's working notes from the agent's own answer. */
  publishAssistant: (text: string, subagent?: ToolUseSubagent) => void;
  /** Append + publish a continuation tool call (history record + session.message). */
  publishTool: (name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void;
  /** Persist a complete normalized continuation tool result in DEBUG mode. */
  publishToolResult?: (toolUseId: string, content: string, isError: boolean) => void;
  /** Publish the authoritative end of one backgrounded subagent. Distinct from `publishStatus`,
   *  which seals the whole hold: several subagents can run under one hold and each ends alone. */
  publishSubagentEnd?: (parentToolUseId: string, status: 'completed' | 'failed' | 'killed') => void;
  /** Persist and publish an exact continuation context snapshot. */
  publishContextUsage?: (usage: ContextUsage) => void;
  /** Append + publish a continuation NOTICE row (level + optional action), the fields the plain
   *  assistant path drops. Without it a rate-limited continuation renders as a bare "API Error:"
   *  line with no resume affordance. */
  publishNotice?: (text: string, level: ChatNoticeLevel, action?: NoticeAction) => void;
  /** Register the interrupted turn for provider-reset auto-resume. Returns true when the turn was
   *  actually queued (the provider is throttled); false means the failure is terminal and its
   *  error card must be shown instead of the auto-resume notice. */
  onRateLimited: (result: AgentResult) => boolean;
  /** Busy bracket (trackPendingTask). +1 for the whole wait window so a deferred daemon restart
   *  does not fire and kill the Claude child (F1); -1 when the guard settles. */
  track: (delta: number) => void;
  /** Register the hold's abort handle (user Stop while the hold is up). Invoked once, right after
   *  the hold is installed, with a function that seals the hold: guard settled (busy bracket
   *  released) + running:false published. Idempotent with every other seal path. */
  registerAbort?: (abort: () => void) => void;
  /** Injectable guard factory for tests (defaults to the real startBgWaitGuard). */
  startGuard?: typeof startBgWaitGuard;
  /** Injectable timers forwarded to the guard (tests drive grace/max-wait deterministically). */
  guardTimers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
  graceMs?: number;
  maxWaitMs?: number;
}

/**
 * Hold a web session open for its spontaneous background-task continuation. The turn's foreground
 * work has ended, but background work (running or finished-but-unnotified) remains. Instead of
 * sealing running:false immediately, keep the session marked running+backgroundRunning, register a
 * ContinuationSink, and arm a bg-wait-guard. When the background task later re-invokes the model, its
 * output streams in as new session messages; when no work remains (or on grace / max-wait / interrupt)
 * we seal running:false.
 *
 * Returns true when the hold was installed — the caller MUST then skip its own running:false publish.
 * Returns false when there was nothing to hold (caller seals as usual). Assumes the gate
 * (shouldHoldWebForBg) already passed; the internal remaining-count check is a defensive re-guard.
 */
export function holdWebForBg(deps: WebBgHoldDeps): boolean {
  const running0 = deps.result.pendingBackgroundTasks ?? 0;
  const undelivered0 = deps.result.undeliveredBackgroundTasks ?? 0;
  if (running0 + undelivered0 <= 0) return false;

  const startGuard = deps.startGuard ?? startBgWaitGuard;
  let sealed = false;

  // Rate-limit API errors are HELD, not streamed. The backend surfaces a 429 as ordinary assistant
  // prose BEFORE the continuation settles, and only the result says whether it was a failure (show
  // the card) or a pause the resume registry already owns (show the auto-resume warning instead).
  // Same contract as AttemptNoticeTracker in domain/agents/facade.ts — which is bound to the
  // foreground turn and has therefore already retired by the time a continuation runs.
  let heldApiError: string | null = null;
  const flushHeldApiError = (): void => {
    const held = heldApiError;
    heldApiError = null;
    if (!held) return;
    if (deps.publishNotice) deps.publishNotice(held, 'error');
    else deps.publishAssistant(held);
  };

  const seal = (): void => {
    if (sealed) return;
    sealed = true;
    flushHeldApiError();
    guard.settle();
    deps.publishStatus({ running: false, backgroundRunning: false });
  };

  // Hold: keep the session running with the background flag so the Web UI shows "background
  // running" instead of idle, and does NOT stop tracking the session.
  deps.publishStatus({ running: true, backgroundRunning: true });

  const guard: BgWaitGuard = startGuard({
    running: running0,
    undelivered: undelivered0,
    track: deps.track,
    graceMs: deps.graceMs,
    maxWaitMs: deps.maxWaitMs,
    timers: deps.guardTimers,
    // F5: work finished but CC never delivered the notification (old-CLI same-turn completions /
    // killed tasks). The model already saw the outcome inside the turn — nothing more will stream,
    // so seal as a normal completion.
    onGraceTimeout: () => { log.info('web bg-hold grace timeout — sealing session idle'); seal(); },
    // F6: a legitimately never-ending task (tunnel / monitor) exceeded the max-wait cap. The guard
    // has already released the busy bracket; publish running:false so the session is not held
    // "running" forever, but KEEP the sink registered (do not set `sealed`) so a very late
    // continuation still streams as new messages and re-seals.
    onMaxWait: () => {
      if (sealed) return;
      log.info('web bg-hold max-wait cap — releasing (sink kept for a late continuation)');
      deps.publishStatus({ running: false, backgroundRunning: false });
    },
  });

  const sink: ContinuationSink = {
    // The wait is over once the continuation turn opens; its length is unbounded (a 93-minute
    // continuation was observed 2026-09-06), so the watchdogs must not fire mid-turn.
    onTurnOpen: () => guard.pause(),
    // A background subagent finishes AFTER the turn that spawned it has ended, so its output
    // arrives here rather than through the in-turn path. Dropping the attribution at this seam
    // published the subagent's final report as the agent's own prose, in the NEXT turn.
    onAssistantText: (text: string, _model, subagent) => {
      if (!text) return;
      // Only the agent's own stream is held: a subagent's card keeps its attribution and the
      // subagent, not the session, owns that failure.
      if (!subagent && text.startsWith('API Error:') && isApiRateLimitError(text)) {
        heldApiError = text;
        return;
      }
      deps.publishAssistant(text, subagent);
    },
    onToolUse: (name: string, input: any, toolUseId?: string, subagent?: ToolUseSubagent) =>
      deps.publishTool(name, input, toolUseId ?? '', subagent),
    onToolResult: (toolUseId: string, content: string, isError: boolean) => deps.publishToolResult?.(toolUseId, content, isError),
    // Not routed through publishAssistant/publishTool: this is a state correction for a subagent
    // block, carrying no prose that belongs in the transcript.
    onSubagentEnd: (parentToolUseId: string, status) => deps.publishSubagentEnd?.(parentToolUseId, status),
    onContextUsage: (usage: ContextUsage) => deps.publishContextUsage?.(usage),
    onResult: (cont: AgentResult) => {
      // Process death seals the hold; provider limits also preserve the interrupted turn for reset.
      if (cont.backgroundInterrupted) { seal(); return; }
      if (cont.rateLimited) {
        if (!sealed && deps.onRateLimited(cont)) {
          // Paused, not failed — the held card would misreport the outcome.
          heldApiError = null;
          deps.publishNotice?.(t('notify.rateLimitAutoResume'), 'warning', { kind: 'cancel-resume' });
        } else {
          flushHeldApiError();
        }
        seal();
        return;
      }
      const running = cont.pendingBackgroundTasks ?? 0;
      const undelivered = cont.undeliveredBackgroundTasks ?? 0;
      if (running + undelivered > 0) {
        // Chained background work: re-arm the guard and keep holding. Once the guard has settled
        // (sealed, or released at the max-wait cap) it cannot re-arm, so publishing running:true
        // here would leave the session "running" with nothing left to seal it (observed
        // 2026-09-06); the sink still streams and a final 0-remaining result re-seals.
        if (guard.settled) return;
        guard.rearm(running, undelivered);
        deps.publishStatus({ running: true, backgroundRunning: true });
      } else {
        seal();
      }
    },
  };

  deps.registerSink(sink);
  // Stop button: the foreground execution is already gone from runningExecutions by the time we
  // get here, so the channel-keyed cancel path has nothing to kill and used to no-op. Expose the
  // seal so it can end the hold explicitly (the cancel path also kills the backend process that
  // owns the background task; this makes the UI seal immediate and independent of that death
  // notification, which the adapter suppresses when no task is still pending).
  deps.registerAbort?.(() => {
    if (sealed) return;
    log.info('web bg-hold cancelled by user Stop — sealing session idle');
    seal();
  });
  return true;
}
