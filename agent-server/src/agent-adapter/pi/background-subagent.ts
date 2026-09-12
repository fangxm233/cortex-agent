// input:  a backgrounded PI `agent` call — its invocation, child runner and owning session
// output: a registered run id now, and a delivered answer later
// pos:    Default bridge from the PI shim to the daemon's background subagent machinery
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { SubagentChannel } from '@domain/agents/subagent/orchestrate.js';
import type { Invocation, RunChildFn } from '@domain/agents/subagent/types.js';

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

export type StartBackgroundSubagent =
  (request: BackgroundSubagentRequest) => Promise<BackgroundSubagentHandle>;
export type StopBackgroundSubagent = (id: string) => Promise<string | null>;

/**
 * Start a PI `agent` call in the background.
 *
 * The registry is shared with the `agent` MCP tool, so a PI run and a Claude run are the same kind
 * of object — one table, one stop path, one delivery route. The imports are deferred for the same
 * reason `runForeignSubagent` defers its own: the delivery side lives in `orchestration/`, which
 * imports `agent-adapter`, and a static import here would close that loop.
 */
export async function startBackgroundSubagent(
  request: BackgroundSubagentRequest,
): Promise<BackgroundSubagentHandle> {
  const [{ startSubagentRun }, { startBackgroundSubagentRun }] = await Promise.all([
    import('@domain/agents/subagent/registry.js'),
    import('@orch/subagent-delivery.js'),
  ]);
  const view = startBackgroundSubagentRun(onSettled => startSubagentRun({
    invocation: request.invocation,
    sessionId: request.sessionId,
    background: true,
    onSettled,
    // The tool call that started this has already returned, so its own signal is gone; the
    // registry's is the only one that can still stop these children.
    execute: async (signal) => {
      const { runInvocation } = await import('@domain/agents/subagent/orchestrate.js');
      return runInvocation(request.invocation, request.runChild, signal, request.channel);
    },
  }), request.conduit);
  return { id: view.id };
}

/** Stop a run by id. Returns its resulting status, or null when no such run exists. */
export async function stopBackgroundSubagent(id: string): Promise<string | null> {
  const { stopSubagentRun } = await import('@domain/agents/subagent/registry.js');
  return stopSubagentRun(id)?.status ?? null;
}
