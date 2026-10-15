import { sessionStore } from '@store/session-registry-repo.js';
import {
  detachSubagentRun, stopSubagentRun, waitForSubagentRun,
  type SubagentRunView,
} from '@domain/agents/subagent/registry.js';
import { startDaemonSubagentRun } from '@domain/agents/subagent/service.js';
import { adoptForegroundRun, settleAdoptedRun } from './subagent-adopt.js';
import { backgroundNoticeSink, parentNoticeSink } from './subagent-attribution.js';
import { startBackgroundSubagentRun } from './subagent-delivery.js';
import type { SubagentParentContext } from '@domain/agents/subagent/runner.js';
import type { SubagentToolResult } from '@core/agents/subagent/orchestrate.js';
import { resolveRunSelection } from '@domain/runs/config-resolver.js';

export interface SubagentWebhookReply {
  success: boolean;
  data?: unknown;
  error?: string;
}

/** The parent's materialized choice supplies routing, not the child's task/role model. */
async function parentContextFor(data: Record<string, any>): Promise<SubagentParentContext> {
  const channel = typeof data.channel === 'string' ? data.channel : undefined;
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
  const session = sessionId ? await sessionStore.getById(sessionId) : null;
  const selection = resolveRunSelection({ channel, session, selection: data.selection });
  return {
    ...selection, channel, sessionId,
    project: typeof data.project === 'string' ? data.project : undefined,
    env: process.env,
  };
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
      const parent = await parentContextFor(data);
      const background = !!data.background;
      const request = {
        params: data.params,
        background,
        cwd: typeof data.cwd === 'string' && data.cwd ? data.cwd : process.cwd(),
        parent,
        sessionId,
        // Explicit background work never belongs to the parent's active run. Foreground calls
        // retain live ingestion and the detached fallback used by adoption.
        onNotice: background
          ? backgroundNoticeSink(sessionId, parent.channel)
          : parentNoticeSink(sessionId, parent.channel),
      };
      // A foreground run needs no hold and no delivery while its caller is there: that caller is
      // blocked on `wait`, which holds the turn open by itself, and the answer comes back as that
      // call's tool result. The two hooks below only come into play once the caller is gone — they
      // turn a run that would have been killed into a background one, result and all.
      const view = background
        ? startBackgroundSubagentRun(
          onSettled => startDaemonSubagentRun({ ...request, onSettled }), parent.channel,
        )
        : startDaemonSubagentRun({
          ...request,
          onAbandon: abandoned => adoptForegroundRun(abandoned, parent.channel),
          onSettled: (settled, result) => settleAdoptedRun(settled, result, parent.channel),
        });
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
    if (data.action === 'detach') {
      // The foreground tool giving up on its own deadline, ahead of the abandonment sweep.
      const view = detachSubagentRun(String(data.runId ?? ''));
      if (!view) return { success: false, error: `no such agent run: ${data.runId}` };
      return { success: true, data: { id: view.id, status: view.status } };
    }
    return { success: false, error: `unknown subagent action: ${data.action}` };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}
