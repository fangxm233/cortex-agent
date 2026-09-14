import { runInvocation } from '@core/agents/subagent/orchestrate.js';
import { startSubagentRun, stopSubagentRun } from '@domain/agents/subagent/registry.js';
import type {
  BackgroundSubagentHandle, BackgroundSubagentRequest,
} from '../agent-adapter/pi/background-subagent.js';
import { startBackgroundSubagentRun } from './subagent-delivery.js';

/**
 * Start a PI `agent` call in the background.
 *
 * The registry is shared with the `agent` MCP tool, so a PI run and a Claude run are the same kind
 * of object — one table, one stop path, one delivery route.
 *
 * This used to live in `agent-adapter/pi/background-subagent.ts` behind deferred imports, because
 * the delivery side lives here in `orchestration/`, which imports `agent-adapter`, and a static
 * import from there would have closed that loop. Implemented on this side (D10) the imports are
 * ordinary: `domain/runs/adapters.ts` passes the bridge to the adapter at construction.
 */
export async function startBackgroundSubagent(
  request: BackgroundSubagentRequest,
): Promise<BackgroundSubagentHandle> {
  const view = startBackgroundSubagentRun(onSettled => startSubagentRun({
    invocation: request.invocation,
    sessionId: request.sessionId,
    background: true,
    onSettled,
    // The tool call that started this has already returned, so its own signal is gone; the
    // registry's is the only one that can still stop these children.
    execute: async (signal) =>
      runInvocation(request.invocation, request.runChild, signal, request.channel),
  }), request.conduit);
  return { id: view.id };
}

/** Stop a run by id. Returns its resulting status, or null when no such run exists. */
export async function stopBackgroundSubagent(id: string): Promise<string | null> {
  return stopSubagentRun(id)?.status ?? null;
}
