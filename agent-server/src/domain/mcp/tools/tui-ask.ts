// input:  McpServer + TuiToolDeps (channel/sessionId/threadId/webhookBaseUrl/httpPost)
// output: registerTuiAskTools + pure runAskUser business-logic function
// pos:    DR-0012 Phase 3 — cortex-tui-bridge MCP tool replacing AskUserQuestion for TUI mode
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeAskLevel } from '@platform/index.js';
import type { TuiToolDeps, CallToolResultShape } from './tui-plan.js';

/**
 * Schema mirrors the native AskUserQuestion / PI ask_user_question shape (see
 * agent-adapter/pi/tool-shims.ts:26-45) so the LLM produces identical output regardless of
 * backend: a list of 1-4 questions, each with header / question / options[{label,description}] /
 * multiSelect. This shape is also what /hook/ask-user-question consumes and what
 * jsonl-tail.ts's normalizer expects — keeping all three aligned removes per-backend branches.
 */
interface AskUserOption {
  label: string;
  description?: string;
}

interface AskUserQuestion {
  question: string;
  header?: string;
  options?: AskUserOption[];
  multiSelect?: boolean;
}

interface AskUserArgs {
  questions: AskUserQuestion[];
  /** Optional severity of the card: 'info' | 'warn' | 'warning' | 'error'. */
  level?: string;
}

/**
 * Webhook response contract (see orch/interactions/ask-user-question.ts:117-148):
 *   - Success: { answers: { [questionText]: <stringified value> } }
 *               (multi-select values are pre-joined with ", " by the platform)
 *   - Error:   { error: <code>, answers: {} }    (codes: 'timeout' | 'post_failed' | 'bus_not_initialized')
 */
export async function runAskUser(args: AskUserArgs, deps: TuiToolDeps): Promise<CallToolResultShape> {
  if (!deps.channel) {
    return { content: [{ type: 'text', text: 'cortex_ask_user error: no channel configured in MCP env (SLACK_CHANNEL missing)' }], isError: true };
  }
  const questions = Array.isArray(args.questions) ? args.questions : [];
  if (questions.length === 0) {
    return { content: [{ type: 'text', text: 'cortex_ask_user error: at least one question is required' }], isError: true };
  }
  for (const q of questions) {
    if (!q || typeof q.question !== 'string' || !q.question.trim()) {
      return { content: [{ type: 'text', text: 'cortex_ask_user error: every question must have a non-empty `question` field' }], isError: true };
    }
  }

  // Normalize each question to the shape /hook/ask-user-question consumes
  // (createHookGroup at orch/interactions/ask-user-question.ts:88-94 reads
  // header / question / options[{label, description}] / multiSelect).
  const normalizedQuestions = questions.map((q) => {
    const entry: any = {
      question: q.question,
      header: q.header ?? q.question.slice(0, 12),
      multiSelect: !!q.multiSelect,
    };
    if (Array.isArray(q.options) && q.options.length > 0) {
      entry.options = q.options.map((o) => ({
        label: typeof o === 'string' ? (o as string) : o.label,
        description: typeof o === 'string' ? undefined : o.description,
      }));
    } else {
      entry.options = [];
    }
    return entry;
  });

  const level = args.level === undefined ? null : normalizeAskLevel(args.level);
  if (args.level !== undefined && !level) {
    return { content: [{ type: 'text', text: `cortex_ask_user error: invalid level '${args.level}' (valid: info, warn, warning, error)` }], isError: true };
  }

  const body = {
    sessionId: deps.sessionId,
    channel: deps.channel,
    questions: normalizedQuestions,
    threadId: deps.threadId,
    ...(level ? { level } : {}),
  };

  let resp: { status: number; body: any };
  try {
    resp = await deps.httpPost(`${deps.webhookBaseUrl}/hook/ask-user-question`, body);
  } catch (e) {
    return { content: [{ type: 'text', text: `cortex_ask_user error: webhook call failed: ${(e as Error).message}` }], isError: true };
  }
  if (resp.status !== 200) {
    const detail = resp.body?.error ?? JSON.stringify(resp.body ?? {});
    return { content: [{ type: 'text', text: `cortex_ask_user error: webhook returned status ${resp.status}: ${detail}` }], isError: true };
  }

  // Explicit error/timeout from the bridge — surface to the assistant so it can decide what to do.
  const errorCode = typeof resp.body?.error === 'string' ? resp.body.error : null;
  if (errorCode === 'timeout') {
    return {
      content: [{ type: 'text', text: 'cortex_ask_user: user did not respond within the approval window. Proceed with reasonable defaults or restate the question.' }],
      isError: true,
    };
  }
  if (errorCode) {
    return {
      content: [{ type: 'text', text: `cortex_ask_user error: ${errorCode}` }],
      isError: true,
    };
  }

  // answers is a dict keyed by question text — { [questionText]: <stringified value> }.
  const answersDict = resp.body?.answers;
  if (!answersDict || typeof answersDict !== 'object' || Array.isArray(answersDict)) {
    return { content: [{ type: 'text', text: 'cortex_ask_user: empty or malformed answers payload from approval bridge' }], isError: true };
  }
  const collected: string[] = [];
  for (const q of questions) {
    const v = answersDict[q.question];
    if (v === undefined || v === null || v === '') {
      collected.push(`Q: ${q.question}\nA: (no answer)`);
    } else if (Array.isArray(v)) {
      collected.push(`Q: ${q.question}\nA: ${v.join(', ')}`);
    } else {
      collected.push(`Q: ${q.question}\nA: ${String(v)}`);
    }
  }
  return { content: [{ type: 'text', text: collected.join('\n\n') }] };
}

export function registerTuiAskTools(server: McpServer, deps: TuiToolDeps): void {
  server.tool(
    'cortex_ask_user',
    'Ask the human one or more clarifying questions and BLOCK until they answer (replaces native AskUserQuestion). Posts each question via a Slack modal with optional multiple-choice options. Use this when you need clarification, a decision, or a choice from the user. Supply 1-4 questions per call. Set `multiSelect=true` on a question to allow multi-pick. The answers are returned in the tool_result.',
    {
      questions: z.array(
        z.object({
          question: z.string().describe('The complete question to ask the user.'),
          header: z.string().optional().describe('Very short label (max 12 chars), e.g. "Auth method", "Library". Falls back to a trimmed question prefix.'),
          options: z.array(
            z.object({
              label: z.string().describe('Display text for this option.'),
              description: z.string().optional().describe('Optional explanation of what this option means.'),
            }),
          ).optional().describe('Optional multiple-choice options. Omit for free-text answer.'),
          multiSelect: z.boolean().optional().describe('If true, the user may select multiple options (default false).'),
        }),
      ).min(1).max(4).describe('Questions to ask (1-4 questions).'),
      level: z.enum(['info', 'warn', 'warning', 'error']).optional()
        .describe("Optional severity of the question card: 'info' (default look), 'warning', or 'error'. 'warn' is accepted as an alias."),
    },
    async (args) => (await runAskUser(args as AskUserArgs, deps)) as any,
  );
}
