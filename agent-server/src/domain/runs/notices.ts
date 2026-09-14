//
// Two jobs, both about narration rather than execution:
//
//   1. Classify assistant prose the backend emits (`API Error:` → an error notice).
//   2. Synthesize lines the backend never sends: "falling back to X", "context compacted",
//      "rate-limited, will auto-resume".
//
// The subtle part is a HELD rate-limit card. A backend surfaces a 429 as an assistant message
// BEFORE the turn settles, but only the settle says whether it was a failure (show the card) or a
// pause the resume registry already owns (show the auto-resume warning instead). So this sits in
// the event path and can swallow a line, not beside it as a passive observer.

import { t } from '../../core/i18n.js';
import type { AgentResult, ChatNoticeLevel, NoticeAction } from '@core/types/agent-types.js';
import type { ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import type { RunAttemptConfig } from '../agents/profile-manager.js';
import { isApiRateLimitError } from '../agents/config.js';
import { isProviderRateLimited } from '../costs/rate-limit-throttle.js';
import { attemptLabel } from './fallback.js';

/** `API Error:` prose is the backend reporting its own failure, not the agent talking. */
export function assistantNoticeLevel(text: string): ChatNoticeLevel | undefined {
  return text.startsWith('API Error:') ? 'error' : undefined;
}

/** A backend's own error text is already user-facing; anything else gets the generic wrapper. */
export function terminalErrorText(message: string): string {
  return message.startsWith('API Error:') ? message : t('status.errorBody', { message });
}

/** What the tracker needs to know about the run it narrates. */
export interface NoticeContext {
  /** Synthesized notices are a web-surface feature; Slack/Feishu render status messages instead. */
  channel?: string | null;
  /** A person is waiting on this run, so a rate limit is a pause worth offering to resume. */
  isUserInitiated?: boolean;
  /** `edit-retry` re-runs an existing message; a rate limit there is not queued for auto-resume. */
  trigger?: string | null;
}

/** How a notice reaches the surface. Null when the run has no prose surface at all. */
export type NoticeEmit = (
  text: string,
  blockId?: string,
  level?: ChatNoticeLevel,
  action?: NoticeAction,
  subagent?: ToolUseSubagent,
) => void;

/**
 * Tracks error notices within one attempt so terminal handling is durable but not noisy: an
 * attempt that already showed an error card does not get a second one, and a fallback opens a
 * fresh dedupe window so the new provider's failure is not hidden by the old provider's notice.
 */
export class AttemptNoticeTracker {
  private readonly synthesize: boolean;
  private attemptHasErrorNotice = false;
  private heldError: { text: string; blockId?: string } | null = null;

  constructor(
    private readonly ctx: NoticeContext,
    private readonly emit: NoticeEmit | null,
  ) {
    this.synthesize = ctx.channel?.startsWith('web:') === true;
  }

  /**
   * Every assistant line passes through here on its way to the surface. Returns nothing: a held
   * rate-limit card is simply not forwarded, and is released later by one of the settle paths.
   */
  observe(
    text: string, blockId?: string, level?: ChatNoticeLevel, action?: NoticeAction,
    subagent?: ToolUseSubagent,
  ): void {
    if (level === 'error' && this.synthesize && isApiRateLimitError(text)) {
      this.heldError = { text, ...(blockId ? { blockId } : {}) };
      return;
    }
    if (level === 'error') this.attemptHasErrorNotice = true;
    // Subagent attribution travels with the line: this wrapper sits on EVERY assistant message
    // (tool calls bypass it), so dropping the argument here silently untags a subagent's prose
    // while its tool calls stay attributed.
    this.emit?.(text, blockId, level, action, subagent);
  }

  /** Release a held rate-limit card. Every settle path calls this except the resumable one,
   *  which drops the card in favour of the auto-resume warning. */
  private flushHeldError(): void {
    const held = this.heldError;
    this.heldError = null;
    if (!held || !this.emit) return;
    this.attemptHasErrorNotice = true;
    this.emit(held.text, held.blockId, 'error');
  }

  /** The attempt produced a result: a turn that recovered from a mid-flight API error still
   *  reports it, just once the outcome is known. */
  settleSuccess(): void {
    this.flushHeldError();
  }

  private emitTerminal(message: string, displayText = terminalErrorText(message)): void {
    this.flushHeldError();
    if (!this.synthesize || !this.emit || this.attemptHasErrorNotice) return;
    this.attemptHasErrorNotice = true;
    this.emit(displayText, undefined, 'error');
  }

  private emitAutoResume(provider: string | undefined): boolean {
    if (!this.ctx.isUserInitiated || !isProviderRateLimited(provider)) return false;
    // Paused, not failed — the held card would misreport the outcome.
    this.heldError = null;
    if (this.synthesize && this.emit && !this.attemptHasErrorNotice) {
      this.attemptHasErrorNotice = true;
      this.emit(t('notify.rateLimitAutoResume'), undefined, 'warning', { kind: 'cancel-resume' });
    }
    return true;
  }

  /** This attempt is over and another one follows: its held card is now terminal for that
   *  provider, and the next attempt starts with a clean dedupe window. */
  transitionToFallback(
    current: Pick<RunAttemptConfig, 'model' | 'mode'>,
    next: Pick<RunAttemptConfig, 'model' | 'mode'>,
  ): void {
    this.flushHeldError();
    if (this.synthesize) {
      this.observe(t('notify.agentFallback', {
        from: attemptLabel(current), to: attemptLabel(next),
      }), undefined, 'warning');
    }
    this.attemptHasErrorNotice = false;
  }

  emitTerminalError(error: unknown): void {
    const value = error as {
      message?: unknown;
      cancelled?: boolean;
      rateLimitProvider?: string;
    } | null | undefined;
    if (value?.cancelled) return;
    const message = typeof value?.message === 'string' && value.message.length > 0
      ? value.message
      : String(error);
    const resumableDirectError = this.ctx.trigger !== 'edit-retry'
      && isApiRateLimitError(message)
      && this.emitAutoResume(value?.rateLimitProvider);
    if (!resumableDirectError) this.emitTerminal(message);
  }

  emitTerminalRateLimit(result: AgentResult): void {
    if (this.emitAutoResume(result.rateLimitProvider)) return;
    const detail = result.rateLimitMessage;
    if (typeof detail === 'string' && detail.startsWith('API Error:')) this.emitTerminal(detail);
    else this.emitTerminal(t('status.rateLimitedExhausted'), t('status.rateLimitedExhausted'));
  }
}
