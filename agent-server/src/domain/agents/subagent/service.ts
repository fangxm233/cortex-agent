// input:  raw `agent` tool parameters plus the calling session's own routing
// output: a registered subagent run, foreground or background
// pos:    Daemon-side entry of the `agent` tool
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { SubagentNotice } from '../../../agent-adapter/pi/event-parser.js';
import { findRole, loadRoles } from '../roles.js';
import { failedChildResult, runInvocation } from './orchestrate.js';
import { resolveInvocation } from './schema.js';
import { startSubagentRun, type SubagentRunView } from './registry.js';
import { runSubagent, type SubagentParentContext } from './runner.js';
import type { RunChildFn } from './types.js';

export interface DaemonSubagentRequest {
  /** Exactly the object the model passed to the tool; validated here, not by the caller. */
  params: unknown;
  background: boolean;
  /** Working directory the children run in. */
  cwd: string;
  parent: SubagentParentContext;
  sessionId: string | null;
  /** Receives every child event for the parent transcript. Absent: the run still completes, it
   *  just shows nothing until it returns. */
  onNotice?: (notice: SubagentNotice) => void;
  /** Called once when the run settles. The background path delivers the result from here. */
  onSettled?: Parameters<typeof startSubagentRun>[0]['onSettled'];
}

/**
 * Validate, resolve roles, and start the run.
 *
 * Throws synchronously for a malformed invocation or an unknown role — a half-run fan-out is worse
 * than none, so nothing is registered until every task is known to be runnable.
 */
export function startDaemonSubagentRun(request: DaemonSubagentRequest): SubagentRunView {
  const invocation = resolveInvocation(request.params);
  const roles = loadRoles();
  for (const task of invocation.tasks) findRole(roles, task.subagent_type);

  return startSubagentRun({
    invocation,
    sessionId: request.sessionId,
    background: request.background,
    onSettled: request.onSettled,
    execute: (signal, runId) => {
      const runChild: RunChildFn = async (task, index, childSignal) => {
        const role = findRole(roles, task.subagent_type);
        // Task → role → the delegating session's own backend, so an unqualified task stays home.
        const backend = task.backend ?? role.backend ?? request.parent.backend;
        try {
          return await runSubagent({
            task, role, backend,
            cwd: request.cwd,
            // The run id stands in for a tool-call id: the MCP tool never learns the backend's own,
            // so the block key the transcript groups on is minted here instead.
            ref: `${runId}#${index}`,
            parent: request.parent,
            signal: childSignal,
            onNotice: request.onNotice,
          });
        } catch (error) {
          if (childSignal?.aborted) throw error;
          return failedChildResult(task, error);
        }
      };
      return runInvocation(invocation, runChild, signal);
    },
  });
}
