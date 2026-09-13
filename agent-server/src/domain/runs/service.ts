// input:  RunRequest + RunObserver[] and the execution/run registries
// output: the single startRun entry point that opens the execution record and returns an AgentRun
// pos:    domain/runs service — owns the execution bookkeeping call sites used to duplicate (D8).
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { runRegistry } from '@core/run-registry.js';
import * as executionRegistry from '../executions/registry.js';
import { AgentRunImpl, agentConfigFromProfile, type AgentRun } from './run.js';
import type { RunObserver, RunRequest } from './request.js';

/**
 * Start one agent run: open its execution record, register it for cancellation, and return the
 * `AgentRun` that owns the rest of the lifecycle. This is the single entry point every surface is
 * meant to call (P1.5–P1.7 migrate the call sites still on `facade.runAgent`).
 *
 * Phase 1 wraps `facade.runAgent`; the run object installs the continuation sink and feeds every
 * adapter/continuation signal through one `RunEvent` stream. `teardownExecution` and the registry
 * removal happen exactly once, from the run's terminal handler.
 */
export function startRun(request: RunRequest, observers: RunObserver[]): AgentRun {
  const startedAt = Date.now();
  const attemptConfig = agentConfigFromProfile(request.profile);
  const execution = executionRegistry.startLocalExecution({
    kind: request.context.executionKind,
    channel: request.context.channel,
    project: request.context.project,
    trigger: request.context.trigger,
    backend: request.profile.backend,
    billingMode: request.profile.mode || 'api',
    sessionId: request.session.sessionId,
    label: request.prompt.text.substring(0, 60),
    scheduleTaskId: request.context.scheduleTaskId || null,
    threadId: request.context.threadId ?? null,
    agentSlotId: request.benchmark?.agentSlotId ?? null,
  });

  const run = new AgentRunImpl({
    request,
    observers,
    executionId: execution.id,
    attemptConfig,
    registry: runRegistry,
    startedAt,
    onTerminal: ({ status, result, error, durationS }) => {
      executionRegistry.teardownExecution({
        executionId: execution.id,
        status: status === 'cancelled' ? 'cancelled' : status === 'completed' ? 'completed' : 'failed',
        result,
        error: error
          ? { message: error.message }
          : status === 'rate-limited' ? { message: 'Rate limited' } : null,
        durationS,
      });
      runRegistry.remove(execution.id);
    },
  });

  run.start();
  return run;
}
