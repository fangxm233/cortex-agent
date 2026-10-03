import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { webhookAuthHeaders, type CortexToolContext } from './context.js';

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

const NON_BLOCKING = 'Returns immediately. Worker reports and questions arrive later as new messages '
  + 'in this conversation; after dispatching work, end your turn instead of waiting or polling.';

/** One handler shape for all five tools: proxy, then render the daemon's text or the error. */
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
  server.tool(
    'worker_spawn',
    'Start a persistent worker: a separate session with its own context and full tool surface, '
    + 'which you can continue later with worker_send. Use a worker for work that may need follow-up, '
    + 'runs long, or may need back-and-forth. For bounded reconnaissance or verification whose result '
    + 'you consume immediately, use the one-shot `agent` tool instead. Write a self-contained prompt: '
    + 'the worker does not see this conversation. The user can open the worker and talk to it directly. '
    + 'Each worker turn reports back to you with its final reply; its questions and plan approvals are '
    + `routed to you (answer with worker_answer). ${NON_BLOCKING}`,
    {
      name: z.string().describe('Short unique slug for this worker, e.g. "api-refactor" (lowercase letters, digits, hyphens; max 32).'),
      prompt: z.string().describe('Complete, self-contained task for the worker.'),
      profile: z.string().optional().describe('Profile to run the worker on; defaults to your own.'),
    },
    handler(ctx, 'spawn'),
  );

  server.tool(
    'worker_send',
    'Send a message to one of your workers: continue its work, redirect it, or give it more context. '
    + 'Injected into its current turn if it is running, otherwise starts a new turn. Revives a retired '
    + `worker. Prefer this over spawning when the topic and code area are the same and the worker's `
    + `context is still relevant. ${NON_BLOCKING}`,
    {
      worker: z.string().describe('The worker name.'),
      message: z.string().describe('The message to deliver.'),
    },
    handler(ctx, 'send'),
  );

  server.tool(
    'worker_list',
    'Without arguments: your workers with status, brief, last report time and context usage. With a '
    + 'worker name: that worker in detail, including its full last report. You do not need this to '
    + 'learn that a worker finished; reports arrive on their own.',
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
    'Resolve a pending question or plan approval a worker raised, by its request_id. For a question, '
    + 'pass answers keyed by the exact question text. For a plan or commission submission, pass approved '
    + '(and feedback when rejecting or adjusting). If you are unsure what the user would want, ask them '
    + 'with cortex_ask_user first. The user may also answer on the worker\'s own card; the first answer wins.',
    {
      request_id: z.string().describe('The request_id from the worker notice.'),
      answers: z.record(z.string(), z.string()).optional().describe('Question text → answer, for a question.'),
      approved: z.boolean().optional().describe('Approve (true) or reject (false), for a plan.'),
      feedback: z.string().optional().describe('Feedback for the worker, mainly when rejecting a plan.'),
    },
    handler(ctx, 'answer'),
  );
}
