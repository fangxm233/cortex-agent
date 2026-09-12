// input:  a backgrounded PI `agent` call — its invocation, child runner and owning session
// output: the port types the host implements to register and stop such a run
// pos:    Port for PI's background subagent calls; the daemon implements it in orchestration/
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { SubagentChannel } from '@core/agents/subagent/orchestrate.js';
import type { Invocation, RunChildFn } from '@core/agents/subagent/types.js';

export interface BackgroundSubagentRequest {
  invocation: Invocation;
  runChild: RunChildFn;
  /** Attribution sink for the children, already bound to this `agent` call. */
  channel?: SubagentChannel;
  /** Owning Cortex session and its conduit — where the answer is delivered. */
  sessionId: string | null;
  conduit: string | undefined;
}

export interface BackgroundSubagentHandle {
  id: string;
}

// Types only, by design (D10): registering a run reaches the daemon's subagent registry and its
// delivery route, neither of which an adapter may import. `orchestration/pi-background-subagent.ts`
// implements this port and `domain/runs/adapters.ts` injects it; without it the `agent` tool
// reports that `run_in_background` is unavailable in this session, which is the truth.
export type StartBackgroundSubagent =
  (request: BackgroundSubagentRequest) => Promise<BackgroundSubagentHandle>;
export type StopBackgroundSubagent = (id: string) => Promise<string | null>;
