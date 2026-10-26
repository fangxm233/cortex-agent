import type { SubagentNotice } from '@core/agents/subagent/types.js';
import { findRole, loadRoles } from '@core/agents/roles.js';
import { endStatusOf, failedChildResult, runInvocation } from '@core/agents/subagent/orchestrate.js';
import { subagentEndNotice } from '@core/agents/subagent/attribution.js';
import type { SubagentEndStatus } from '@core/agents/subagent/types.js';
import { resolveInvocation } from '@core/agents/subagent/schema.js';
import { startSubagentRun, trackSubagentChildren, type SubagentRunView } from './registry.js';
import { runSubagent, type SubagentParentContext } from './runner.js';
import type { RunChildFn, SubagentTask } from '@core/agents/subagent/types.js';
import { openChildWorkspace, prepareCleanTasks, withWorkspaceNote } from '@core/agents/subagent/workspace.js';
import type { AgentRole } from '@core/agents/roles.js';
import type { Backend } from '@core/types/agent-types.js';

export interface DaemonSubagentRequest {
  /** Exactly the object the model passed to the tool; validated here, not by the caller. */
  params: unknown;
  background: boolean;
  /** Working directory the children run in. */
  cwd: string;
  /** The delegating session's workspace when that session is clean: its children are clean and
   *  work there too. */
  parentWorkspace?: string | null;
  parent: SubagentParentContext;
  sessionId: string | null;
  /** Receives every child event for the parent transcript. Absent: the run still completes, it
   *  just shows nothing until it returns. */
  onNotice?: (notice: SubagentNotice) => void;
  /** Called once when the run settles. The background path delivers the result from here. */
  onSettled?: Parameters<typeof startSubagentRun>[0]['onSettled'];
  /** Called when a foreground run loses its last waiter. See StartSubagentRunOptions.onAbandon. */
  onAbandon?: Parameters<typeof startSubagentRun>[0]['onAbandon'];
}

/**
 * Validate, resolve roles, and start the run.
 *
 * Throws synchronously for a malformed invocation, an unknown role or a missing `files` path — a
 * half-run fan-out is worse than none, so nothing is registered until every task is known to be
 * runnable.
 */
export function startDaemonSubagentRun(request: DaemonSubagentRequest): SubagentRunView {
  const invocation = prepareCleanTasks(resolveInvocation(request.params), {
    cwd: request.cwd, parentWorkspace: request.parentWorkspace ?? null,
  });
  const roles = loadRoles();
  for (const task of invocation.tasks) findRole(roles, task.subagent_type);

  return startSubagentRun({
    invocation,
    sessionId: request.sessionId,
    background: request.background,
    onSettled: request.onSettled,
    onAbandon: request.onAbandon,
    execute: (signal, runId) => runInvocation(
      invocation, trackSubagentChildren(runId, index => `${runId}#${index}`, childRunner(request, roles, runId)), signal,
    ),
  });
}

/**
 * Seal the child's transcript block the moment it settles. Nothing else can: this child is not one
 * of the backend's own tasks, so no task lifecycle reports it, and the parent's next row proves
 * nothing (a backgrounded child runs beside the parent). Every exit goes through here — including
 * the failures and aborts that produce no rows at all.
 */
function childSealer(
  request: DaemonSubagentRequest, ref: string, task: SubagentTask, backend: Backend,
): (status: SubagentEndStatus) => void {
  return (status) => {
    try { request.onNotice?.(subagentEndNotice(ref, task, backend, status)); }
    catch { /* attribution is best-effort; the run itself must not fail for it */ }
  };
}

function childRunner(request: DaemonSubagentRequest, roles: AgentRole[], runId: string): RunChildFn {
  return async (task, index, childSignal) => {
    const role = findRole(roles, task.subagent_type);
    // Task → role → the delegating session's own backend, so an unqualified task stays home.
    const backend = task.backend ?? role.backend ?? request.parent.backend;
    // The run id stands in for a tool-call id: the MCP tool never learns the backend's own,
    // so the block key the transcript groups on is minted here instead.
    const ref = `${runId}#${index}`;
    const seal = childSealer(request, ref, task, backend);
    let workspace: string | null = null;
    try {
      // Only a clean child waits on its folder: an ordinary one starts in this same tick, as before.
      if (task.clean) workspace = await openChildWorkspace(task, { parentWorkspace: request.parentWorkspace ?? null, runId, index });
      const result = await runSubagent({
        task, role, backend, cwd: workspace ?? request.cwd, workspace, ref,
        // The delegating session rides along so the child's spend can be rolled up into that
        // session's totals — see SubagentParentContext.sessionId.
        parent: { ...request.parent, sessionId: request.sessionId },
        signal: childSignal,
        onNotice: request.onNotice,
      });
      seal(childSignal?.aborted ? 'killed' : endStatusOf(result));
      return withWorkspaceNote(result, workspace);
    } catch (error) {
      if (childSignal?.aborted) { seal('killed'); throw error; }
      seal('failed');
      return withWorkspaceNote(failedChildResult(task, error), workspace);
    }
  };
}
