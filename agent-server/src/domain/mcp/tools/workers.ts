import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { describeModelCatalog, type ModelFieldBases } from '@core/agents/subagent/catalog.js';
import { webhookAuthHeaders, type CortexToolContext } from './context.js';
import { hostModelOptions } from './subagent.js';

/** Every worker tool returns at once; the daemon answers within this bound. */
const TEAM_REQUEST_TIMEOUT_MS = 30 * 1000;

async function proxyTeam(ctx: CortexToolContext, action: string, payload: Record<string, unknown>): Promise<any> {
  const { body } = await requestLoopbackJson(
    'POST',
    `${ctx.webhookBaseUrl}/webhook/team`,
    { action, sessionId: ctx.sessionId, ...payload },
    webhookAuthHeaders(ctx),
    TEAM_REQUEST_TIMEOUT_MS,
  );
  if (!body?.success) throw new Error(body?.error || `${action} failed`);
  return body.data;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

const NON_BLOCKING = 'Returns immediately; reports and questions arrive as messages. '
  + 'After dispatch, end your turn; do not wait or poll.';

const WORKER_MODEL_FIELD_BASES: ModelFieldBases = {
  model: 'Model override: pi provider/model[:thinking], claude model ID. '
    + 'Default: your model on the same backend, otherwise that backend\'s default.',
  backend: 'Backend override. Default: your backend.',
};

function workerCatalog(ctx: CortexToolContext): string {
  try { return describeModelCatalog(hostModelOptions(ctx)); }
  catch { return ''; }
}

/** One handler shape for every team tool: proxy, then render the daemon's text or the error. */
function handler<P extends Record<string, unknown>>(ctx: CortexToolContext, action: string) {
  return async (params: P) => {
    try {
      const data = await proxyTeam(ctx, action, params);
      return textResult(typeof data?.text === 'string' ? data.text : JSON.stringify(data, null, 2));
    } catch (error) {
      return textResult(`${action} error: ${(error as Error).message}`, true);
    }
  };
}

export function registerWorkerTools(server: McpServer, ctx: CortexToolContext): void {
  const described = WORKER_MODEL_FIELD_BASES;
  server.tool(
    'worker_spawn',
    'Start a persistent, isolated session with full tools for follow-up or long-running work. '
    + 'Use for multiple/splittable tasks or a new task; keep single tasks here. '
    + 'For bounded work whose result you need now, use agent. Provide a self-contained prompt; '
    + 'workers cannot see this conversation. The user can talk to them directly. '
    + 'Final replies report back except routine updates; questions and approvals route to you '
    + `(worker_answer). ${NON_BLOCKING}${workerCatalog(ctx)}`,
    {
      name: z.string().describe('Unique slug: lowercase letters, digits, hyphens; max 32 characters.'),
      prompt: z.string().describe('Complete, self-contained task for the worker.'),
      backend: z.enum(['claude', 'pi']).optional().describe(described.backend),
      model: z.string().optional().describe(described.model),
    },
    handler(ctx, 'spawn'),
  );

  server.tool(
    'worker_send',
    'Continue or redirect a worker; injects into a running turn or starts a new one. '
    + 'Revives retired workers. Reuse a relevant worker rather than spawning another. '
    + NON_BLOCKING,
    {
      worker: z.string().describe('The worker name.'),
      message: z.string().describe('The message to deliver.'),
    },
    handler(ctx, 'send'),
  );

  server.tool(
    'worker_list',
    'List your workers, or inspect one with its full last report. Completion reports arrive automatically.',
    { worker: z.string().optional().describe('A worker name for its detail view.') },
    handler(ctx, 'list'),
  );

  server.tool(
    'worker_stop',
    'Stop a worker\'s current turn. With retire=true it also leaves the roster (worker_send revives it).',
    {
      worker: z.string().describe('The worker name.'),
      retire: z.boolean().optional().describe('Also retire the worker.'),
    },
    handler(ctx, 'stop'),
  );

  server.tool(
    'worker_answer',
    'Answer a worker question or approve/reject its plan or commission. Ask cortex_ask_user '
    + 'first if unsure of user intent. The user may also answer; first answer wins.',
    {
      request_id: z.string().describe('The request_id from the worker notice.'),
      answers: z.record(z.string(), z.string()).optional().describe('Exact question text → answer, for a question.'),
      approved: z.boolean().optional().describe('Approve or reject a plan/commission.'),
      feedback: z.string().optional().describe('Feedback for the worker, mainly when rejecting a plan.'),
    },
    handler(ctx, 'answer'),
  );
}

/** The one tool a worker gets: mark its current turn routine so its reply does not wake the lead. */
export function registerWorkerReportTools(server: McpServer, ctx: CortexToolContext): void {
  server.tool(
    'mark_routine',
    'Before your final reply, mark a no-change or duplicate update so it does not wake the lead. '
    + 'Never use for results, milestones, failures, blockers, or needed action. '
    + 'Ask for decisions with cortex_ask_user.',
    {},
    handler(ctx, 'routine'),
  );
}
