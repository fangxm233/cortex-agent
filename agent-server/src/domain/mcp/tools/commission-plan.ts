// input:  fs, zod, InteractionToolDeps, exit-plan-mode webhook
// output: registerCommissionPlanTools + runCommissionPlanEnter/Exit
// pos:    Commission drill entry and the contract approval that names + lands the commission
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as fs from 'fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InteractionToolDeps, CallToolResultShape } from './interaction-plan.js';

export interface CommissionPlanExitArgs {
  contract_file_path: string;
  name: string;
  title?: string;
  summary?: string;
}

function errorResult(text: string): CallToolResultShape {
  return { content: [{ type: 'text', text }], isError: true };
}

function okResult(text: string): CallToolResultShape {
  return { content: [{ type: 'text', text }] };
}

// =====================================================================================
//  cortex_commission_plan_enter — pure (no I/O), the commission-mode replacement for
//                                 cortex_plan_enter. Carries the drill protocol and points at
//                                 the draft directory the server already made for this session.
// =====================================================================================

const COMMISSION_ENTER_REMINDER = `\
Commission mode is active. The native plan tools and cortex_plan_exit are gone: a commission leaves
plan mode only through cortex_commission_plan_exit, because that call is what names the commission
and lands its directory.

Phase A is drill, then contract. Implement nothing; investigation is read-only and the only thing
you write is the contract draft.

Drill protocol:
- Context first. Never ask what you can look up. Read the repo / project context until you know what
  exists, then use findings to sharpen questions and to challenge premises the code contradicts.
- Depth-first. Map the decision branches, then take ONE to resolution — or to the user explicitly
  deferring it — before moving to the next. Do not scatter questions across branches.
- Ask through cortex_ask_user, at most 4 questions per call and usually 1-2, all from the branch
  being drilled. Every question carries concrete options, your recommendation marked as such, and an
  escape meaning "go with the recommendation".
- Summarize every 5-8 exchanges: resolved / open branches / currently drilling.
- Never smooth over a contradiction; re-ask instead. Deferred branches land in the contract as
  exclusions or gates, never silently dropped.

Then write contract.md (goal in the user's own words, inferences tagged with their basis, testable
acceptance criteria, exclusions, gates, empty revision log) and submit it with
cortex_commission_plan_exit. Denial returns feedback and the draft survives; approval renames the
draft to the approved slug, registers the commission and binds this session.`;

function draftLocationLine(deps: InteractionToolDeps): string {
  const dir = deps.sessionName
    ? `commissions/_draft-${deps.sessionName}/`
    : 'the commissions/_draft-* directory';
  return `Draft directory (already created by the server, under this project's context directory): ${dir}\n`
    + 'Write contract.md there. Do not create or rename that directory yourself.';
}

export function runCommissionPlanEnter(
  args: { reasoning?: string },
  deps: InteractionToolDeps,
): CallToolResultShape {
  const reasoning = (args.reasoning && args.reasoning.trim()) || null;
  const text = [
    COMMISSION_ENTER_REMINDER,
    draftLocationLine(deps),
    reasoning ? `(Reasoning recorded: ${reasoning})` : null,
  ].filter(Boolean).join('\n\n');
  return okResult(text);
}

function validateArgs(args: CommissionPlanExitArgs, deps: InteractionToolDeps): CallToolResultShape | null {
  if (!deps.channel) return errorResult('cortex_commission_plan_exit error: no interaction channel configured in MCP env');
  if (!args.contract_file_path) return errorResult('cortex_commission_plan_exit error: contract_file_path is required');
  if (!args.name?.trim()) return errorResult('cortex_commission_plan_exit error: name is required');
  if (!fs.existsSync(args.contract_file_path)) {
    return errorResult(`cortex_commission_plan_exit error: contract file does not exist at ${args.contract_file_path}`);
  }
  return null;
}

function formatOutcome(body: any): CallToolResultShape {
  if (body?.error === 'timeout') {
    return errorResult('cortex_commission_plan_exit: user did not respond within the approval window. Call the tool again when the user is available.');
  }
  if (body?.error === 'commission-invalid') {
    return errorResult(`cortex_commission_plan_exit error: ${body.message ?? 'invalid commission setup'} — fix the name/draft directory and call the tool again.`);
  }
  if (typeof body?.error === 'string') return errorResult(`cortex_commission_plan_exit error: ${body.error}`);
  const reason = typeof body?.reason === 'string' && body.reason ? `\nFeedback: ${body.reason}` : '';
  if (body?.approved !== true) {
    return okResult(`Contract denied by user.${reason}\n\nRevise contract.md in the draft directory and call cortex_commission_plan_exit again.`);
  }
  const fin = body?.commission;
  if (!fin?.ok) {
    return errorResult(`Contract approved, but commission finalize failed: ${fin?.error ?? 'unknown error'}. The draft directory is unchanged — fix the issue and call the tool again (the user will be asked again).`);
  }
  return okResult(`Contract approved. Commission "${fin.slug}" (${fin.commissionId}) is registered and this session is bound to it.${reason}\n`
    + `Commission directory: ${fin.dir}\n`
    + `Next: write ledger.md there (plan section derived from the contract's acceptance criteria), then proceed.`);
}

/**
 * Commission-mode replacement for cortex_plan_exit (DR-0037). Posts the contract through the
 * same blocking /hook/exit-plan-mode approval channel with a `commission` payload; the daemon
 * pre-validates (fail-fast before bothering the user) and, on approval, renames the draft dir
 * to the slug of `name`, registers the commission, and binds this session.
 */
export async function runCommissionPlanExit(
  args: CommissionPlanExitArgs,
  deps: InteractionToolDeps,
): Promise<CallToolResultShape> {
  const invalid = validateArgs(args, deps);
  if (invalid) return invalid;

  let contract: string;
  try {
    contract = fs.readFileSync(args.contract_file_path, 'utf8');
  } catch (e) {
    return errorResult(`cortex_commission_plan_exit error: failed to read contract file: ${(e as Error).message}`);
  }

  const body = {
    sessionId: deps.sessionId,
    channel: deps.channel,
    planContent: contract,
    toolInput: { summary: args.summary ?? '', plan_file_path: args.contract_file_path },
    threadId: deps.threadId,
    commission: { name: args.name, title: args.title ?? args.name, contractPath: args.contract_file_path },
  };

  let resp: { status: number; body: any };
  try {
    resp = await deps.httpPost(`${deps.webhookBaseUrl}/hook/exit-plan-mode`, body);
  } catch (e) {
    return errorResult(`cortex_commission_plan_exit error: webhook call failed: ${(e as Error).message}`);
  }
  if (resp.status !== 200) {
    const detail = resp.body?.error ?? JSON.stringify(resp.body ?? {});
    return errorResult(`cortex_commission_plan_exit error: webhook returned status ${resp.status}: ${detail}`);
  }
  return formatOutcome(resp.body);
}

export function registerCommissionPlanTools(server: McpServer, deps: InteractionToolDeps): void {
  server.tool(
    'cortex_commission_plan_enter',
    'Enter commission drill mode (commission-mode replacement for cortex_plan_enter). Use this FIRST when the session is in commission mode: it returns the drill protocol and the draft directory this session must write contract.md into. Investigation is read-only until the contract is approved via cortex_commission_plan_exit. Optional `reasoning` is recorded for the audit trail.',
    { reasoning: z.string().optional() },
    async (args) => runCommissionPlanEnter(args ?? {}, deps) as any,
  );

  server.tool(
    'cortex_commission_plan_exit',
    'Submit a commission contract for human approval and land the commission on approval (commission-mode replacement for cortex_plan_exit). Reads contract.md at `contract_file_path` — it must live in a `commissions/_draft-*/` directory of this session\'s project — and BLOCKS until the human decides. On approval the draft directory is renamed to the slug of `name`, the commission is registered, and this session is bound to it; the final directory is returned. On denial, revise the contract and call again.',
    {
      contract_file_path: z.string().describe('Absolute path of the draft contract.md to submit'),
      name: z.string().describe('Final commission name; slugified into the directory name'),
      title: z.string().optional().describe('Display title (defaults to name)'),
      summary: z.string().optional().describe('Optional one-paragraph summary surfaced alongside the contract'),
    },
    async (args) => (await runCommissionPlanExit(args as CommissionPlanExitArgs, deps)) as any,
  );
}
