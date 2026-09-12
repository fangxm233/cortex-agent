// input:  core/run-registry.ts (RunRegistry class + runRegistry singleton)
// output: BgHeldSessions / SessionStatusEvent types and the bgHeldSessions singleton alias
// pos:    core/ compatibility shim — delegates to run-registry (P1.9 deletes it)
// >>> If updated, update this header and folder CORTEX.md <<<
//
// P1.2 absorbed the background-hold state into core/run-registry.ts. This module is a thin shim:
// `BgHeldSessions` is the RunRegistry class (so `new BgHeldSessions()` still yields an isolated
// registry for tests) and `bgHeldSessions` is the shared runRegistry singleton. The hold surface
// (onSessionStatus / has / listIds / sessionsOnChannel / setAbort / abort / clear) is unchanged.

import { runRegistry, RunRegistry } from './run-registry.js';

export type { SessionStatusEvent } from './run-registry.js';

/** @deprecated P1.2 shim for core/run-registry.ts's RunRegistry. */
export { RunRegistry as BgHeldSessions };

/** Singleton instance (one server process = one registry). */
export const bgHeldSessions = runRegistry;
