// input:  background-phase events and one terminal verdict, from `background-hold.ts`
// output: the web session's event stream for a held turn — the continuation's assistant prose,
//         tool calls, tool results, subagent ends, context snapshots and notices
// pos:    orchestration/turn — the web half of a held turn, extracted from
//         `web-status-renderer.ts`. What is gone from it: the hold's lifetime AND its
//         `session.status` publishes. `running:true/false` is the hold's business now
//         (`background-hold.ts`), which is what finally made the Slack hold and this one the same
//         object with two renderers. What stayed: the held API error, which is a rendering
//         decision about WHICH row to write, not about when the hold ends.

import { createLogger } from '@core/log.js';
import type { ChatNoticeLevel, ContextUsage, NoticeAction } from '@core/types/agent-types.js';
import { isApiRateLimitError } from '@domain/agents/config.js';
import type { ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import { t } from '../../core/i18n.js';
import type { HoldRenderer, HoldTotals, SealedVerdict } from './background-hold.js';

const log = createLogger('hold-render-web');

export interface WebHoldDeps {
  /** Append + publish a continuation assistant message (history record + session.message).
   *  `subagent` is set when a native subagent produced the text — without it the transcript
   *  cannot tell a subagent's working notes from the agent's own answer. */
  publishAssistant: (text: string, subagent?: ToolUseSubagent) => void;
  /** Append + publish a continuation tool call (history record + session.message). */
  publishTool: (name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void;
  /** Persist a complete normalized continuation tool result in DEBUG mode. */
  publishToolResult?: (toolUseId: string, content: string, isError: boolean) => void;
  /** Publish the authoritative end of one backgrounded subagent. Distinct from the hold's seal:
   *  several subagents can run under one hold and each ends alone. */
  publishSubagentEnd?: (parentToolUseId: string, status: 'completed' | 'failed' | 'killed') => void;
  /** Persist and publish an exact continuation context snapshot. */
  publishContextUsage?: (usage: ContextUsage) => void;
  /** Append + publish a continuation NOTICE row (level + optional action), the fields the plain
   *  assistant path drops. Without it a rate-limited continuation renders as a bare "API Error:"
   *  line with no resume affordance. */
  publishNotice?: (text: string, level: ChatNoticeLevel, action?: NoticeAction) => void;
}

/**
 * The session-event rendering of a held turn.
 *
 * Rate-limit API errors are HELD, not streamed. The backend surfaces a 429 as ordinary assistant
 * prose BEFORE the continuation settles, and only the result says whether it was a failure (show
 * the card) or a pause the resume registry already owns (show the auto-resume warning instead).
 * Same contract as AttemptNoticeTracker in domain/runs/notices.ts — which is bound to the
 * foreground turn and has therefore already retired by the time a continuation runs.
 */
export function webHoldRenderer(deps: WebHoldDeps): HoldRenderer {
  let heldApiError: string | null = null;
  const flushHeldApiError = (): void => {
    const held = heldApiError;
    heldApiError = null;
    if (!held) return;
    if (deps.publishNotice) deps.publishNotice(held, 'error');
    else deps.publishAssistant(held);
  };

  return {
    // The web surface has no waiting line: the held state IS the session.status the hold publishes.
    onWaiting(): void {},

    onText(text: string, subagent?: ToolUseSubagent): void {
      if (!text) return;
      // Only the agent's own stream is held: a subagent's card keeps its attribution and the
      // subagent, not the session, owns that failure.
      if (!subagent && text.startsWith('API Error:') && isApiRateLimitError(text)) {
        heldApiError = text;
        return;
      }
      deps.publishAssistant(text, subagent);
    },

    onTool(name: string, input: unknown, toolUseId: string, subagent?: ToolUseSubagent): void {
      deps.publishTool(name, input, toolUseId, subagent);
    },

    onToolResult(toolUseId: string, content: string, isError: boolean): void {
      deps.publishToolResult?.(toolUseId, content, isError);
    },

    onContext(usage: ContextUsage): void {
      deps.publishContextUsage?.(usage);
    },

    onSubagentEnd(parentToolUseId: string, status: 'completed' | 'failed' | 'killed'): void {
      // Not routed through publishAssistant/publishTool: this is a state correction for a subagent
      // block, carrying no prose that belongs in the transcript.
      deps.publishSubagentEnd?.(parentToolUseId, status);
    },

    onSealed(kind: SealedVerdict, totals: HoldTotals): void {
      if (kind === 'max-wait') {
        // The cap releases the session, it does not end the turn: the subscription stays and a very
        // late continuation still streams. Nothing is flushed — the held card is still pending.
        log.info('web bg-hold max-wait cap — releasing (subscription kept for a late continuation)');
        return;
      }
      if (kind === 'grace') log.info('web bg-hold grace timeout — sealing session idle');
      if (kind === 'rate-limited' && totals.resumable) {
        // Paused, not failed — the held card would misreport the outcome.
        heldApiError = null;
        deps.publishNotice?.(t('notify.rateLimitAutoResume'), 'warning', { kind: 'cancel-resume' });
      }
      flushHeldApiError();
    },
  };
}
