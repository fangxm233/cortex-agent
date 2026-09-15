// input:  UpdateChoice from the UpdatePrompt contract
// output: the single in-memory server-update status the SPA dialog renders, plus the sink that
//         lets a tRPC mutation answer a pending prompt
// pos:    Shared between orchestration/interactions/ui-update-prompt.ts (writes `prompting`),
//         domain/system/server-update-check.ts (writes the install outcome) and
//         domain/ui-service/{query,mutate}/system.ts (reads / answers). Process-local by design:
//         the npm install restarts app.js, so anything durable here would be stale on the way back.

import type { UpdateChoice } from './update-prompt.js';

export type ServerUpdateState = 'idle' | 'prompting' | 'installing' | 'restarting' | 'failed';

export interface ServerUpdateStatus {
  /** Version the server could move to, or null when there is nothing pending. */
  available: string | null;
  state: ServerUpdateState;
  /** Set only in the `failed` state — the npm exit code / stderr tail. */
  error?: string;
}

const IDLE: ServerUpdateStatus = { available: null, state: 'idle' };

let status: ServerUpdateStatus = IDLE;
let settleSink: ((choice: UpdateChoice | null) => void) | null = null;

export function getServerUpdateStatus(): ServerUpdateStatus {
  return status;
}

/**
 * Publish a prompt for `version` and register the sink that resolves the waiting `ask()`.
 * The sink is owned by the prompt, not by this module: it is what enforces first-answer-wins
 * between the SPA dialog and the chat-message fallback.
 */
export function openServerUpdatePrompt(
  version: string,
  settle: (choice: UpdateChoice | null) => void,
): void {
  // A later check (the 24h timer) while a dialog is still up supersedes the earlier one. Resolve
  // the old ask() with null first, or its checkServerUpdate call would wait forever on a promise
  // no button can reach any more.
  const superseded = settleSink;
  settleSink = null;
  superseded?.(null);

  settleSink = settle;
  status = { available: version, state: 'prompting' };
}

/** Answer from the SPA. Returns false when nothing was pending — a stale button. */
export function answerServerUpdatePrompt(choice: UpdateChoice): boolean {
  const settle = settleSink;
  if (!settle) return false;
  settleSink = null;
  settle(choice);
  return true;
}

/**
 * Called by the prompt once EITHER side has answered. `apply` hands over to the install
 * reporters below; anything else (skip / cancel / dismissed) drops back to idle.
 */
export function settleServerUpdatePrompt(choice: UpdateChoice | null): void {
  settleSink = null;
  status = choice === 'apply'
    ? { available: status.available, state: 'installing' }
    : IDLE;
}

/**
 * The npm install exited 0. That means "install finished", NOT "the server is already new":
 * the package's postinstall touches $STORE_DIR/.restart and the daemon respawns app.js when it
 * is idle, so `restarting` is the honest label for the window the SPA has to wait through.
 */
export function reportServerUpdateInstalled(): void {
  status = { available: status.available, state: 'restarting' };
}

export function reportServerUpdateFailed(error: string): void {
  status = { available: status.available, state: 'failed', error };
}

/** Test-only: drop the prompt and the status back to their process-start values. */
export function _resetServerUpdateStatus(): void {
  status = IDLE;
  settleSink = null;
}
