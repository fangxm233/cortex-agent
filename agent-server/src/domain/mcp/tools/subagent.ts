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
export const WAIT_REQUEST_TIMEOUT_MS = 40 * 1000;
/**
 * The shortest idle timeout a client is known to enforce: Claude Code aborts an MCP call that has
 * gone 1800s without a response or a progress notification. Cortex raises that knob for the
 * children it spawns itself (`applyClaudeStartupEnv`), but a sidecar cannot count on whichever
 * client it happens to be talking to.
 */
export const CLIENT_IDLE_FLOOR_MS = 30 * 60 * 1000;
/**
 * Outer bound on a foreground `agent` call. Past this the tool hands the run to the background and
 * says so, rather than hanging.
 *
 * It MUST stay strictly under {@link CLIENT_IDLE_FLOOR_MS}, by more than one wait hop: whoever hits
 * their deadline first decides how the call ends, and only this side can end it with a handover.
 * When the client wins, its abort takes away the run's only waiter and the daemon is left to
 * adopt — or, before that path existed, to kill — a run that was still working.
 */
export const FOREGROUND_DEADLINE_MS = 25 * 60 * 1000;

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

/** Hand a run that outlived the foreground deadline to the background, so the work continues and
 *  its result is delivered instead of being abandoned with the caller. Best-effort: a daemon that
 *  refuses the handover leaves the run exactly as it was, and the sweep decides its fate. */
async function detachRun(ctx: CortexToolContext, runId: string): Promise<void> {
  try {
    await proxySubagent(ctx, 'detach', { runId });
  } catch {
    // Reported as "running in the background" either way; the daemon's own sweep is the backstop.
  }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

/**
 * What a handler learns about the call it is serving. Declared structurally rather than imported:
 * only two fields matter here, and the tool must keep working against a caller that supplies
 * neither (the fake server in the tests calls handlers with one argument).
 */
interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void> | void;
}

/**
 * A progress ping per completed hop, when the caller asked to hear about progress.
 *
 * This is the protocol's own answer to a long silent call, and the general form of the fix: a
 * client that watches progress stops counting the call as idle, whatever its timeout is set to.
 * Best-effort by construction — no token, no notification seam, or a transport that refuses the
 * message must never disturb the delegated work.
 */
function hopReporter(extra: ToolExtra | undefined, runId: string): (hops: number) => void {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || !send) return () => {};
  return (hops: number): void => {
    try {
      void Promise.resolve(send({
        method: 'notifications/progress',
        params: { progressToken: token, progress: hops, message: `agent ${runId} still running` },
      })).catch(() => {});
    } catch {
      // A notification seam that throws synchronously is still only a notification.
    }
  };
}

/** Poll the daemon in bounded hops until the run settles or the outer deadline passes. The hops
 *  are also the liveness signal: if this process dies the daemon stops hearing them and adopts
 *  the run into the background rather than letting it answer into the void. */
async function awaitRun(ctx: CortexToolContext, runId: string, onHop: (hops: number) => void = () => {}) {
  const deadline = Date.now() + FOREGROUND_DEADLINE_MS;
  for (let hops = 1; ; hops++) {
    const outcome = await proxySubagent(ctx, 'wait', { runId }, WAIT_REQUEST_TIMEOUT_MS);
    if (outcome.status !== 'running') return outcome;
    if (Date.now() >= deadline) return { ...outcome, timedOut: true };
    onHop(hops);
  }
}

function foregroundText(outcome: any, runId: string): { text: string; isError: boolean } {
  if (outcome.timedOut) {
    const minutes = Math.round(FOREGROUND_DEADLINE_MS / 60_000);
    return {
      text: `Agent ${runId} passed the ${minutes}-minute foreground limit and now runs in the `
        + 'background: it keeps going, and its result will be delivered to you when it lands. '
        + `Stop it with agent_stop("${runId}") if it is no longer useful.`,
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
    async (params: AgentParams, extra?: ToolExtra) => {
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
        const outcome = await awaitRun(ctx, started.id, hopReporter(extra, started.id));
        if (outcome.timedOut) await detachRun(ctx, started.id);
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
