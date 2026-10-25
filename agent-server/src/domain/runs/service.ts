import { runRegistry } from '@core/run-registry.js';
import { sessionBenchmarkMaxOutputTokens } from '../benchmark/session-evidence.js';
import * as executionRegistry from '../executions/registry.js';
import { AgentRunImpl, type AgentRun, type RunTerminalInfo } from './run.js';
import type { RunObserver, RunRequest } from './request.js';
import { createRunTelemetry } from '../telemetry/turns.js';

/**
 * Start one agent run: open its execution record, register it for cancellation, and return the
 * `AgentRun` that owns the rest of the lifecycle. This is the single entry point every surface is
 * meant to call.
 *
 * The run opens one attempt on its pooled engine session and feeds every signal through
 * one `RunEvent` stream. `teardownExecution` and the registry removal happen exactly once, from
 * the run's terminal handler.
 */
function withBenchmarkCap(request: RunRequest): RunRequest {
  if (!request.benchmark?.evidenceContext || !request.session.sessionId) return request;
  return { ...request, benchmarkMaxOutputTokens: request.benchmarkMaxOutputTokens
    ?? sessionBenchmarkMaxOutputTokens(request.session.sessionId) };
}

function openExecution(request: RunRequest): { id: string } {
  return executionRegistry.startLocalExecution({
    kind: request.context.executionKind,
    channel: request.context.channel,
    project: request.context.project,
    trigger: request.context.trigger,
    backend: request.selection.backend,
    billingMode: request.selection.mode || 'api',
    sessionId: request.session.sessionId,
    ownerSessionId: request.context.ownerSessionId ?? null,
    label: request.prompt.text.substring(0, 60),
    scheduleTaskId: request.context.scheduleTaskId || null,
  });
}

function closeExecution(executionId: string, info: RunTerminalInfo): void {
  const { status, result, spend, error, durationS } = info;
  executionRegistry.teardownExecution({
    executionId, status, result, spend,
    error: error ? { message: error.message } : null,
    durationS,
  });
  runRegistry.remove(executionId);
}

export function startRun(request: RunRequest, observers: RunObserver[]): AgentRun {
  request = withBenchmarkCap(request);
  const startedAt = Date.now();
  const execution = openExecution(request);
  // Anonymous product telemetry: one more observer, and the terminal facts (no-op when off).
  const telemetry = createRunTelemetry(request);
  const run = new AgentRunImpl({
    request,
    observers: [...observers, telemetry.observer],
    executionId: execution.id,
    registry: runRegistry,
    startedAt,
    onTerminal: (info) => {
      closeExecution(execution.id, info);
      telemetry.finish(info);
    },
  });
  run.start();
  return run;
}
