// input:  McpServer, manager-Q&A webhook, thread environment
// output: ask_manager and answer_subtask tool registrars
// pos:    Manager/subtask Q&A MCP tool registrations
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const WEBHOOK_BASE = `http://127.0.0.1:${process.env.WEBHOOK_PORT || '3001'}`;
const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = parseInt(process.env.CORTEX_ASK_MANAGER_TIMEOUT_MS || '1800000', 10) || 1800000;

async function proxyQa(action: string, payload: Record<string, any>): Promise<any> {
  const res = await fetch(`${WEBHOOK_BASE}/webhook/manager-qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cortex-token': process.env.CORTEX_WEBHOOK_TOKEN || '' },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json() as any;
  if (!data.success) throw new Error(data.error || 'manager-qa failed');
  return data.data;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function selfThreadId(): string {
  const id = process.env.CORTEX_THREAD_ID;
  if (!id) {
    throw new Error('not running inside a thread (CORTEX_THREAD_ID unset) — ask_manager only works from within a dispatched task/thread');
  }
  return id;
}

async function handleAskManager(question: string) {
  try {
    const reg = await proxyQa('ask', { threadId: selfThreadId(), question });
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const poll = await proxyQa('poll', { questionId: reg.questionId });
      if (poll.answered) {
        const who = reg.target === 'human' ? 'human' : 'manager';
        return { content: [{ type: 'text' as const, text: `Answer from your ${who}:\n\n${poll.answer}` }] };
      }
    }
    return {
      content: [{ type: 'text' as const, text: `ask_manager timed out after ${Math.round(TIMEOUT_MS / 60000)} min with no reply (${reg.target}). Proceed with your best judgment and record the assumption explicitly, or call thread_abort with a diagnosis if you cannot.` }],
      isError: true,
    };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: `ask_manager error: ${(error as Error).message}` }], isError: true };
  }
}

async function handleAnswerSubtask(questionId: string, answer: string) {
  try {
    const result = await proxyQa('answer', { question_id: questionId, answer });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: `answer_subtask error: ${(error as Error).message}` }], isError: true };
  }
}

export function registerAskManagerTool(server: McpServer): void {
  server.tool(
    'ask_manager',
    'Ask the manager who planned your task a clarifying question when you hit confusion, a contradiction, or an ambiguous/under-specified intent — instead of guessing or aborting. This is LIGHTER than thread_abort: it does not give up the task; it resolves the uncertainty and lets you continue. The call BLOCKS until the manager replies, then returns their answer. Managers nest: if your manager is itself unsure it may ask its own manager upward; at the top of the tree the question goes to a human. Use for genuine planning/intent questions (for example, "did you mean approach A or B?" or "two done_when conditions conflict — which wins?"), not for things you can settle by reading the deliverable, code, or task spec yourself.',
    {
      question: z.string().min(1).describe('A specific, self-contained question about the planning intent. Include the conflict/ambiguity and the options you see so the manager can answer crisply.'),
    },
    async ({ question }: { question: string }) => handleAskManager(question),
  );
}

export function registerAnswerSubtaskTool(server: McpServer): void {
  server.tool(
    'answer_subtask',
    'Answer a question a subtask asked via ask_manager. This tool is available to both dispatched manager threads and top-level origin sessions. Give a concrete, actionable answer about the planning intent. After a thread manager answers, its thread automatically returns to waiting for its children. If you are inside a thread and need higher-level intent, call ask_manager first; a direct origin session should resolve from its own context or consult the human.',
    {
      question_id: z.string().min(1).describe('The question_id from the subtask question notice.'),
      answer: z.string().min(1).describe('Your answer / clarification for the subtask.'),
    },
    async ({ question_id, answer }: { question_id: string; answer: string }) => (
      handleAnswerSubtask(question_id, answer)
    ),
  );
}
