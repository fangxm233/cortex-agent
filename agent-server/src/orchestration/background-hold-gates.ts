import { isBgContinuationEnabled } from '../agent-adapter/bg-wait.js';

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
 *  streams the continuation as session.message events (web-status-renderer.ts). */
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
