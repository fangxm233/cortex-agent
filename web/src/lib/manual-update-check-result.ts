// input:  a parsed cross-channel update-check report, from whoever ran the check
// output: that report, handed to every update channel listening for one
// pos:    The seam under the update features; knows no channel and runs no check

import type { ChannelOutcome } from '@/lib/native-bridge';

/**
 * A manual "check for updates" spans three channels — server, app shell, SPA bundle — so the code
 * that RUNS it necessarily knows all three, and lives in `features/update-prompt`. Each channel
 * needs to hear the result, because a manual check re-opens a prompt the user had dismissed. Having
 * the channels subscribe to the orchestrator directly is what put the whole update tree in a cycle:
 * update-prompt → channel (to read its payload) and channel → update-prompt (to hear the result).
 *
 * This is the one-way hand-off that breaks it. The orchestrator publishes; the channels subscribe;
 * neither imports the other. The report's SHAPE is declared here, once, so the publisher and every
 * subscriber are checked against the same two keys; each channel names only its own payload type
 * (`useAppUpdate` reads `shell`, `useHotUpdate` reads `ui`) and leaves the other as `unknown`.
 */
export interface ManualCheckReport<TUi = unknown, TShell = unknown> {
  ui: ChannelOutcome<TUi>;
  shell: ChannelOutcome<TShell>;
}

type ResultListener = (report: ManualCheckReport) => void;

const listeners = new Set<ResultListener>();

/**
 * Listen for manual check results. The type parameters are the payload shapes the caller expects
 * under `ui` / `shell`; reports come from the single orchestrator that owns the check, so a
 * subscriber naming its own slice is describing the same object from one side.
 */
export function subscribeManualCheckResult<TUi = unknown, TShell = unknown>(
  listener: (report: ManualCheckReport<TUi, TShell>) => void,
): () => void {
  const entry = listener as ResultListener;
  listeners.add(entry);
  return () => { listeners.delete(entry); };
}

/** Broadcast one completed check. Synchronous, in subscription order — callers dedupe, not this. */
export function publishManualCheckResult(report: ManualCheckReport): void {
  for (const listener of listeners) listener(report);
}
