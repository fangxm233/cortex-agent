import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { webhookAuthHeaders, webSessionId, type CortexToolContext } from './context.js';

const DESCRIPTION =
  'Record choices the user did not dictate: approach, plan/scope changes, tools, or parameters. '
  + 'Skip mechanical steps. Non-blocking; for approval before proceeding use cortex_ask_user. '
  + 'Batch related decisions. Explain what and why briefly in plain language for a reader new to '
  + 'the work, using the conversation language.';

const decisionItemSchema = z.object({
  title: z.string().min(1).max(120)
    .describe('Decision in one short line.'),
  decision: z.string().min(1).max(1000)
    .describe('What you decided, in 1-2 plain sentences a non-expert can follow.'),
  context: z.string().min(1).max(1000)
    .describe('Task and alternatives: why a choice was needed.'),
  reasoning: z.string().min(1).max(1000)
    .describe('Decisive trade-off, in 1-2 sentences.'),
});

export function registerUiDecisionTools(server: McpServer, ctx: CortexToolContext): void {
  server.tool(
    'send_decision',
    DESCRIPTION,
    {
      decisions: z.array(decisionItemSchema).min(1).max(10)
        .describe('Decisions, one card each.'),
    },
    async (
      { decisions }:
      { decisions: { title: string; decision: string; context: string; reasoning: string }[] },
    ) => {
      try {
        const sessionId = webSessionId(ctx);
        if (!sessionId) throw new Error('No web session in context — send_decision is only usable inside a Web UI chat session');

        const { body } = await requestLoopbackJson(
          'POST',
          `${ctx.webhookBaseUrl}/webhook/ui-decision`,
          { sessionId, decisions },
          webhookAuthHeaders(ctx),
        );
        if (!body.success) throw new Error(body.error || 'send_decision failed');
        const titles: string[] = body.data?.titles ?? decisions.map(d => d.title);
        return { content: [{ type: 'text', text: `Recorded ${titles.length} decision(s) in the chat: ${titles.join(' · ')}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to send decisions: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
