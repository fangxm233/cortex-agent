import { anchorResolves, ownsTranscript, truncateToAnchor } from '@core/transcript-anchor.js';
import type { TurnAnchor } from '@core/types/transcript-anchor.js';
import type { LedgerTurn } from '@store/conversation-ledger-repo.js';

// How a rewind (web edit or platform edit) puts the backend back to where a turn started. Planned
// before anything is mutated, so a turn that cannot be restored is refused instead of silently
// continuing in an empty backend session.

/** `fresh`: nothing precedes the turn, so the next run starts a new backend session.
 *  `anchor`: cut the session's transcript back to where the turn started. */
export type RestorePlan = { kind: 'fresh' } | { kind: 'anchor'; anchor: TurnAnchor };

export interface TranscriptCutter {
  resolves(anchor: TurnAnchor): Promise<boolean>;
  truncate(anchor: TurnAnchor): Promise<boolean>;
}

export const transcriptCutter: TranscriptCutter = { resolves: anchorResolves, truncate: truncateToAnchor };

/**
 * How rewinding to `turnIndex` restores the backend, or null when it cannot. The first turn, or a
 * session the backend never opened, starts fresh. A later turn needs its anchor, still present in
 * the transcript of the backend session the conversation uses now.
 */
export async function planRestore(
  turn: Pick<LedgerTurn, 'anchor'> | undefined,
  turnIndex: number,
  backendSessionId: string | null,
  cutter: TranscriptCutter,
): Promise<RestorePlan | null> {
  if (turnIndex === 0 || !backendSessionId) return { kind: 'fresh' };
  const anchor = turn?.anchor;
  if (!anchor || !ownsTranscript(anchor.file, backendSessionId)) return null;
  return await cutter.resolves(anchor) ? { kind: 'anchor', anchor } : null;
}

/** Apply a plan. False when the transcript changed since planning and could not be cut. */
export async function applyRestore(plan: RestorePlan, cutter: TranscriptCutter): Promise<boolean> {
  return plan.kind === 'fresh' || cutter.truncate(plan.anchor);
}
