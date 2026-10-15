import type { EngineSelection } from '@domain/agents/engine-selection.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseMcpToolAllowlist, MCP_TOOL_ALLOWLIST_ENV } from '@core/mcp-tool-gate.js';
import { decodeSubagentModels, type SubagentModelOption } from '@core/agents/subagent/catalog.js';
import { requestLoopbackJson } from '@core/loopback-http.js';

/**
 * Everything a Cortex MCP tool needs to know about the session it serves.
 *
 * A stdio entry builds one from its process environment (`toolContextFromEnv`); an in-process
 * host builds one per session directly. Tools must read scope from here and never from
 * `process.env`, because one process may serve many sessions at once.
 */
export interface CortexToolContext {
  /** Chat channel the session is bound to (Slack or Feishu), null for channel-less sessions. */
  channel: string | null;
  sessionId: string | null;
  selection: EngineSelection | null;
  project: string | null;
  backend: string | null;
  /** Daemon's current Claude model (CORTEX_CLAUDE_MODEL), null when the host did not set one. */
  claudeModel: string | null;
  /** PI provider/model pairs the daemon cached; this process cannot scan PI itself. */
  subagentPiModels: SubagentModelOption[];
  /** The Anthropic models the daemon discovered, handed down at spawn. Empty means "the sidecar
   *  falls back to the shipped table". */
  subagentClaudeModels: SubagentModelOption[];
  scheduleTaskId: string | null;
  callbackSource: string | null;
  branchMachine: string | null;
  /** Daemon webhook root, e.g. `http://127.0.0.1:3001`. */
  webhookBaseUrl: string;
  /** Shared secret for the daemon webhook gate (`x-cortex-token`). Empty when unavailable. */
  webhookToken: string;
  /** Bot token for direct Slack uploads; null when the session has no Slack surface. */
  slackBotToken: string | null;
  /** Parsed tool gate: null ⇒ every selected tool registers (fail-open, see mcp-tool-gate). */
  toolAllowlist: ReadonlySet<string> | null;
}

export const DEFAULT_WEBHOOK_PORT = 3001;

function optional(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Build the tool context from the environment a stdio MCP entry was spawned with. Throws for an
 * unparsable or unknown tool allowlist so a misconfigured server refuses to start.
 */
function selectionFromEnv(env: NodeJS.ProcessEnv): EngineSelection | null {
  const backend = env.CORTEX_BACKEND;
  const model = optional(env.CORTEX_MODEL);
  if ((backend !== 'claude' && backend !== 'pi') || !model) return null;
  return {
    backend, model,
    provider: backend === 'pi' ? optional(env.CORTEX_PROVIDER) : null,
    thinking: optional(env.CORTEX_THINKING),
    mode: env.CORTEX_MODE ?? '',
  };
}

export function toolContextFromEnv(env: NodeJS.ProcessEnv = process.env): CortexToolContext {
  return {
    channel: optional(env.SLACK_CHANNEL) ?? optional(env.FEISHU_CHANNEL),
    sessionId: optional(env.CORTEX_SESSION_ID),
    selection: selectionFromEnv(env),
    project: optional(env.CORTEX_PROJECT),
    backend: optional(env.CORTEX_BACKEND),
    claudeModel: optional(env.CORTEX_CLAUDE_MODEL),
    subagentPiModels: decodeSubagentModels(env.CORTEX_SUBAGENT_PI_MODELS),
    subagentClaudeModels: decodeSubagentModels(env.CORTEX_SUBAGENT_CLAUDE_MODELS),
    scheduleTaskId: optional(env.CORTEX_SCHEDULE_TASK_ID),
    callbackSource: optional(env.CORTEX_CALLBACK_SOURCE),
    branchMachine: optional(env.CORTEX_BRANCH_MACHINE),
    webhookBaseUrl: `http://127.0.0.1:${positiveInt(env.WEBHOOK_PORT, DEFAULT_WEBHOOK_PORT)}`,
    webhookToken: env.CORTEX_WEBHOOK_TOKEN || '',
    slackBotToken: optional(env.SLACK_BOT_TOKEN),
    toolAllowlist: parseMcpToolAllowlist(env[MCP_TOOL_ALLOWLIST_ENV]),
  };
}

/** Auth header for every daemon webhook call a tool makes on behalf of its session. */
export function webhookAuthHeaders(ctx: CortexToolContext): Record<string, string> {
  return { 'x-cortex-token': ctx.webhookToken };
}

/** The Web UI session a delivery tool should address: the explicit session id, else the id
 *  encoded in a `web:` channel. Null outside a Web chat session. */
export function webSessionId(ctx: CortexToolContext): string | null {
  if (ctx.sessionId) return ctx.sessionId;
  if (ctx.channel?.startsWith('web:')) return ctx.channel.slice('web:'.length);
  return null;
}

/** The board a session is bound to, as cortex_context reports it. */
export interface BoundBoardInfo {
  id: string;
  title: string;
  /** Absolute board directory; null when the board's project has no context directory. */
  dir: string | null;
}

/** Internal execution scope; channel is omitted from the public MCP response. */
export interface CortexContextInternal {
  channel: string | null;
  sessionId: string | null;
  model: string | null;
  thinking: string | null;
  mode: string | null;
  project: string | null;
  backend: string | null;
  scheduleTaskId: string | null;
  callbackSource: string | null;
  /** Null when the session has no board; absent when the daemon could not be asked. */
  board?: BoundBoardInfo | null;
}

type BoardLookup = (ctx: CortexToolContext, sessionId: string) => Promise<BoundBoardInfo | null>;

/** Ask the daemon which board the session is bound to (this process has no registry). */
const lookupBoard: BoardLookup = async (ctx, sessionId) => {
  const { body } = await requestLoopbackJson(
    'POST', `${ctx.webhookBaseUrl}/webhook/board`, { sessionId, action: 'status' }, webhookAuthHeaders(ctx),
  );
  if (!body?.success) throw new Error(body?.error || 'board status failed');
  const board = body.data;
  if (!board) return null;
  return { id: board.id, title: board.title, dir: board.dir ?? null };
};

/** Resolve the execution scope for MCP callers. Web sessions also get the board they are bound
 *  to; a failed lookup leaves the field out rather than reporting "no board". */
export async function resolveCortexContext(
  ctx: CortexToolContext,
  findBoard: BoardLookup = lookupBoard,
): Promise<CortexContextInternal> {
  const scope: CortexContextInternal = {
    channel: ctx.channel,
    sessionId: ctx.sessionId,
    model: ctx.selection?.model ?? null,
    thinking: ctx.selection?.thinking ?? null,
    mode: ctx.selection?.mode ?? null,
    project: ctx.project,
    backend: ctx.backend,
    scheduleTaskId: ctx.scheduleTaskId,
    callbackSource: ctx.callbackSource,
  };
  const webSession = webSessionId(ctx);
  if (webSession) {
    try {
      scope.board = await findBoard(ctx, webSession);
    } catch {
      // Leave `board` out: the caller can still trust everything else.
    }
  }
  return scope;
}

export function registerContextTools(server: McpServer, ctx: CortexToolContext): void {
  server.tool(
    'cortex_context',
    'Get current session identity, backend, model, thinking, mode, project, bound board and trigger context.',
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const ctxInternal = await resolveCortexContext(ctx);
        // Strip channel from public response — consumers address by project/sessionId.
        const { channel: _channel, ...ctxResponse } = ctxInternal;
        return { content: [{ type: 'text', text: JSON.stringify(ctxResponse, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to resolve context: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
