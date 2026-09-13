// input:  a held turn's run + its Slack/Feishu status message, stream and transcript callbacks
// output: a RunObserver that renders the turn's outcome line and finalizes the held turn
// pos:    orchestration — the Slack/Feishu status surface for a run's background phase
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
//
// Why this is a RunObserver: the background hold used to be assembled inline in
// `lifecycle.handleAgentSuccess` out of three parts — a `ContinuationSink` built by
// `bg-continuation.ts`, a `bg-wait-guard` owning the grace/max-wait timers, and a pile of closures
// deciding when the status was allowed to seal. The run owns the timers now and emits the
// whole background phase as events, so the surface is exactly what it should have been: one
// subscriber that turns run events into one status line. `lifecycle.ts` keeps the decision (hold or
// seal) and nothing else.

import { createLogger } from '@core/log.js';
import type { AgentResult } from '@core/types/agent-types.js';
import type { ContextUsage } from '@core/types/agent-types.js';
import type { OutputStream, PlatformAdapter, MessageRef } from '@platform/index.js';
import type { AgentRun } from '@domain/runs/run.js';
import type { RunEvent } from '@domain/runs/events.js';
import type { RunObserver } from '@domain/runs/request.js';
import { resolveRunConfig } from '@domain/runs/config-resolver.js';
import { recordDirectResume } from '@domain/runs/observers/resume-recorder.js';
import { recordCost } from '@domain/costs/cost-tracker.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { trackPendingTask } from './busy-tracker.js';
import { clearStreamingCallback } from './routing/hook-bridge.js';
import { maybeNotifyTurnComplete } from './turn-notify.js';
import {
  renderTurnStatus, computeElapsed, formatMetricsSuffix,
  writeStatus, sealStatus, buildSealedStatusActionBlocks,
} from './status-helpers.js';

const log = createLogger('status-renderer');

/** The part of a run this surface touches: subscribe to its events, and claim the background
 *  transcript so no second observer writes the same rows (see `AgentRun.backgroundTranscriptOwned`). */
export type HeldRun = Pick<AgentRun, 'subscribe' | 'claimBackgroundTranscript'>;

export interface BackgroundStatusDeps {
  run: HeldRun;
  adapter: PlatformAdapter;
  statusMsg: MessageRef;
  channel: string;
  /** The originating turn's reply stream — continuation prose is appended here so the follow-up
   *  merges into the same message and the turn still reads as one answer. */
  stream: OutputStream;
  sessionName: string | null;
  /** Backend session id, for the status line's session tag. */
  sessionId: string | null;
  /** Stable Cortex tracking id, for cost attribution and auto-resume. */
  trackSessionId: string | null;
  startTime: number;
  /** The foreground result whose totals the final line adds to. */
  baseResult: AgentResult;
  /** RAW user text — what an auto-resume would replay, never the assembled prompt. */
  userMessage: string;
  userMessageTs: string | null;
  executionId: string | null;
  trigger: string;
  projectId: string;
  backend: string;
  onToolUse?: ((name: string, input: any, toolUseId: string) => void) | null;
  onToolResult?: ((toolUseId: string, content: string, isError: boolean) => void) | null;
  onContextUsage?: ((usage: ContextUsage) => void) | null;
  /** Busy bracket (F1). Injected so tests can watch it; production is `trackPendingTask`. */
  track?: (delta: number) => void;
}

/**
 * Hold the turn's status message open for its background phase and subscribe the renderer.
 *
 * The turn's foreground work has ended but background work remains — either still running
 * (`pendingBackgroundTasks`) or finished-but-unnotified (`undeliveredBackgroundTasks`; the backend
 * may deliver that notification seconds later, or never — 2026-07-10 investigation). Instead of
 * sealing, write the waiting line and let the run drive: its continuation streams into the same
 * reply, and its result — or its grace / max-wait verdict — seals.
 *
 * The caller has already decided the hold applies (`shouldHoldForBg` + a stream to merge into +
 * no pending questions).
 */
export async function holdBackgroundStatus(deps: BackgroundStatusDeps): Promise<void> {
  const track = deps.track ?? trackPendingTask;
  const { adapter, statusMsg, channel, sessionName, sessionId, startTime } = deps;
  const base = deps.baseResult;
  const { elapsedStr } = computeElapsed(startTime);
  const metrics = formatMetricsSuffix({ costUsd: base?.total_cost_usd ?? null, numTurns: base?.num_turns ?? null });
  const waitingText = (remaining: number) =>
    renderTurnStatus({ kind: 'background-waiting', remaining }, { sessionName, sessionId, elapsedStr, metrics });

  const remaining0 = (base?.pendingBackgroundTasks ?? 0) + (base?.undeliveredBackgroundTasks ?? 0);
  await writeStatus(adapter, statusMsg, waitingText(remaining0));

  // Busy bracket for the whole waiting window (F1): a deferred daemon restart must not fire and
  // kill the backend while its background task is still running. The RUN owns the grace and
  // max-wait bounds — it is the only thing that knows when the background phase begins and ends.
  track(+1);
  let waitReleased = false;
  const releaseWait = (): void => {
    if (waitReleased) return;
    waitReleased = true;
    track(-1);
  };

  // Exactly one of the terminal renderings may win. `onMaxWait` deliberately does NOT set it: the
  // run stays in its background phase, so a very late continuation still merges and re-seals.
  let finalized = false;

  // F5: work finished but the backend never delivered the notification (old-CLI same-turn
  // completions / killed tasks). The model already saw the task's outcome inside the turn, so
  // finalize as a normal completion with a zero-cost continuation.
  const onGraceTimeout = (): void => {
    if (finalized) return;
    finalized = true;
    log.info(`background grace timeout: sealing ${channel} without a continuation`);
    void finalize(deps, { total_cost_usd: null, num_turns: null } as AgentResult)
      .catch((e) => log.error('finalizeBackgroundContinuation (grace) failed:', (e as Error)?.message ?? e));
  };

  // F6: still-running work exceeded the cap (tunnels / monitors can run forever). Seal the status
  // as "still running" and release the busy bracket, but KEEP the subscription — a very late
  // continuation still merges and re-seals.
  const onMaxWait = (): void => {
    if (finalized) return;
    const { elapsedStr: fullElapsed } = computeElapsed(startTime);
    const capText = renderTurnStatus({ kind: 'background-capped' }, { sessionName, sessionId, elapsedStr: fullElapsed, metrics });
    void sealStatus(adapter, statusMsg, capText, buildSealedStatusActionBlocks(capText, { channel, sessionName, isDm: true }));
  };

  const onRateLimited = (cont: AgentResult): void => {
    if (finalized) return;
    finalized = true;
    // Record for auto-resume when the rate-limit window resets.
    const provider = cont.rateLimitProvider ?? base?.rateLimitProvider ?? null;
    recordDirectResume({ provider, channel, trackSessionId: deps.trackSessionId, userMessage: deps.userMessage });
    const { elapsedStr: fullElapsed } = computeElapsed(startTime);
    const totals = formatMetricsSuffix({
      costUsd: (base?.total_cost_usd ?? 0) + (cont?.total_cost_usd ?? 0),
      numTurns: (base?.num_turns ?? 0) + (cont?.num_turns ?? 0),
    });
    const rateLimitText = renderTurnStatus({ kind: 'rate-limited' }, { sessionName, sessionId, elapsedStr: fullElapsed, metrics: totals });
    void sealStatus(adapter, statusMsg, rateLimitText, buildSealedStatusActionBlocks(rateLimitText, { channel, sessionName, isDm: true }));
    clearStreamingCallback(channel);
  };

  // F2: the backend process died while background tasks were pending (restart / crash / kill /
  // timeout) — seal honestly as interrupted, never leave the waiting state and never as "done".
  const onInterrupted = (): void => {
    if (finalized) return;
    finalized = true;
    const { elapsedStr: fullElapsed } = computeElapsed(startTime);
    const interruptedText = renderTurnStatus({ kind: 'background-interrupted' }, { sessionName, sessionId, elapsedStr: fullElapsed, metrics });
    void sealStatus(adapter, statusMsg, interruptedText, buildSealedStatusActionBlocks(interruptedText, { channel, sessionName, isDm: true }));
    if (deps.userMessageTs) {
      void conversationLedger.completeTurn(channel, deps.userMessageTs, { executionId: deps.executionId })
        .catch((e) => log.error('completeTurn (bg-interrupted) failed:', (e as Error).message));
    }
    clearStreamingCallback(channel);
  };

  const onComplete = (cont: AgentResult): void => {
    if (finalized) return;
    finalized = true;
    void finalize(deps, cont)
      .catch((e) => log.error('finalizeBackgroundContinuation failed:', (e as Error)?.message ?? e));
  };

  // This surface both streams and persists the background turn, so it owns those rows; any other
  // observer watching the same run (today: the mid-turn injection ledger) must not write them again.
  deps.run.claimBackgroundTranscript();
  deps.run.subscribe(backgroundStatusObserver({
    deps, onGraceTimeout, onMaxWait, onRateLimited, onInterrupted, onComplete,
    onWaiting: (n) => { void writeStatus(adapter, statusMsg, waitingText(n)); },
    releaseWait,
  }));
}

interface ObserverWiring {
  deps: BackgroundStatusDeps;
  onWaiting: (remaining: number) => void;
  onRateLimited: (result: AgentResult) => void;
  onInterrupted: (result: AgentResult) => void;
  onComplete: (result: AgentResult) => void;
  onGraceTimeout: () => void;
  onMaxWait: () => void;
  releaseWait: () => void;
}

/** Pure dispatch: background-phase events → the status surface. Exported for tests. */
export function backgroundStatusObserver(w: ObserverWiring): RunObserver {
  const { deps } = w;
  return {
    onEvent(event: RunEvent): void {
      switch (event.type) {
        case 'assistant_text':
          if (event.phase !== 'background') return;
          // Chat platforms show the ANSWER. A subagent's prose is working notes addressed to its
          // parent, so it is withheld here exactly as it is during a normal turn; the trace line
          // still counts its work.
          if (!event.subagent) deps.stream.emitText(event.text);
          return;
        case 'tool_use':
          if (event.phase !== 'background') return;
          deps.onToolUse?.(event.name, event.input, event.toolUseId);
          return;
        case 'tool_result':
          if (event.phase !== 'background') return;
          deps.onToolResult?.(event.toolUseId, event.content, !event.ok);
          return;
        case 'context_usage':
          if (event.phase !== 'background') return;
          deps.onContextUsage?.(event);
          return;
        case 'background_result': {
          const cont = event.result;
          if (cont.backgroundInterrupted) { w.onInterrupted(cont); return; }
          if (cont.rateLimited) { w.onRateLimited(cont); return; }
          const left = (cont.pendingBackgroundTasks ?? 0) + (cont.undeliveredBackgroundTasks ?? 0);
          if (left > 0) w.onWaiting(left);
          else w.onComplete(cont);
          return;
        }
        case 'background_timeout':
          // Release the bracket first, then report the verdict — the order the guard this replaced
          // used, and the one that keeps a deferred restart from firing inside the seal.
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

/** Seal a held turn once its background continuation completes: final line, push notification,
 *  ledger close, streaming teardown, and the continuation's own cost row. */
async function finalize(deps: BackgroundStatusDeps, cont: AgentResult): Promise<void> {
  const { adapter, statusMsg, channel, sessionName, sessionId, startTime } = deps;
  const base = deps.baseResult;
  const { elapsedStr, elapsedS } = computeElapsed(startTime);
  const metrics = formatMetricsSuffix({
    costUsd: (base?.total_cost_usd ?? 0) + (cont?.total_cost_usd ?? 0),
    numTurns: (base?.num_turns ?? 0) + (cont?.num_turns ?? 0),
  });
  const statusText = renderTurnStatus({ kind: 'done' }, { sessionName, sessionId, elapsedStr, metrics });
  await sealStatus(adapter, statusMsg, statusText, buildSealedStatusActionBlocks(statusText, { channel, sessionName, isDm: true }));
  await maybeNotifyTurnComplete({
    adapter, channel, threadAnchorId: null, sessionName, sessionId,
    elapsedS, elapsedStr, status: 'completed', metricsSuffix: metrics,
  });
  if (deps.userMessageTs) {
    await conversationLedger.completeTurn(channel, deps.userMessageTs, { executionId: deps.executionId })
      .catch((e) => log.error('completeTurn failed:', (e as Error).message));
  }
  clearStreamingCallback(channel);
  await recordBackgroundCost({
    result: cont, projectId: deps.projectId, trigger: deps.trigger, backend: deps.backend,
    mode: resolveRunConfig({ channel }).profile.mode,
    sessionId: deps.trackSessionId ?? sessionId, executionId: deps.executionId,
  }).catch((e) => log.warn('recordCost (bg-continuation) failed:', (e as Error).message));
}

async function recordBackgroundCost(input: {
  result: AgentResult; projectId: string; trigger: string; backend: string;
  /** The mode the continuation actually ran under — the channel's profile, not a global (D5). */
  mode: string | null;
  sessionId: string | null; executionId: string | null;
}): Promise<void> {
  const accounting = input.result.reportedAccounting;
  if (input.result.total_cost_usd == null && accounting?.usageReported !== true) return;
  await recordCost({
    project: input.projectId,
    trigger: input.trigger ? `${input.trigger}:bg-continuation` : 'bg-continuation',
    cost_usd: input.result.total_cost_usd, backend: input.backend,
    mode: input.mode ?? null, source: 'estimate',
    input_tokens: accounting?.inputTokens ?? null,
    output_tokens: accounting?.outputTokens ?? null,
    prompt_tokens: accounting?.promptTokens ?? null,
    cache_read_tokens: accounting?.cacheReadTokens ?? null,
    cache_creation_tokens: accounting?.cacheCreationTokens ?? null,
    provider_requests: Number.isSafeInteger(input.result.num_turns)
      && Number(input.result.num_turns) > 0 ? input.result.num_turns : null,
    session_id: input.sessionId, execution_id: input.executionId,
    provider: 'anthropic', model: accounting?.model ?? undefined,
  });
}
