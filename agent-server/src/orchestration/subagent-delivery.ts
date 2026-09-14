// input:  a backgrounded `agent` run, its owning session, and its terminal result
// output: the session hold that keeps it alive and the turn that delivers its answer
// pos:    Background half of the `agent` tool
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createLogger } from '@core/log.js';
import type { SystemTurnOrigin } from '@core/types/agent-types.js';
import { runRegistry } from '@core/run-registry.js';
import { ctx as jobCtx } from '@domain/scheduling/job-registry.js';
import type { SubagentToolResult } from '@core/agents/subagent/orchestrate.js';
import {
  stopSubagentRun, type StartSubagentRunOptions, type SubagentRunView,
} from '@domain/agents/subagent/registry.js';
import { trackPendingTask } from './busy-tracker.js';
import { publishSessionStatus } from './session-events.js';

const log = createLogger('subagent-delivery');

/**
 * Delivers a finished background run to its session as an ordinary user turn.
 *
 * Bound at the composition root, because the turn seam needs a PlatformAdapter and this module is
 * reached from a webhook that has none. Unset — in a test, or before the daemon finishes wiring —
 * the result is logged and dropped rather than queued: a turn that arrives hours later out of
 * context is worse than none.
 */
export type SubagentTurnSender = (
  opts: { channel: string; text: string; systemOrigin: SystemTurnOrigin },
) => void;

let sendTurn: SubagentTurnSender | null = null;

export function setSubagentTurnSender(sender: SubagentTurnSender | null): void {
  sendTurn = sender;
}

/**
 * Keep a session alive for the length of a background run.
 *
 * Three obligations, all of them existing invariants rather than new ones:
 *
 * - **The busy bracket** (`trackPendingTask`). Without it a deferred daemon restart fires while a
 *   child is mid-work and kills it. This one matters even when there is no session to report to,
 *   so it is taken unconditionally.
 * - **The status hold** (`running: true, backgroundRunning: true`). Marks the session busy-in-the-
 *   background rather than idle. The foreground turn publishes `running:false` when it ends, which
 *   would clear the hold, so the hold re-asserts itself whenever it sees that happen while the run
 *   is still going.
 * - **The Stop handle.** Once the foreground execution is torn down the channel-keyed Stop path
 *   can only reach a session through `runRegistry`; without it the Stop button silently does
 *   nothing while children keep spending tokens. Registered as `onStop` ONLY: a new foreground turn
 *   supersedes the hold, and superseding must not kill a child that is still working.
 *
 * Returns the release, which is idempotent and must be called exactly once when the run settles.
 */
export function holdSessionForBackgroundRun(
  view: SubagentRunView, channel: string | undefined,
): () => void {
  const { sessionId } = view;
  // Owner key: this run, not this session. Several runs (and the web continuation hold) can hold
  // one session at the same time, and each must be able to end without erasing the others.
  const holdOwner = `agent-run:${view.id}`;
  let released = false;
  trackPendingTask(+1);

  const assert = (): void => {
    if (!sessionId || !channel) return;
    publishSessionStatus({ sessionId, channel, running: true, backgroundRunning: true });
    runRegistry.setHoldHandles(sessionId, holdOwner, { onStop: () => { stopSubagentRun(view.id); } });
  };

  // Re-assert the STATUS on the foreground turn's own `running:false`, which is published while
  // this run is still going and would otherwise leave the session looking idle. The Stop handle
  // outlives the status on its own (it owns work, not status) — re-registering it is a no-op for
  // the same owner. Ignores our own release (already flagged).
  const subscription = sessionId && channel
    ? jobCtx.bus?.subscribe('session.status', (event) => {
      const status = event as { sessionId?: string; running?: boolean };
      if (released || status.sessionId !== sessionId || status.running !== false) return;
      assert();
    })
    : undefined;

  assert();

  return (): void => {
    if (released) return;
    released = true;
    subscription?.unsubscribe();
    if (sessionId) runRegistry.dropHoldHandles(sessionId, holdOwner);
    trackPendingTask(-1);
    // Only seal the session idle if nothing else is running on it — the common case is a
    // background run that outlived nothing at all, with the parent's turn still in flight.
    if (sessionId && channel && !runRegistry.getBySessionId(sessionId)) {
      publishSessionStatus({ sessionId, channel, running: false, backgroundRunning: false });
    }
  };
}

/**
 * Register a background run, hold its session for the length of it, and deliver its answer when it
 * ends. The one entry both delegation surfaces use: the `agent` MCP tool (via the webhook) and
 * PI's own in-process `agent`.
 *
 * `start` is a callback rather than a parameter bag because the two callers build their run
 * differently — one from raw tool params, one from an invocation it has already resolved — and the
 * only thing this needs from either is the settle hook it must wrap.
 */
export function startBackgroundSubagentRun(
  start: (onSettled: NonNullable<StartSubagentRunOptions['onSettled']>) => SubagentRunView,
  channel: string | undefined,
): SubagentRunView {
  // The hold can only be installed once the run has an id, but a run can settle before that line
  // is reached (an invalid model, say). The flag closes that window: whichever of the two happens
  // second performs the release, so the hold is never left standing.
  let release: (() => void) | null = null;
  let settledFirst = false;
  const view = start((settled, result) => {
    if (release) release();
    else settledFirst = true;
    deliverBackgroundSubagentResult(settled, result, channel);
  });
  const hold = holdSessionForBackgroundRun(view, channel);
  if (settledFirst) hold();
  else release = hold;
  return view;
}

function resultText(result: SubagentToolResult | null): string {
  return result?.content?.map(block => block.text).join('\n').trim() || '(no output)';
}

/** What the parent is told when a run it backgrounded ends. Phrased as a report rather than an
 *  instruction: the model decides what the answer is worth, the same as any other tool output. */
function deliveryText(view: SubagentRunView, result: SubagentToolResult | null): string {
  const what = view.descriptions.join('; ') || 'delegated work';
  const head = `[Background agent ${view.id} — ${what}]`;
  if (view.status === 'completed') return `${head}\n\n${resultText(result)}`;
  if (view.status === 'stopped') return `${head}\n\nStopped before it finished. No result.`;
  return `${head}\n\nFailed: ${view.error ?? 'unknown error'}`;
}

/**
 * Hand a finished background run back to the session that started it.
 *
 * Delivery is one `route()` call, not two code paths: that seam already folds a message into a
 * live turn when one is running and opens a fresh one when the session is idle — the same
 * behaviour a typed message gets, and the same seam a non-blocking `cortex_ask_user` answer uses.
 */
export function deliverBackgroundSubagentResult(
  view: SubagentRunView, result: SubagentToolResult | null, channel: string | undefined,
): void {
  if (!channel || !sendTurn) {
    log.warn(`Background agent ${view.id} finished with nowhere to deliver (channel=${channel ?? 'none'})`);
    return;
  }
  try {
    sendTurn({ channel, text: deliveryText(view, result), systemOrigin: 'agent-result' });
  } catch (error) {
    log.error(`Background agent ${view.id} delivery failed: ${(error as Error).message}`);
  }
}
