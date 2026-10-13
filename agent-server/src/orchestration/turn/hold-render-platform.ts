import { createLogger } from '@core/log.js';
import type { AgentResult } from '@core/types/agent-types.js';
import type { OutputStream, PlatformAdapter, MessageRef } from '@platform/index.js';
import type { ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { maybeNotifyTurnComplete } from '../turn-notify.js';
import {
  renderTurnStatus, computeElapsed, formatMetricsSuffix,
  writeStatus, sealStatus, buildSealedStatusActionBlocks,
} from '../status-helpers.js';
import { activeTurns, type StreamingCallback } from './active-turns.js';
import type { HoldRenderer, HoldTotals, SealedVerdict } from './background-hold.js';

const log = createLogger('hold-render-platform');

export interface PlatformHoldDeps {
  adapter: PlatformAdapter;
  statusMsg: MessageRef;
  channel: string;
  /** The originating turn's reply stream — continuation prose is appended here so the follow-up
   *  merges into the same message and the turn still reads as one answer. */
  stream: OutputStream;
  /** The originating turn's own `onAssistantMsg` (the object behind `stream`, which is
   *  `ownedCallback.stream`). The seal releases the channel's streaming slot only while it is
   *  still THIS turn's — a hold superseded by the next turn must not cut the successor's. */
  ownedCallback: StreamingCallback;
  /** Stable Cortex session ID for status and resume actions. */
  sessionId: string | null;
  startTime: number;
  /** The foreground result whose totals the final line adds to. */
  baseResult: AgentResult;
  userMessageTs: string | null;
  executionId: string | null;
  /** The turn's tool trace, when it is on. */
  onToolUse?: ((name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void) | null;
}

/**
 * The status-message rendering of a held turn.
 *
 * Verdict → line: `complete` / `grace` seal as done (grace: the model already saw the task's
 * outcome inside the turn, so it finalizes as a normal completion with a zero-cost continuation),
 * `max-wait` seals as still-running, `interrupted` seals with the interruption note, `rate-limited`
 * seals with the rate-limit line. `chained` arrives as another `onWaiting`.
 */
export function platformHoldRenderer(deps: PlatformHoldDeps): HoldRenderer {
  const { adapter, statusMsg, channel, sessionId, startTime } = deps;
  const base = deps.baseResult;
  // The base-only tally, rendered while waiting and by the two verdicts that report no
  // continuation of their own (cap / interruption).
  const { elapsedStr } = computeElapsed(startTime);
  const metrics = formatMetricsSuffix({
    costUsd: base?.total_cost_usd ?? null, numTurns: base?.num_turns ?? null,
  });
  const blocks = { channel, sessionId, isDm: true };

  // Detached at every call site (`void seal(...)`): a seal the platform cannot take is logged here,
  // never left as an unobserved rejection.
  const seal = (text: string): Promise<void> =>
    sealStatus(adapter, statusMsg, text, buildSealedStatusActionBlocks(text, blocks))
      .catch((e) => log.error('background seal failed:', (e as Error).message));

  return {
    onWaiting(remaining: number): Promise<void> {
      const text = renderTurnStatus(
        { kind: 'background-waiting', remaining },
        { sessionId, elapsedStr, metrics },
      );
      return writeStatus(adapter, statusMsg, text);
    },

    onText(text: string, subagent?: ToolUseSubagent): void {
      // Chat platforms show the ANSWER. A subagent's prose is working notes addressed to its
      // parent, so it is withheld here exactly as it is during a normal turn; the trace line
      // still counts its work.
      if (subagent) return;
      deps.stream.emitText(text);
    },

    onTool(name: string, input: unknown, toolUseId: string, subagent?: ToolUseSubagent): void {
      deps.onToolUse?.(name, input, toolUseId, subagent);
    },

    onSealed(kind: SealedVerdict, totals: HoldTotals): void {
      const { elapsedStr: fullElapsed } = computeElapsed(startTime);
      const merged = formatMetricsSuffix({ costUsd: totals.costUsd, numTurns: totals.numTurns });
      switch (kind) {
        case 'complete':
        case 'grace':
          if (kind === 'grace') log.info(`background grace timeout: sealing ${channel} without a continuation`);
          void finalize(deps, merged)
            .catch((e) => log.error('finalizeBackgroundContinuation failed:', (e as Error)?.message ?? e));
          return;
        case 'max-wait': {
          // A legitimately never-ending task (tunnel / monitor) passed the cap. Seal the line as
          // "still running" — the subscription is kept, so a very late continuation re-seals.
          const capText = renderTurnStatus({ kind: 'background-capped' }, { sessionId, elapsedStr: fullElapsed, metrics });
          void seal(capText);
          return;
        }
        case 'interrupted': {
          // The backend process died while background tasks were pending (restart / crash / kill /
          // timeout), or the user ended the hold — seal honestly, never as "done" and never leaving
          // the waiting state up.
          const interruptedText = renderTurnStatus({ kind: 'background-interrupted' }, { sessionId, elapsedStr: fullElapsed, metrics });
          void seal(interruptedText);
          if (deps.userMessageTs) {
            void conversationLedger.completeTurn(channel, deps.userMessageTs, { executionId: deps.executionId })
              .catch((e) => log.error('completeTurn (bg-interrupted) failed:', (e as Error).message));
          }
          activeTurns.releaseStreamingCallback(channel, deps.ownedCallback);
          return;
        }
        case 'rate-limited': {
          const rateLimitText = renderTurnStatus({ kind: 'rate-limited' }, { sessionId, elapsedStr: fullElapsed, metrics: merged });
          void seal(rateLimitText);
          activeTurns.releaseStreamingCallback(channel, deps.ownedCallback);
          return;
        }
        default:
          return;
      }
    },
  };
}

/** Seal a held turn once its background continuation completes: final line, push notification,
 *  ledger close and streaming teardown. The continuation's cost row is the run's own
 *  (`domain/runs/attempt.ts`), recorded as it streamed. */
async function finalize(deps: PlatformHoldDeps, metrics: string): Promise<void> {
  const { adapter, statusMsg, channel, sessionId, startTime } = deps;
  const { elapsedStr, elapsedS } = computeElapsed(startTime);
  const statusText = renderTurnStatus({ kind: 'done' }, { sessionId, elapsedStr, metrics });
  await sealStatus(adapter, statusMsg, statusText, buildSealedStatusActionBlocks(statusText, { channel, sessionId, isDm: true }));
  await maybeNotifyTurnComplete({
    adapter, channel, threadAnchorId: null, sessionId,
    elapsedS, elapsedStr, status: 'completed', metricsSuffix: metrics,
  });
  if (deps.userMessageTs) {
    await conversationLedger.completeTurn(channel, deps.userMessageTs, { executionId: deps.executionId })
      .catch((e) => log.error('completeTurn failed:', (e as Error).message));
  }
  activeTurns.releaseStreamingCallback(channel, deps.ownedCallback);
}
