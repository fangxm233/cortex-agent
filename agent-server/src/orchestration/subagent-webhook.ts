// input:  /webhook/subagent payloads from an MCP sidecar
// output: start / wait / stop / list answers for the daemon's subagent registry
// pos:    Daemon side of the `agent` MCP tool
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createLogger } from '@core/log.js';
import type { Backend } from '../agent-adapter/types.js';
import { getActiveBackend, getClaudeMode, getClaudeModel } from '@domain/agents/config.js';
import { resolveProfileConfig } from '@domain/agents/profile-manager.js';
import {
  getSubagentRun, listSubagentRuns, stopSubagentRun, waitForSubagentRun,
  type SubagentRunView,
} from '@domain/agents/subagent/registry.js';
import { startDaemonSubagentRun } from '@domain/agents/subagent/service.js';
import { parentNoticeSink } from './subagent-attribution.js';
import { startBackgroundSubagentRun } from './subagent-delivery.js';
import type { SubagentParentContext } from '@domain/agents/subagent/runner.js';
import type { SubagentToolResult } from '@domain/agents/subagent/orchestrate.js';

const log = createLogger('subagent-webhook');

export interface SubagentWebhookReply {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * The delegating session's own routing, reconstructed from what its MCP sidecar knows about it.
 *
 * The profile is read only to learn what the PARENT is running — it never selects the child, which
 * takes its model from the task or the role. When there is no profile the daemon's current Claude
 * model and mode stand in, which is the same pair an unprofiled turn would have used.
 */
function parentContextFor(data: Record<string, any>): SubagentParentContext {
  const profile = resolveProfileSafely(data.profile);
  const backend = (profile?.backend ?? data.backend ?? getActiveBackend()) as Backend;
  const isClaude = backend === 'claude';
  return {
    backend,
    mode: profile?.mode ?? (isClaude ? getClaudeMode() : null),
    provider: profile?.provider ?? null,
    model: profile?.model ?? (isClaude ? getClaudeModel() : null),
    channel: typeof data.channel === 'string' ? data.channel : undefined,
    project: typeof data.project === 'string' ? data.project : undefined,
    cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
    env: process.env,
  };
}

function resolveProfileSafely(name: unknown) {
  if (typeof name !== 'string' || !name) return null;
  try {
    return resolveProfileConfig(name);
  } catch (error) {
    log.warn(`Subagent parent profile "${name}" could not be resolved: ${(error as Error).message}`);
    return null;
  }
}

function resultText(result: SubagentToolResult | null): string {
  return result?.content?.map(block => block.text).join('\n') || '(no output)';
}

function outcomeReply(view: SubagentRunView, result: SubagentToolResult | null): SubagentWebhookReply {
  return {
    success: true,
    data: {
      id: view.id,
      status: view.status,
      error: view.error,
      ...(view.status === 'completed' ? { text: resultText(result) } : {}),
    },
  };
}

export async function handleSubagentWebhook(data: Record<string, any>): Promise<SubagentWebhookReply> {
  const sessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null;
  try {
    if (data.action === 'start') {
      const parent = parentContextFor(data);
      const background = !!data.background;
      const request = {
        params: data.params,
        background,
        cwd: typeof data.cwd === 'string' && data.cwd ? data.cwd : process.cwd(),
        parent,
        sessionId,
        // Resolved once per run, at the moment the parent is provably mid-turn. A background run
        // that outlives the turn simply stops being able to push; delivery takes over from there.
        onNotice: parentNoticeSink(sessionId, parent.channel),
      };
      // A foreground run needs no hold and no delivery: its caller is blocked on `wait`, which
      // holds the turn open by itself, and the answer comes back as that call's tool result.
      const view = background
        ? startBackgroundSubagentRun(
          onSettled => startDaemonSubagentRun({ ...request, onSettled }), parent.channel,
        )
        : startDaemonSubagentRun(request);
      return { success: true, data: { id: view.id, status: view.status } };
    }
    if (data.action === 'wait') {
      const outcome = await waitForSubagentRun(String(data.runId ?? ''));
      if (!outcome) return { success: false, error: `no such agent run: ${data.runId}` };
      return outcomeReply(outcome.view, outcome.result);
    }
    if (data.action === 'stop') {
      const view = stopSubagentRun(String(data.runId ?? ''));
      if (!view) return { success: false, error: `no such agent run: ${data.runId}` };
      return { success: true, data: { id: view.id, status: view.status } };
    }
    if (data.action === 'status') {
      const view = getSubagentRun(String(data.runId ?? ''));
      if (!view) return { success: false, error: `no such agent run: ${data.runId}` };
      return { success: true, data: view };
    }
    if (data.action === 'list') {
      return { success: true, data: { runs: listSubagentRuns(sessionId) } };
    }
    return { success: false, error: `unknown subagent action: ${data.action}` };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}
