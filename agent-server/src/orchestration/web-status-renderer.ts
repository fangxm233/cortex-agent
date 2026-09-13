// input:  a held turn's run + the web session's history/publish callbacks
// output: a RunObserver that keeps the Web session live through its background phase
// pos:    orchestration — the web `session.status` surface for a run's background phase
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// Why this exists (the gap it closed): the background-task continuation machinery was wired only
// for slack:/feishu: channels. A web: turn that ended with a live background task fell through both
// hold paths — nothing subscribed to the continuation, so when the task later completed its output
// was dropped, AND the agent-runner published running:false immediately, so the Web UI showed the
// session "done" and stopped tracking it.
//
// Why it is a RunObserver: this is the same surface as `status-renderer.ts`, rendered through
// web's event stream instead of a Slack status message. Both used to reach the run through a
// `BackgroundTurnSink` bridge; both now just subscribe.

import { createLogger } from '@core/log.js';
import type {
  AgentResult, ChatNoticeLevel, ContextUsage, NoticeAction,
} from '@core/types/agent-types.js';
import { isApiRateLimitError } from '@domain/agents/config.js';
import type { ToolUseSubagent } from '../agent-adapter/normalize/event-types.js';
import type { RunEvent } from '@domain/runs/events.js';
import type { RunObserver } from '@domain/runs/request.js';
import { t } from '../core/i18n.js';
import type { HeldRun } from './status-renderer.js';

const log = createLogger('web-status-renderer');

export interface WebBackgroundStatusDeps {
  /** The turn's terminal result (carries pending/undelivered background-task counts). */
  result: AgentResult;
  /** The run to subscribe to. Its background phase drives everything below. */
  run: HeldRun;
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
   *  does not fire and kill the Claude child (F1); -1 once the run reports the wait is over. */
  track: (delta: number) => void;
  /** Register the hold's seal so something outside can end it. Invoked once, right after the hold
   *  is installed, with a function that seals: busy bracket released + running:false
   *  published. Idempotent with every other seal path.
   *
   *  This hold owns STATUS, not work — there is no child process to outlive it — so the same seal is
   *  the right answer to a user Stop AND to a new foreground turn taking the session over. Holds
   *  that own live work answer those two differently (see `SessionHoldHandles`). */
  registerAbort?: (abort: () => void) => void;
}

/**
 * Hold a web session open for its spontaneous background-task continuation. The turn's foreground
 * work has ended, but background work (running or finished-but-unnotified) remains. Instead of
 * sealing running:false immediately, keep the session marked running+backgroundRunning, subscribe
 * to the run, and let the run bound the wait. When the background task later re-invokes the model,
 * its output streams in as new session messages; when no work remains (or on grace / max-wait /
 * interrupt) we seal running:false.
 *
 * Returns true when the hold was installed — the caller MUST then skip its own running:false publish.
 * Returns false when there was nothing to hold (caller seals as usual). Assumes the gate
 * (shouldHoldWebForBg) already passed; the internal remaining-count check is a defensive re-guard.
 */
export function holdWebSessionForBackground(deps: WebBackgroundStatusDeps): boolean {
  const running0 = deps.result.pendingBackgroundTasks ?? 0;
  const undelivered0 = deps.result.undeliveredBackgroundTasks ?? 0;
  if (running0 + undelivered0 <= 0) return false;

  let sealed = false;
  // Busy bracket for the whole waiting window (F1): +1 now, -1 exactly once when the run reports
  // the wait is over. The run owns the grace / max-wait timers.
  deps.track(+1);
  let waitReleased = false;
  const releaseWait = (): void => {
    if (waitReleased) return;
    waitReleased = true;
    deps.track(-1);
  };

  // Rate-limit API errors are HELD, not streamed. The backend surfaces a 429 as ordinary assistant
  // prose BEFORE the continuation settles, and only the result says whether it was a failure (show
  // the card) or a pause the resume registry already owns (show the auto-resume warning instead).
  // Same contract as AttemptNoticeTracker in domain/runs/notices.ts — which is bound to the
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
    releaseWait();
    deps.publishStatus({ running: false, backgroundRunning: false });
  };

  // Hold: keep the session running with the background flag so the Web UI shows "background
  // running" instead of idle, and does NOT stop tracking the session.
  deps.publishStatus({ running: true, backgroundRunning: true });

  // F5: work finished but CC never delivered the notification (old-CLI same-turn completions /
  // killed tasks). The model already saw the outcome inside the turn — nothing more will stream,
  // so seal as a normal completion.
  const onGraceTimeout = (): void => {
    log.info('web bg-hold grace timeout — sealing session idle');
    seal();
  };

  // F6: a legitimately never-ending task (tunnel / monitor) exceeded the max-wait cap. The bracket
  // is already released; publish running:false so the session is not held "running" forever, but
  // KEEP the subscription (do not set `sealed`) so a very late continuation still streams as new
  // messages and re-seals.
  const onMaxWait = (): void => {
    if (sealed) return;
    log.info('web bg-hold max-wait cap — releasing (subscription kept for a late continuation)');
    deps.publishStatus({ running: false, backgroundRunning: false });
  };

  const onAssistantText = (text: string, subagent?: ToolUseSubagent): void => {
    if (!text) return;
    // Only the agent's own stream is held: a subagent's card keeps its attribution and the
    // subagent, not the session, owns that failure.
    if (!subagent && text.startsWith('API Error:') && isApiRateLimitError(text)) {
      heldApiError = text;
      return;
    }
    deps.publishAssistant(text, subagent);
  };

  const onResult = (cont: AgentResult): void => {
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
    const remainingRunning = cont.pendingBackgroundTasks ?? 0;
    const remainingUndelivered = cont.undeliveredBackgroundTasks ?? 0;
    if (remainingRunning + remainingUndelivered > 0) {
      // Chained background work: keep holding — the run re-arms its own bound. Once the wait ended
      // (sealed, or released at the max-wait cap) it cannot come back, so publishing running:true
      // here would leave the session "running" with nothing left to seal it (observed
      // 2026-09-06); the subscription still streams and a final 0-remaining result re-seals.
      if (waitReleased) return;
      deps.publishStatus({ running: true, backgroundRunning: true });
    } else {
      seal();
    }
  };

  // This surface persists the background turn's rows, so it owns them; any other observer watching
  // the same run (today: the mid-turn injection ledger) must not write them a second time.
  deps.run.claimBackgroundTranscript();
  deps.run.subscribe(webBackgroundObserver({
    deps, onAssistantText, onResult, onGraceTimeout, onMaxWait, releaseWait,
  }));

  // Stop button: the foreground execution is already gone from the live-run registry by the time we
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

interface WebObserverWiring {
  deps: WebBackgroundStatusDeps;
  onAssistantText: (text: string, subagent?: ToolUseSubagent) => void;
  onResult: (result: AgentResult) => void;
  onGraceTimeout: () => void;
  onMaxWait: () => void;
  releaseWait: () => void;
}

/** Pure dispatch: background-phase events → the web session surface. Exported for tests. */
export function webBackgroundObserver(w: WebObserverWiring): RunObserver {
  const { deps } = w;
  return {
    onEvent(event: RunEvent): void {
      switch (event.type) {
        case 'assistant_text':
          if (event.phase !== 'background') return;
          // A background subagent finishes AFTER the turn that spawned it has ended, so its output
          // arrives here rather than through the in-turn path. Dropping the attribution at this
          // seam published the subagent's final report as the agent's own prose, in the NEXT turn.
          w.onAssistantText(event.text, event.subagent);
          return;
        case 'tool_use':
          if (event.phase !== 'background') return;
          deps.publishTool(event.name, event.input, event.toolUseId ?? '', event.subagent);
          return;
        case 'tool_result':
          if (event.phase !== 'background') return;
          deps.publishToolResult?.(event.toolUseId, event.content, !event.ok);
          return;
        case 'subagent_end':
          if (event.phase !== 'background') return;
          // Not routed through publishAssistant/publishTool: this is a state correction for a
          // subagent block, carrying no prose that belongs in the transcript.
          deps.publishSubagentEnd?.(event.parentToolUseId, event.status);
          return;
        case 'context_usage':
          if (event.phase !== 'background') return;
          deps.publishContextUsage?.(event);
          return;
        case 'background_result':
          w.onResult(event.result);
          return;
        case 'background_timeout':
          // Release the bracket first, then report the verdict.
          w.releaseWait();
          if (event.reason === 'grace') w.onGraceTimeout();
          else w.onMaxWait();
          return;
        case 'phase':
          if (event.phase === 'done') w.releaseWait();
          return;
        default:
          return;
      }
    },
  };
}
