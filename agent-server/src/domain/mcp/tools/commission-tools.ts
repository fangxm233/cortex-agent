// input:  fs, zod, InteractionToolDeps, exit-plan-mode webhook
// output: registerCommissionTools + runCommissionStart/Submit
// pos:    Commission creation: the whole drill+contract protocol, and the approval that lands it
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as fs from 'fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InteractionToolDeps, CallToolResultShape } from './interaction-plan.js';

export interface CommissionSubmitArgs {
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
//  cortex_commission_start — pure (no I/O). Standalone tool, injected only while a NEW commission
//                            is being drafted. It carries the ENTIRE creation protocol: the
//                            commission skill covers maintenance only.
// =====================================================================================

const COMMISSION_START_PROTOCOL = `\
You are starting a commission: a long task anchored by two files the user can read at any time.

  contract.md — the binding statement of intent. Written once, here, through the drill below.
                Changed afterwards only by appending to 修订记录.
  ledger.md   — your state record, written after the contract is approved.

Phase 1 — drill. Implement nothing. Investigation is read-only; the only thing you write is the
contract draft. The goal is to surface and resolve the decisions hiding inside the user's request
BEFORE any work starts.

- Context first. Never ask what you can look up. Read the repo / project context until you know what
  exists, then use findings to sharpen questions and to challenge premises the code contradicts.
- Depth-first. Map the decision branches, then take ONE to resolution — or to the user explicitly
  deferring it — before moving to the next. Do not scatter questions across branches.
- Ask through cortex_ask_user, at most 4 questions per call and usually 1-2, all from the branch
  being drilled. Every question carries concrete options, your recommendation marked as such, and an
  escape meaning "go with the recommendation".
- Summarize every 5-8 exchanges: resolved / open branches / currently drilling.
- Never smooth over a contradiction; re-ask instead.
- Stop when every branch is resolved or explicitly deferred, or the user says enough. Deferred
  branches land in the contract as 不做 items or 闸门, never silently dropped.

Phase 2 — write contract.md in the draft directory, with these sections in order:

  # 合约: <title>

  ## 目标（用户原话）
  Quote the user's request verbatim. Do not paraphrase.

  ## 推断
  What you filled in beyond the user's words. Tag each line with its basis:
  （用户答复：…）for drill answers, （repo 事实：path:line）for code findings.

  ## 验收条件
  A-1, A-2, … — testable, each checkable by a command, a file, or a user look.

  ## 不做
  Explicit exclusions and deferred branches, with one-line reasons.

  ## 闸门
  The few points where execution MUST block on user confirmation (before touching shared state,
  before an irreversible step). Keep this list short.

  ## 修订记录
  （追加式，初始为空）

Phase 3 — submit it with cortex_commission_submit. That call blocks until the user decides. On
denial the feedback comes back and the draft survives, so revise and call again. On approval the
draft directory is renamed to the approved slug, the commission is registered, and this session is
bound to it.`;

function draftLocationLine(deps: InteractionToolDeps): string {
  const dir = deps.sessionName
    ? `commissions/_draft-${deps.sessionName}/`
    : 'the commissions/_draft-* directory';
  return `Draft directory (already created by the server, under this project's context directory): ${dir}\n`
    + 'Write contract.md there. Do not create or rename that directory yourself.';
}

export function runCommissionStart(
  args: { reasoning?: string },
  deps: InteractionToolDeps,
): CallToolResultShape {
  const reasoning = (args.reasoning && args.reasoning.trim()) || null;
  const text = [
    COMMISSION_START_PROTOCOL,
    draftLocationLine(deps),
    reasoning ? `(Reasoning recorded: ${reasoning})` : null,
  ].filter(Boolean).join('\n\n');
  return okResult(text);
}

function validateArgs(args: CommissionSubmitArgs, deps: InteractionToolDeps): CallToolResultShape | null {
  if (!deps.channel) return errorResult('cortex_commission_submit error: no interaction channel configured in MCP env');
  if (!args.contract_file_path) return errorResult('cortex_commission_submit error: contract_file_path is required');
  if (!args.name?.trim()) return errorResult('cortex_commission_submit error: name is required');
  if (!fs.existsSync(args.contract_file_path)) {
    return errorResult(`cortex_commission_submit error: contract file does not exist at ${args.contract_file_path}`);
  }
  return null;
}

function formatOutcome(body: any): CallToolResultShape {
  if (body?.error === 'timeout') {
    return errorResult('cortex_commission_submit: user did not respond within the approval window. Call the tool again when the user is available.');
  }
  if (body?.error === 'commission-invalid') {
    return errorResult(`cortex_commission_submit error: ${body.message ?? 'invalid commission setup'} — fix the name/draft directory and call the tool again.`);
  }
  if (typeof body?.error === 'string') return errorResult(`cortex_commission_submit error: ${body.error}`);
  const reason = typeof body?.reason === 'string' && body.reason ? `\nFeedback: ${body.reason}` : '';
  if (body?.approved !== true) {
    return okResult(`Contract denied by user.${reason}\n\nRevise contract.md in the draft directory and call cortex_commission_submit again.`);
  }
  const fin = body?.commission;
  if (!fin?.ok) {
    return errorResult(`Contract approved, but commission finalize failed: ${fin?.error ?? 'unknown error'}. The draft directory is unchanged — fix the issue and call the tool again (the user will be asked again).`);
  }
  return okResult(`Contract approved. Commission "${fin.slug}" (${fin.commissionId}) is registered and this session is bound to it.${reason}\n`
    + `Commission directory: ${fin.dir}\n\n`
    + LEDGER_INIT);
}

/** Written into the final directory the moment the contract lands, so the state record exists from
 *  the first minute. Everything after this point is maintenance, which the commission skill covers. */
const LEDGER_INIT = `\
Now create ledger.md in that directory, derived from the contract:

  # 账本: <title>

  状态：<one line, overwritten on each update>

  ## 计划
  P-1 … — one item per 验收条件, each with a status (todo/doing/done/cut/deferred).
  缩小/推迟：mandatory note whenever an item is cut or deferred — what was dropped and why.

  ## 检查点
  （CP-N entries, appended）

  ## 记录
  （L-NNN entries, appended）

Then start executing. The commission skill describes the checkpoint discipline from here on.`;

/**
 * Posts the contract through the blocking /hook/exit-plan-mode approval channel (shared with
 * cortex_plan_exit, but this is a separate tool — plan mode is untouched). The
 * same blocking /hook/exit-plan-mode approval channel with a `commission` payload; the daemon
 * pre-validates (fail-fast before bothering the user) and, on approval, renames the draft dir
 * to the slug of `name`, registers the commission, and binds this session.
 */
export async function runCommissionSubmit(
  args: CommissionSubmitArgs,
  deps: InteractionToolDeps,
): Promise<CallToolResultShape> {
  const invalid = validateArgs(args, deps);
  if (invalid) return invalid;

  let contract: string;
  try {
    contract = fs.readFileSync(args.contract_file_path, 'utf8');
  } catch (e) {
    return errorResult(`cortex_commission_submit error: failed to read contract file: ${(e as Error).message}`);
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
    return errorResult(`cortex_commission_submit error: webhook call failed: ${(e as Error).message}`);
  }
  if (resp.status !== 200) {
    const detail = resp.body?.error ?? JSON.stringify(resp.body ?? {});
    return errorResult(`cortex_commission_submit error: webhook returned status ${resp.status}: ${detail}`);
  }
  return formatOutcome(resp.body);
}

export function registerCommissionTools(server: McpServer, deps: InteractionToolDeps): void {
  server.tool(
    'cortex_commission_start',
    'Start creating a commission (委托) — a long task anchored by a user-approved contract. Call this FIRST, before any investigation or questions: it returns the complete creation protocol (drill rules, contract.md structure) and the draft directory to write the contract into. Unrelated to plan mode; cortex_plan_enter/exit still exist and are for ordinary implementation planning. Optional `reasoning` is recorded for the audit trail.',
    { reasoning: z.string().optional() },
    async (args) => runCommissionStart(args ?? {}, deps) as any,
  );

  server.tool(
    'cortex_commission_submit',
    'Submit a drafted commission contract for human approval, and land the commission if approved. Reads contract.md at `contract_file_path` — it must live in a `commissions/_draft-*/` directory of this session\'s project — and BLOCKS until the human decides. On approval the draft directory is renamed to the slug of `name`, the commission is registered, this session is bound to it, and the final directory is returned. On denial the feedback comes back and the draft survives: revise and call again.',
    {
      contract_file_path: z.string().describe('Absolute path of the draft contract.md to submit'),
      name: z.string().describe('Final commission name; slugified into the directory name'),
      title: z.string().optional().describe('Display title (defaults to name)'),
      summary: z.string().optional().describe('Optional one-paragraph summary surfaced alongside the contract'),
    },
    async (args) => (await runCommissionSubmit(args as CommissionSubmitArgs, deps)) as any,
  );
}
