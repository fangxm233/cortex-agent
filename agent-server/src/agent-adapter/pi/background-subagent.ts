import type { SubagentChannel } from '@core/agents/subagent/orchestrate.js';
import type { Invocation, RunChildFn, SubagentNotice } from '@core/agents/subagent/types.js';

export interface BackgroundSubagentRequest {
  invocation: Invocation;
  /** The host supplies one session-bound sink before any child starts. All notice producers
   *  (native events, foreign events and terminal seals) must bind to it, never the parent runtime. */
  bindNoticeSink(onNotice: (notice: SubagentNotice) => void): {
    runChild: RunChildFn;
    channel?: SubagentChannel;
  };
  /** Original tool-call identity used by the runner and attribution channel, not the registry ID. */
  toolCallId: string;
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
