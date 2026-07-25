// input:  terminal AgentResult + injected publishers / sink registrar / busy bracket (+ guard factory)
// output: holdWebForBg — hold a web session open for its spontaneous background-task continuation
// pos:    orch/ — the WEB analogue of lifecycle.ts's Slack status-message bg-hold. Slack holds by
//         editing a status message; web holds by keeping the session.status event stream live
//         (running:true, backgroundRunning:true) and streaming the continuation as session.message
//         events, then sealing running:false when the background work finishes.
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
import type { AgentResult } from '@core/types/agent-types.js';
import type { ContinuationSink } from '../agent-adapter/types.js';
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
  /** Append + publish a continuation assistant message (history record + session.message). */
  publishAssistant: (text: string) => void;
  /** Append + publish a continuation tool call (history record + session.message). */
  publishTool: (name: string, input: any) => void;
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

  const seal = (): void => {
    if (sealed) return;
    sealed = true;
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
    onAssistantText: (text: string) => { if (text) deps.publishAssistant(text); },
    onToolUse: (name: string, input: any) => deps.publishTool(name, input),
    onResult: (cont: AgentResult) => {
      // Process died mid-wait, or rate-limited: seal honestly (never leave the session "running").
      if (cont.backgroundInterrupted || cont.rateLimited) { seal(); return; }
      const running = cont.pendingBackgroundTasks ?? 0;
      const undelivered = cont.undeliveredBackgroundTasks ?? 0;
      if (running + undelivered > 0) {
        // Chained background work: re-arm the guard and keep holding.
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
