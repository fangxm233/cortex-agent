// input:  MCP server, session tool context, daemon webhook proxy
// output: the `agent` and `agent_stop` tools
// pos:    Delegation surface for a backend that has no native subagent Cortex can see
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { MAX_SUBAGENT_TASKS, SUBAGENT_DESCRIPTION } from '@core/agents/subagent/schema.js';
import {
  claudeModelOptions, describeSubagent, roleOptionsFrom, type SubagentFieldDescriptions,
} from '@core/agents/subagent/catalog.js';
import { loadRoles } from '@core/agents/roles.js';
import { webhookAuthHeaders, type CortexToolContext } from './context.js';

/** One `wait` hop. Slightly longer than the daemon's own slice so the daemon, not the socket,
 *  decides when a hop ends. */
const WAIT_REQUEST_TIMEOUT_MS = 40 * 1000;
/** Outer bound on a foreground `agent` call. Past this the tool returns and names the run id, so
 *  the model can keep working and collect it with `agent_stop`-style follow-up rather than hang. */
const FOREGROUND_DEADLINE_MS = 30 * 60 * 1000;

/** Build the agent shape from the host's live catalog. The descriptions name the real roles and
 *  models this sidecar can reach; an empty catalog reproduces the shipped static strings. */
function buildAgentShape(described: SubagentFieldDescriptions) {
  const modelField = () => z.string().optional().describe(described.model);
  const backendField = () => z.enum(['claude', 'pi']).optional().describe(described.backend);
  const taskSchema = z.object({
    description: z.string().describe('Short description of the delegated task.'),
    prompt: z.string().describe('Complete task prompt for the subagent.'),
    subagent_type: z.string().describe(described.subagentType),
    model: modelField(),
    backend: backendField(),
  });

  /** Single mode's fields are all optional here because the three modes are mutually exclusive; the
   *  daemon validates which combination was actually supplied (`resolveInvocation`). */
  return {
    description: z.string().optional().describe('Short description for single mode.'),
    prompt: z.string().optional().describe('Complete prompt for single mode.'),
    subagent_type: z.string().optional().describe(described.subagentTypeSingle),
    model: modelField(),
    backend: backendField(),
    parallel: z.array(taskSchema).min(1).max(MAX_SUBAGENT_TASKS).optional()
      .describe('Tasks to execute concurrently.'),
    chain: z.array(taskSchema).min(1).max(MAX_SUBAGENT_TASKS).optional()
      .describe('Tasks to execute sequentially; {previous} inserts the prior output.'),
    run_in_background: z.boolean().optional()
      .describe('Return an agent_id immediately and deliver the result when it is ready, instead of '
        + 'blocking this tool call. Use for long work you can carry on without.'),
  };
}

/** Read the live catalog once per registration. Guarded end to end: a filesystem or parsing
 *  surprise must degrade to the static descriptions rather than kill tool registration. */
function describeHostCatalog(ctx: CortexToolContext): SubagentFieldDescriptions {
  try {
    return describeSubagent({
      roles: roleOptionsFrom(loadRoles()),
      models: [...claudeModelOptions(ctx.claudeModel), ...ctx.subagentPiModels],
    });
  } catch {
    return describeSubagent({});
  }
}

type AgentParams = { run_in_background?: boolean } & Record<string, unknown>;

async function proxySubagent(
  ctx: CortexToolContext,
  action: string,
  payload: Record<string, unknown>,
  timeoutMs?: number,
): Promise<any> {
  const { body } = await requestLoopbackJson(
    'POST',
    `${ctx.webhookBaseUrl}/webhook/subagent`,
    { action, sessionId: ctx.sessionId, ...payload },
    webhookAuthHeaders(ctx),
    timeoutMs,
  );
  if (!body?.success) throw new Error(body?.error || `subagent ${action} failed`);
  return body.data;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

/** Poll the daemon in bounded hops until the run settles or the outer deadline passes. The hops
 *  are also the liveness signal: if this process dies the daemon stops hearing them and abandons
 *  the run rather than letting orphaned children spend tokens. */
async function awaitRun(ctx: CortexToolContext, runId: string) {
  const deadline = Date.now() + FOREGROUND_DEADLINE_MS;
  for (;;) {
    const outcome = await proxySubagent(ctx, 'wait', { runId }, WAIT_REQUEST_TIMEOUT_MS);
    if (outcome.status !== 'running') return outcome;
    if (Date.now() >= deadline) return { ...outcome, timedOut: true };
  }
}

function foregroundText(outcome: any, runId: string): { text: string; isError: boolean } {
  if (outcome.timedOut) {
    return {
      text: `Agent ${runId} is still running after 30 minutes. It keeps going; stop it with agent_stop if it is no longer useful.`,
      isError: false,
    };
  }
  if (outcome.status === 'completed') return { text: outcome.text ?? '(no output)', isError: false };
  if (outcome.status === 'stopped') return { text: `Agent ${runId} was stopped.`, isError: true };
  return { text: `Agent ${runId} failed: ${outcome.error ?? 'unknown error'}`, isError: true };
}

export function registerSubagentTools(server: McpServer, ctx: CortexToolContext): void {
  const agentShape = buildAgentShape(describeHostCatalog(ctx));
  server.tool(
    'agent',
    `${SUBAGENT_DESCRIPTION} Each child is isolated: it has its own context, its own role prompt, `
    + 'and no delegation tools of its own, so it cannot spawn further subagents.',
    agentShape,
    async (params: AgentParams) => {
      try {
        const { run_in_background: background, ...toolParams } = params;
        const started = await proxySubagent(ctx, 'start', {
          params: toolParams,
          background: !!background,
          cwd: process.cwd(),
          // The parent's own scope: it decides where children run and what routing they inherit.
          profile: ctx.profile,
          project: ctx.taskProject ?? ctx.project,
          channel: ctx.channel,
          backend: ctx.backend,
        });
        if (background) {
          return textResult(
            `Agent ${started.id} started in the background. Its result will be delivered to you `
            + `when it is ready. Stop it early with agent_stop("${started.id}").`,
          );
        }
        const outcome = await awaitRun(ctx, started.id);
        const { text, isError } = foregroundText(outcome, started.id);
        return textResult(text, isError);
      } catch (error) {
        return textResult(`agent error: ${(error as Error).message}`, true);
      }
    },
  );

  server.tool(
    'agent_stop',
    'Stop a running subagent by the agent_id you were given. Whatever the children had produced is '
    + 'discarded — use it when the delegated work is no longer wanted, not to collect a result.',
    { agent_id: z.string().describe('The agent_id returned when the subagent was started.') },
    async ({ agent_id }: { agent_id: string }) => {
      try {
        const view = await proxySubagent(ctx, 'stop', { runId: agent_id });
        return textResult(`Agent ${view.id} is now ${view.status}.`);
      } catch (error) {
        return textResult(`agent_stop error: ${(error as Error).message}`, true);
      }
    },
  );
}
