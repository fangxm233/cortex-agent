import type { StartBackgroundSubagent, StopBackgroundSubagent } from './background-subagent.js';
import type { RunForeignSubagent } from './subagent.js';

/**
 * What the `agent` tool cannot do on its own.
 *
 * A PI session runs nested `pi` children itself — that is in-process and needs nothing from the
 * host. The other two shapes do: a child on another backend goes through the daemon's runner, and
 * a backgrounded call goes into the daemon's run registry and comes back through its delivery
 * route. Both are domain/orchestration state, so the adapter declares the port and the host fills
 * it (`domain/runs/adapters.ts`). Every member is optional in the sense that an unfilled bridge
 * degrades the tool honestly rather than reaching for a module default (D10).
 */
export interface PiSubagentBridge {
  runForeignSubagent?: RunForeignSubagent;
  startBackgroundSubagent?: StartBackgroundSubagent;
  stopBackgroundSubagent?: StopBackgroundSubagent;
}
