import { createLogger } from '@core/log.js';
import type { SubagentToolResult } from '@core/agents/subagent/orchestrate.js';
import type { SubagentRunView } from '@domain/agents/subagent/registry.js';
import {
  deliverBackgroundSubagentResult, holdSessionForBackgroundRun,
} from './subagent-delivery.js';

const log = createLogger('subagent-adopt');

/**
 * Adoption: a foreground run whose caller stopped listening is kept alive as a background one.
 *
 * The daemon used to kill those runs, on the reasoning that nobody could receive the answer. That
 * holds only for a run with no session behind it — for every other one the session is still there
 * and delivery works exactly as it does for a run that was backgrounded on purpose. So this module
 * gives an abandoned run the same two things a deliberate background run gets: the hold that keeps
 * its session alive and Stop-able, and the delivery that hands the result back when it lands.
 *
 * Lives beside `subagent-delivery.ts` rather than inside it because the decision is an
 * orchestration one (who can still receive this?) while that module owns the mechanism.
 */
export interface AdoptDeps {
  hold?: typeof holdSessionForBackgroundRun;
  deliver?: typeof deliverBackgroundSubagentResult;
}

interface Adoption {
  /** The hold's release, once installed. Null while it is still being taken. */
  release: (() => void) | null;
  /** The run settled before the hold finished installing — see the note in `adoptForegroundRun`. */
  settledFirst: boolean;
  /** Guards the one release + one delivery this run gets, whichever path reaches them. */
  done: boolean;
}

const adoptions = new Map<string, Adoption>();

/**
 * Take responsibility for a run its foreground caller gave up on. Returns whether it was taken;
 * false means the run should meet its old fate, because nothing here could change it.
 *
 * Refused for a run with no channel or no session: the hold needs a session to hold and delivery
 * needs a channel to deliver to, so adopting one of those would only keep children spending tokens
 * on an answer that lands nowhere.
 */
export function adoptForegroundRun(
  view: SubagentRunView, channel: string | undefined, deps: AdoptDeps = {},
): boolean {
  if (!channel || !view.sessionId) return false;
  // Both the sweep and an explicit detach can reach the same run; the second one is a no-op rather
  // than a second hold nobody would release.
  if (adoptions.has(view.id)) return true;

  const entry: Adoption = { release: null, settledFirst: false, done: false };
  adoptions.set(view.id, entry);
  const hold = (deps.hold ?? holdSessionForBackgroundRun)(view, channel);
  // Installing the hold is not atomic with the decision to adopt, and the run is live throughout —
  // it can settle in between. Same resolution as `startBackgroundSubagentRun`: whichever of the two
  // arrives second performs the release, so the hold is never left standing.
  if (entry.settledFirst) hold();
  else entry.release = hold;
  log.info(`Subagent run ${view.id} adopted into the background for session ${view.sessionId}`);
  return true;
}

/**
 * Close out an adopted run: drop its hold and deliver the result to the session that started it.
 *
 * Wired as the settle hook for every foreground run, so the common case — a run whose caller was
 * there the whole time and already has the answer — is a map miss and nothing else.
 */
export function settleAdoptedRun(
  view: SubagentRunView, result: SubagentToolResult | null, channel: string | undefined,
  deps: AdoptDeps = {},
): void {
  const entry = adoptions.get(view.id);
  if (!entry || entry.done) return;
  entry.done = true;
  adoptions.delete(view.id);
  if (entry.release) entry.release();
  else entry.settledFirst = true;
  (deps.deliver ?? deliverBackgroundSubagentResult)(view, result, channel);
}

/** Test seam: forget every adoption. Releases nothing — a test owns its own holds. */
export function _resetAdoptedRuns(): void {
  adoptions.clear();
}
