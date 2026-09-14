// input:  background-phase events and one terminal verdict, from `background-hold.ts`
// output: the turn's status message, rewritten while the background phase lasts and sealed when it
//         ends — plus the push notification, the ledger's turn completion, the continuation's cost
//         row and the streaming teardown that belong to that seal
// pos:    orchestration/turn — the Slack/Feishu half of a held turn, extracted from
//         `status-renderer.ts`. What is gone from it: the hold's lifetime. This file decides
//         nothing about when the background phase ends, only what the status line says when it
//         does; the busy bracket, the `SessionHolds` registration and running:true/false are the
//         hold's (`background-hold.ts`).

import { createLogger } from '@core/log.js';
import type { AgentResult, ContextUsage } from '@core/types/agent-types.js';
import type { OutputStream, PlatformAdapter, MessageRef } from '@platform/index.js';
import type { ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import { resolveRunConfig } from '@domain/runs/config-resolver.js';
import { recordCost } from '@domain/costs/cost-tracker.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { maybeNotifyTurnComplete } from '../turn-notify.js';
import {
  renderTurnStatus, computeElapsed, formatMetricsSuffix,
  writeStatus, sealStatus, buildSealedStatusActionBlocks,
} from '../status-helpers.js';
import { activeTurns } from './active-turns.js';
import type { HoldRenderer, HoldTotals, SealedVerdict } from './background-hold.js';

const log = createLogger('hold-render-platform');

export interface PlatformHoldDeps {
  adapter: PlatformAdapter;
  statusMsg: MessageRef;
  channel: string;
  /** The originating turn's reply stream — continuation prose is appended here so the follow-up
   *  merges into the same message and the turn still reads as one answer. */
  stream: OutputStream;
  sessionName: string | null;
  /** Backend session id, for the status line's session tag. */
  sessionId: string | null;
  /** Stable Cortex tracking id, for cost attribution. */
  trackSessionId: string | null;
  startTime: number;
  /** The foreground result whose totals the final line adds to. */
  baseResult: AgentResult;
  userMessageTs: string | null;
  executionId: string | null;
  trigger: string;
  projectId: string;
  backend: string;
  onToolUse?: ((name: string, input: any, toolUseId: string) => void) | null;
  onToolResult?: ((toolUseId: string, content: string, isError: boolean) => void) | null;
  onContextUsage?: ((usage: ContextUsage) => void) | null;
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
  const { adapter, statusMsg, channel, sessionName, sessionId, startTime } = deps;
  const base = deps.baseResult;
  // The base-only tally, rendered while waiting and by the two verdicts that report no
  // continuation of their own (cap / interruption).
  const { elapsedStr } = computeElapsed(startTime);
  const metrics = formatMetricsSuffix({
    costUsd: base?.total_cost_usd ?? null, numTurns: base?.num_turns ?? null,
  });
  const blocks = { channel, sessionName, isDm: true };

  const seal = (text: string): Promise<void> =>
    sealStatus(adapter, statusMsg, text, buildSealedStatusActionBlocks(text, blocks));

  return {
    onWaiting(remaining: number): Promise<void> {
      const text = renderTurnStatus(
        { kind: 'background-waiting', remaining },
        { sessionName, sessionId, elapsedStr, metrics },
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

    onTool(name: string, input: unknown, toolUseId: string): void {
      deps.onToolUse?.(name, input, toolUseId);
    },

    onToolResult(toolUseId: string, content: string, isError: boolean): void {
      deps.onToolResult?.(toolUseId, content, isError);
    },

    onContext(usage: ContextUsage): void {
      deps.onContextUsage?.(usage);
    },

    onSealed(kind: SealedVerdict, totals: HoldTotals): void {
      const { elapsedStr: fullElapsed } = computeElapsed(startTime);
      const merged = formatMetricsSuffix({ costUsd: totals.costUsd, numTurns: totals.numTurns });
      switch (kind) {
        case 'complete':
        case 'grace':
          if (kind === 'grace') log.info(`background grace timeout: sealing ${channel} without a continuation`);
          void finalize(deps, totals.continuation, merged)
            .catch((e) => log.error('finalizeBackgroundContinuation failed:', (e as Error)?.message ?? e));
          return;
        case 'max-wait': {
          // A legitimately never-ending task (tunnel / monitor) passed the cap. Seal the line as
          // "still running" — the subscription is kept, so a very late continuation re-seals.
          const capText = renderTurnStatus({ kind: 'background-capped' }, { sessionName, sessionId, elapsedStr: fullElapsed, metrics });
          void seal(capText);
          return;
        }
        case 'interrupted': {
          // The backend process died while background tasks were pending (restart / crash / kill /
          // timeout), or the user ended the hold — seal honestly, never as "done" and never leaving
          // the waiting state up.
          const interruptedText = renderTurnStatus({ kind: 'background-interrupted' }, { sessionName, sessionId, elapsedStr: fullElapsed, metrics });
          void seal(interruptedText);
          if (deps.userMessageTs) {
            void conversationLedger.completeTurn(channel, deps.userMessageTs, { executionId: deps.executionId })
              .catch((e) => log.error('completeTurn (bg-interrupted) failed:', (e as Error).message));
          }
          activeTurns.clearStreamingCallback(channel);
          return;
        }
        case 'rate-limited': {
          const rateLimitText = renderTurnStatus({ kind: 'rate-limited' }, { sessionName, sessionId, elapsedStr: fullElapsed, metrics: merged });
          void seal(rateLimitText);
          activeTurns.clearStreamingCallback(channel);
          return;
        }
        default:
          return;
      }
    },
  };
}

/** Seal a held turn once its background continuation completes: final line, push notification,
 *  ledger close, streaming teardown, and the continuation's own cost row. */
async function finalize(deps: PlatformHoldDeps, cont: AgentResult | null, metrics: string): Promise<void> {
  const { adapter, statusMsg, channel, sessionName, sessionId, startTime } = deps;
  const { elapsedStr, elapsedS } = computeElapsed(startTime);
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
  activeTurns.clearStreamingCallback(channel);
  // A grace verdict has no continuation of its own — nothing was reported, so nothing is recorded.
  if (!cont) return;
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
