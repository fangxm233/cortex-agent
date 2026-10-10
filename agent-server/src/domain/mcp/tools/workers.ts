import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { describeModelFields, type ModelFieldBases } from '@core/agents/subagent/catalog.js';
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

const NON_BLOCKING = 'Returns immediately. Worker reports and questions arrive later as new messages '
  + 'in this conversation; after dispatching work, end your turn instead of waiting or polling.';

const WORKER_MODEL_FIELD_BASES: ModelFieldBases = {
  model: 'Optional model: provider/model[:thinking] for a pi worker, a bare model id for a claude '
    + 'worker. Omit to keep your own current model (same backend) or use that backend\'s default.',
  backend: 'Optional backend: "claude" or "pi". Omit to use your own.',
};

/** The backend/model field text, listing the same host catalog the `agent` tool offers. A catalog
 *  that cannot be read degrades to the bare lead-ins rather than failing registration. */
function describeWorkerModelFields(ctx: CortexToolContext): ModelFieldBases {
  try {
    return describeModelFields(hostModelOptions(ctx), WORKER_MODEL_FIELD_BASES);
  } catch {
    return WORKER_MODEL_FIELD_BASES;
  }
}

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
  const described = describeWorkerModelFields(ctx);
  server.tool(
    'worker_spawn',
    'Start a persistent worker: a separate session with its own context and full tool surface, '
    + 'which you can continue later with worker_send. Use workers only when there are several tasks '
    + '(or the work can be split into several) or the user switches to a different task; keep a single '
    + 'task in this session. Of the work you hand off, give a worker what may need follow-up, runs long, '
    + 'or may need back-and-forth; for bounded reconnaissance or verification whose result you consume '
    + 'immediately, use the one-shot `agent` tool instead. Write a self-contained prompt: '
    + 'the worker does not see this conversation. The worker keeps your current model unless you pass '
    + 'backend or model. The user can open the worker and talk to it directly. '
    + 'The worker reports back with its final reply once it has finished with nothing left running or '
    + 'waited on; its questions and plan approvals are routed to you (answer with worker_answer). '
    + NON_BLOCKING,
    {
      name: z.string().describe('Short unique slug for this worker, e.g. "api-refactor" (lowercase letters, digits, hyphens; max 32).'),
      prompt: z.string().describe('Complete, self-contained task for the worker.'),
      backend: z.enum(['claude', 'pi']).optional().describe(described.backend),
      model: z.string().optional().describe(described.model),
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
    'Without arguments: your workers with status, brief and last report time. With a '
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
