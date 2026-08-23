// input:  McpServer, tool dependencies, plan files
// output: Shared plan-mode MCP registrations and handlers
// pos:    Implements blocking human plan approval
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Per-process injection point for tests. Production binds httpPost to global fetch. */
export interface InteractionToolDeps {
  channel: string | null;
  sessionId: string | null;
  threadId: string | null;
  webhookBaseUrl: string;
  httpPost: (url: string, body: any) => Promise<{ status: number; body: any }>;
}

/** Shape of an MCP CallToolResult — kept structural to avoid importing SDK types into test files. */
export interface CallToolResultShape {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// =====================================================================================
//  cortex_plan_enter — pure (no I/O), emits a system reminder back to the assistant
// =====================================================================================

const PLAN_ENTER_REMINDER = `\
You have entered Cortex plan mode.

Protocol:
  1. Investigate using read-only tools (Read/Glob/Grep/WebSearch). Do not edit files yet.
  2. Write your plan to a file under \`plan/\` using the Write tool.
  3. When the plan is ready for human review, call \`cortex_plan_exit\` with:
       - plan_file_path: the absolute path of the plan file
       - summary: a one-paragraph summary surfaced to the user
     This blocks until the human approves, denies, or requests revisions.
  4. On approval, proceed with implementation. On denial, revise the plan and call cortex_plan_exit again.

Native backend plan tools are disabled for this protocol. Cortex routes approval through
cortex_plan_exit so the interaction channel stays the single source of truth for plan history.`;

export function runPlanEnter(args: { reasoning?: string }): CallToolResultShape {
  const reasoning = (args.reasoning && args.reasoning.trim()) || null;
  const reminderText = reasoning
    ? `${PLAN_ENTER_REMINDER}\n\n(Reasoning recorded: ${reasoning})`
    : PLAN_ENTER_REMINDER;
  return { content: [{ type: 'text', text: reminderText }] };
}

// =====================================================================================
//  cortex_plan_exit — reads plan file, POSTs to /hook/exit-plan-mode (existing webhook),
//                     blocks until human approves/denies. Reuses the same endpoint that
//                     Claude's native ExitPlanMode hook script targets.
//
// Webhook response contract (see orch/interactions/interaction-handlers.ts:163,190):
//   - Approved:   { approved: true,  reason: '' }
//   - Denied:     { approved: false, reason: <user feedback string> }
//   - Error path: { error: <code>, approved: true|false, reason: '' }
//   - Timeout:    { error: 'timeout', answers: {} }    (TTL = 30 min, see hook-bridge.ts:9,95)
// =====================================================================================

export async function runPlanExit(
  args: { plan_file_path: string; summary?: string },
  deps: InteractionToolDeps,
): Promise<CallToolResultShape> {
  // The webhook needs the originating interaction channel.
  if (!deps.channel) {
    return { content: [{ type: 'text', text: 'cortex_plan_exit error: no interaction channel configured in MCP env' }], isError: true };
  }
  if (!args.plan_file_path) {
    return { content: [{ type: 'text', text: 'cortex_plan_exit error: plan_file_path is required' }], isError: true };
  }
  if (!fs.existsSync(args.plan_file_path)) {
    return { content: [{ type: 'text', text: `cortex_plan_exit error: plan file does not exist at ${args.plan_file_path}` }], isError: true };
  }

  let planContent: string;
  try {
    planContent = fs.readFileSync(args.plan_file_path, 'utf8');
  } catch (e) {
    return { content: [{ type: 'text', text: `cortex_plan_exit error: failed to read plan file: ${(e as Error).message}` }], isError: true };
  }

  const summary = args.summary ?? '';
  const body = {
    sessionId: deps.sessionId,
    channel: deps.channel,
    planContent,
    toolInput: { summary, plan_file_path: args.plan_file_path },
    threadId: deps.threadId,
  };

  let resp: { status: number; body: any };
  try {
    resp = await deps.httpPost(`${deps.webhookBaseUrl}/hook/exit-plan-mode`, body);
  } catch (e) {
    return { content: [{ type: 'text', text: `cortex_plan_exit error: webhook call failed: ${(e as Error).message}` }], isError: true };
  }

  if (resp.status !== 200) {
    const detail = resp.body?.error ?? JSON.stringify(resp.body ?? {});
    return { content: [{ type: 'text', text: `cortex_plan_exit error: webhook returned status ${resp.status}: ${detail}` }], isError: true };
  }

  // Explicit error/timeout from the bridge — surface to the assistant so it can choose to retry.
  const errorCode = typeof resp.body?.error === 'string' ? resp.body.error : null;
  if (errorCode === 'timeout') {
    return {
      content: [{ type: 'text', text: 'cortex_plan_exit: user did not respond within the approval window. Revise or shorten the plan and call cortex_plan_exit again.' }],
      isError: true,
    };
  }
  if (errorCode) {
    return {
      content: [{ type: 'text', text: `cortex_plan_exit error: ${errorCode}` }],
      isError: true,
    };
  }

  const approved = resp.body?.approved === true;
  const reason = typeof resp.body?.reason === 'string' ? resp.body.reason : '';
  if (approved) {
    const msg = reason
      ? `Plan approved by user. Feedback: ${reason}\n\nYou may now proceed with implementation.`
      : 'Plan approved by user. You may now proceed with implementation.';
    return { content: [{ type: 'text', text: msg }] };
  }
  // approved === false (or missing — treat as denied for safety, since the webhook always sets it
  // on the success path; absence means an unexpected response shape and we should not assume approval).
  const msg = reason
    ? `Plan denied by user. Feedback: ${reason}\n\nRevise the plan and call cortex_plan_exit again.`
    : 'Plan denied by user. Revise the plan and call cortex_plan_exit again.';
  return { content: [{ type: 'text', text: msg }] };
}

// =====================================================================================
//  MCP server registration
// =====================================================================================

export function registerInteractionPlanTools(server: McpServer, deps: InteractionToolDeps): void {
  server.tool(
    'cortex_plan_enter',
    'Enter Cortex plan mode. Use this BEFORE designing a non-trivial implementation. Replaces native EnterPlanMode in eligible direct agent sessions — investigation is read-only, the plan must be written to a file under `plan/`, and cortex_plan_exit is required before implementation. Optional `reasoning` is recorded for the audit trail.',
    { reasoning: z.string().optional() },
    async (args) => runPlanEnter(args ?? {}) as any,
  );

  server.tool(
    'cortex_plan_exit',
    'Submit a written plan for human approval (replaces native ExitPlanMode). Reads the plan file at `plan_file_path`, posts it to the Cortex approval channel along with the optional `summary`, and BLOCKS until the human approves, denies, or requests revisions. Returns approval status and any feedback as a tool_result. Do not call this until the plan file is complete.',
    {
      plan_file_path: z.string().describe('Absolute path of the plan file to submit'),
      summary: z.string().optional().describe('Optional one-paragraph summary surfaced alongside the plan'),
    },
    async (args) => (await runPlanExit(args as { plan_file_path: string; summary?: string }, deps)) as any,
  );
}
