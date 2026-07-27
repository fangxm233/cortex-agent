// input:  continuation contract, OutputStream, AgentResult, id-correlated tool callbacks
// output: background continuation sink forwarding complete tool uses/results plus gate helpers
// pos:    CC continuation orchestration (merge into reply, preserve DEBUG data, update waiting status)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { OutputStream } from '@platform/index.js';
import type { AgentResult } from '@core/types/agent-types.js';
import type { ContinuationSink } from '../agent-adapter/types.js';
import { isBgContinuationEnabled } from '../agent-adapter/bg-wait.js';

export interface ContinuationSinkDeps {
  /** The originating turn's OutputStream — continuation text is appended here so the
   *  follow-up merges into the same reply (looks like one turn). */
  stream: OutputStream;
  /** Optional callback for tool_use events from the continuation turn. When set,
   *  forwarded to the ContinuationSink so the adapter can route continuation tool
   *  calls to the originating turn's ToolTrace (Slack tool traces + history). */
  onToolUse?: ((name: string, input: any, toolUseId?: string) => void) | null;
  /** Optional full normalized result callback paired to onToolUse by toolUseId. */
  onToolResult?: ((toolUseId: string, content: string, isError: boolean) => void) | null;
  /** Called when the continuation result still has background work remaining (chained /
   *  undelivered tasks): keep the status waiting with the combined remaining count. The
   *  split lets the caller re-arm the bg-wait-guard (grace vs max-wait). */
  onWaiting: (remaining: number, split?: { running: number; undelivered: number }) => void;
  /** Called when the continuation turn is rate-limited: seal the status as rate-limited
   *  and record for auto-resume, instead of leaving it in waiting or sealing as done. */
  onRateLimited: (result: AgentResult) => void;
  /** Called when no background tasks remain: seal the status as complete, record the
   *  continuation's cost, and clear the streaming callback + sink. */
  onComplete: (result: AgentResult) => void;
  /** Called when the Claude process died while background tasks were pending (synthetic
   *  result with backgroundInterrupted). Seal as interrupted — never as "done". Falls back
   *  to onComplete when absent (legacy callers). */
  onInterrupted?: (result: AgentResult) => void;
}

/**
 * Build the session-level continuation sink. Pure dispatch: assistant text is merged
 * into the originating reply via the shared OutputStream; the terminating result either
 * holds the waiting status (work remaining) or completes the turn (none remain).
 * Heavy side effects (seal / cost / clear) are injected via onWaiting / onComplete / onInterrupted.
 */
export function buildContinuationSink(deps: ContinuationSinkDeps): ContinuationSink {
  return {
    onAssistantText: (text: string) => deps.stream.emitText(text),
    onToolUse: deps.onToolUse || undefined,
    onToolResult: deps.onToolResult || undefined,
    onResult: (result: AgentResult) => {
      if (result.backgroundInterrupted) { (deps.onInterrupted ?? deps.onComplete)(result); return; }
      if (result.rateLimited) { deps.onRateLimited(result); return; }
      const running = result.pendingBackgroundTasks ?? 0;
      const undelivered = result.undeliveredBackgroundTasks ?? 0;
      if (running + undelivered > 0) deps.onWaiting(running + undelivered, { running, undelivered });
      else deps.onComplete(result);
    },
  };
}

/** Single gate for the background-task hold decision (agent-runner + lifecycle share it):
 *  feature enabled + interactive channel + not rate-limited + sink capability + work remaining
 *  (running or undelivered — the latter is bounded by the grace watchdog upstream). */
export function shouldHoldForBg(
  result: { pendingBackgroundTasks?: number; undeliveredBackgroundTasks?: number; rateLimited?: boolean } | null | undefined,
  channel: string,
  canRegisterSink: boolean,
): boolean {
  if (!isBgContinuationEnabled() || !isInteractiveChannel(channel) || !canRegisterSink) return false;
  if (!result || result.rateLimited) return false;
  const remaining = (result.pendingBackgroundTasks ?? 0) + (result.undeliveredBackgroundTasks ?? 0);
  return remaining > 0;
}

/** Feature gate (shared with the thread inline wait): re-exported from agent-adapter/bg-wait,
 *  the single source of truth for CORTEX_BG_CONTINUATION. */
export { isBgContinuationEnabled };

/** Scope gate: only interactive user conduits (Slack / Feishu), never thread/dispatch. */
export function isInteractiveChannel(channel: string): boolean {
  return !!channel && (channel.startsWith('slack:') || channel.startsWith('feishu:'));
}

/** Scope gate for the Web UI hold: the `web:` conduit. Kept SEPARATE from isInteractiveChannel
 *  because the two holds render their "waiting" state through different surfaces — Slack/Feishu
 *  edit a status message (lifecycle.ts), web keeps the session.status event stream live and
 *  streams the continuation as session.message events (web-bg-hold.ts). */
export function isWebChannel(channel: string): boolean {
  return !!channel && channel.startsWith('web:');
}

/** Single gate for the WEB background-task hold (agent-runner uses it): feature enabled + web
 *  channel + not rate-limited + sink capability + work remaining. Mirrors shouldHoldForBg but
 *  scoped to `web:` so web sessions do not fall through both hold paths (the original gap:
 *  a web turn ending with a live background task silently dropped the continuation). */
export function shouldHoldWebForBg(
  result: { pendingBackgroundTasks?: number; undeliveredBackgroundTasks?: number; rateLimited?: boolean } | null | undefined,
  channel: string,
  canRegisterSink: boolean,
): boolean {
  if (!isBgContinuationEnabled() || !isWebChannel(channel) || !canRegisterSink) return false;
  if (!result || result.rateLimited) return false;
  const remaining = (result.pendingBackgroundTasks ?? 0) + (result.undeliveredBackgroundTasks ?? 0);
  return remaining > 0;
}
