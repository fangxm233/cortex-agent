// input:  McpServer, daemon UI-decision webhook, session tool context
// output: Web-only send_decision tool registration
// pos:    Records agent-announced decisions on Web chat sessions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { webhookAuthHeaders, webSessionId, type CortexToolContext } from './context.js';

const DESCRIPTION = [
  'Record one or more decisions you have just made and show them to the user. The user',
  'may reply asking you to explain or revise a decision — otherwise just keep working;',
  'this never blocks. When you need the user\'s answer BEFORE proceeding, use',
  'cortex_ask_user instead.',
  '',
  'Call it when you commit to a choice the user did not explicitly dictate: picking one',
  'approach over alternatives, changing an agreed plan, cutting scope, choosing tools or',
  'parameters on the user\'s behalf. Skip mechanical steps with no real alternative.',
  '',
  'Write for a reader who has NOT been following your work: plain words, short',
  'sentences, no jargon or internal names they would not recognize. Say what you decided',
  'and why, so it can be understood in one quick read — few words, but clear. Batch',
  'decisions made together into one call (each renders its own card), and write in the',
  'language of the conversation.',
].join('\n');

const decisionItemSchema = z.object({
  title: z.string().min(1).max(120)
    .describe('The decision in one short line, shown on the card (e.g. "Store results in SQLite instead of JSONL").'),
  decision: z.string().min(1).max(1000)
    .describe('What you decided, in 1-2 plain sentences a non-expert can follow.'),
  context: z.string().min(1).max(1000)
    .describe('What you were doing and what the alternatives were — just enough for the user to see why a choice was needed.'),
  reasoning: z.string().min(1).max(1000)
    .describe('Why you picked this option, in 1-2 sentences. Name the decisive trade-off, not every consideration.'),
});

export function registerUiDecisionTools(server: McpServer, ctx: CortexToolContext): void {
  server.tool(
    'send_decision',
    DESCRIPTION,
    {
      decisions: z.array(decisionItemSchema).min(1).max(10)
        .describe('The decisions to record. Each renders as its own card in the chat.'),
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
