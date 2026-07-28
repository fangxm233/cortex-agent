// input:  McpServer, CORTEX_* environment, session store
// output: cortex_context tool registration
// pos:    Resolves the current agent execution scope for MCP callers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sessionStore } from '@store/session-registry-repo.js';

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

/** Public context returned by the cortex_context MCP tool. No channel — consumers
 *  address by project/sessionId/threadId instead. */
interface CortexContextResponse {
  sessionId: string | null;
  sessionName: string | null;
  threadId: string | null;
  profile: string | null;
  project: string | null;
  backend: string | null;
  scheduleTaskId: string | null;
  callbackSource: string | null;
}

/** Resolve the Cortex execution context from the environment set for the MCP process. */
export async function resolveCortexContext(): Promise<CortexContextInternal> {
  const sessionId = process.env.CORTEX_SESSION_ID ?? null;
  let sessionName = process.env.CORTEX_SESSION_NAME ?? null;
  if (!sessionName && sessionId) {
    sessionName = await sessionStore.lookupBySessionId(sessionId);
  }
  return {
    channel: process.env.SLACK_CHANNEL ?? process.env.FEISHU_CHANNEL ?? null,
    sessionId,
    sessionName,
    threadId: process.env.CORTEX_THREAD_ID ?? null,
    profile: process.env.CORTEX_PROFILE ?? null,
    project: process.env.CORTEX_PROJECT ?? null,
    backend: process.env.CORTEX_BACKEND ?? null,
    scheduleTaskId: process.env.CORTEX_SCHEDULE_TASK_ID ?? null,
    callbackSource: process.env.CORTEX_CALLBACK_SOURCE ?? null,
  };
}

export function registerContextTools(server: McpServer): void {
  server.tool(
    'cortex_context',
    'Return the current Cortex execution context: sessionId, sessionName (cortex-XXXX), threadId, profile, project, backend. Use this to discover the current scope before calling cortex_schedule_add with target=current-project/current-thread.',
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const ctxInternal = await resolveCortexContext();
        // Strip channel from public response — consumers address by project/sessionId/threadId.
        const { channel: _channel, ...ctxResponse } = ctxInternal;
        return { content: [{ type: 'text', text: JSON.stringify(ctxResponse, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to resolve context: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
