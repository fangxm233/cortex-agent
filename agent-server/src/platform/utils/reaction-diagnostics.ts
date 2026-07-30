// input:  rejected reaction-API errors from any platform SDK
// output: reaction failure reason + once-per-reason report gate
// pos:    Shared diagnostics for the queue/consumed reaction markers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/**
 * Reaction markers are best-effort everywhere: every caller drops their failures so a broken marker
 * can never break a turn. That is why a token without `reactions:write` produced no marker and no
 * trace at all. These helpers give the adapters one cheap report per distinct cause instead.
 */

/** Reasons already reported in this process; markers fire per message so the report must not repeat. */
const reportedReasons = new Set<string>();

/** Pull the most specific cause out of a platform SDK rejection (Slack `data.error`, else message). */
export function reactionFailureReason(error: unknown): string {
  const candidate = error as { data?: { error?: unknown }; message?: unknown } | null;
  return String(candidate?.data?.error ?? candidate?.message ?? error);
}

/** True the first time a given reaction-failure reason is seen in this process. */
export function shouldWarnReactionFailure(reason: string, seen = reportedReasons): boolean {
  if (seen.has(reason)) return false;
  seen.add(reason);
  return true;
}
