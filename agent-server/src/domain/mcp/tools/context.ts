// input:  McpServer, CORTEX_* environment of a stdio entry or a caller-built context, session store
// output: CortexToolContext type + env constructor, cortex_context tool registration
// pos:    Defines the per-session scope every Cortex MCP tool is registered against
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseMcpToolAllowlist, MCP_TOOL_ALLOWLIST_ENV } from '@core/mcp-tool-gate.js';
import { sessionStore } from '@store/session-registry-repo.js';

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
  sessionName: string | null;
  threadId: string | null;
  profile: string | null;
  project: string | null;
  /** Task-scoped project override for in-task agents (takes precedence over `project`). */
  taskProject: string | null;
  backend: string | null;
  scheduleTaskId: string | null;
  callbackSource: string | null;
  branchMachine: string | null;
  /** Daemon webhook root, e.g. `http://127.0.0.1:3001`. */
  webhookBaseUrl: string;
  /** Shared secret for the daemon webhook gate (`x-cortex-token`). Empty when unavailable. */
  webhookToken: string;
  /** How long `ask_manager` blocks before giving up. */
  askManagerTimeoutMs: number;
  /** Bot token for direct Slack uploads; null when the session has no Slack surface. */
  slackBotToken: string | null;
  /** Parsed tool gate: null ⇒ every selected tool registers (fail-open, see mcp-tool-gate). */
  toolAllowlist: ReadonlySet<string> | null;
}

export const DEFAULT_WEBHOOK_PORT = 3001;
export const DEFAULT_ASK_MANAGER_TIMEOUT_MS = 1_800_000;

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
export function toolContextFromEnv(env: NodeJS.ProcessEnv = process.env): CortexToolContext {
  return {
    channel: optional(env.SLACK_CHANNEL) ?? optional(env.FEISHU_CHANNEL),
    sessionId: optional(env.CORTEX_SESSION_ID),
    sessionName: optional(env.CORTEX_SESSION_NAME),
    threadId: optional(env.CORTEX_THREAD_ID),
    profile: optional(env.CORTEX_PROFILE),
    project: optional(env.CORTEX_PROJECT),
    taskProject: optional(env.CORTEX_TASK_PROJECT),
    backend: optional(env.CORTEX_BACKEND),
    scheduleTaskId: optional(env.CORTEX_SCHEDULE_TASK_ID),
    callbackSource: optional(env.CORTEX_CALLBACK_SOURCE),
    branchMachine: optional(env.CORTEX_BRANCH_MACHINE),
    webhookBaseUrl: `http://127.0.0.1:${positiveInt(env.WEBHOOK_PORT, DEFAULT_WEBHOOK_PORT)}`,
    webhookToken: env.CORTEX_WEBHOOK_TOKEN || '',
    askManagerTimeoutMs: positiveInt(env.CORTEX_ASK_MANAGER_TIMEOUT_MS, DEFAULT_ASK_MANAGER_TIMEOUT_MS),
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

/** Internal context — includes channel for downstream consumers (schedule.ts session/thread
 *  target resolution). Not exposed via MCP. */
interface CortexContextInternal {
  channel: string | null;
  sessionId: string | null;
  sessionName: string | null;
  threadId: string | null;
  profile: string | null;
  project: string | null;
  backend: string | null;
  scheduleTaskId: string | null;
  callbackSource: string | null;
}

/** Resolve the execution scope for MCP callers, filling in the session name from the registry
 *  when the host only knew the session id. */
export async function resolveCortexContext(ctx: CortexToolContext): Promise<CortexContextInternal> {
  let sessionName = ctx.sessionName;
  if (!sessionName && ctx.sessionId) {
    sessionName = await sessionStore.lookupBySessionId(ctx.sessionId);
  }
  return {
    channel: ctx.channel,
    sessionId: ctx.sessionId,
    sessionName,
    threadId: ctx.threadId,
    profile: ctx.profile,
    project: ctx.project,
    backend: ctx.backend,
    scheduleTaskId: ctx.scheduleTaskId,
    callbackSource: ctx.callbackSource,
  };
}

export function registerContextTools(server: McpServer, ctx: CortexToolContext): void {
  server.tool(
    'cortex_context',
    'Return the current Cortex execution context: sessionId, sessionName (cortex-XXXX), threadId, profile, project, backend. Use this to discover the current scope before calling cortex_schedule_add with target=current-project/current-thread.',
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const ctxInternal = await resolveCortexContext(ctx);
        // Strip channel from public response — consumers address by project/sessionId/threadId.
        const { channel: _channel, ...ctxResponse } = ctxInternal;
        return { content: [{ type: 'text', text: JSON.stringify(ctxResponse, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to resolve context: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
