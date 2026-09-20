// input:  a parsed cross-channel update-check report, from whoever ran the check
// output: that report, handed to every update channel listening for one
// pos:    The seam under the update features; knows no channel and runs no check

/**
 * A manual "check for updates" spans three channels — server, app shell, SPA bundle — so the code
 * that RUNS it necessarily knows all three, and lives in `features/update-prompt`. Each channel
 * needs to hear the result, because a manual check re-opens a prompt the user had dismissed. Having
 * the channels subscribe to the orchestrator directly is what put the whole update tree in a cycle:
 * update-prompt → channel (to read its payload) and channel → update-prompt (to hear the result).
 *
 * This is the one-way hand-off that breaks it. The orchestrator publishes; the channels subscribe;
 * neither imports the other. The report is the publisher's type, and a subscriber names only the
 * slice it reads — `useAppUpdate` asks for `{ shell }`, `useHotUpdate` for `{ ui }` — so no channel
 * has to know the whole report to listen for its own half of it.
 */

type ResultListener = (report: unknown) => void;

const listeners = new Set<ResultListener>();

/**
 * Listen for manual check results. `T` is the shape the caller expects to read; reports come from
 * the single orchestrator that owns the check, so a subscriber naming its own slice of that report
 * is describing the same object from one side.
 */
export function subscribeManualCheckResult<T>(listener: (report: T) => void): () => void {
  const entry = listener as ResultListener;
  listeners.add(entry);
  return () => { listeners.delete(entry); };
}

/** Broadcast one completed check. Synchronous, in subscription order — callers dedupe, not this. */
export function publishManualCheckResult(report: unknown): void {
  for (const listener of listeners) listener(report);
}
