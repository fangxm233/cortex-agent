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
This session is now drafting a commission: a long task anchored by two files the user can read at
any time.

  contract.md — the binding statement of intent. Written once, here, through the drill below.
                Changed afterwards only by appending to its Revisions section.
  ledger.md   — your state record, written after the contract is approved.

Phase 0 — is this actually one? You may have entered on your own judgement, so check it against the
criteria before spending the user's time. A commission fits when the work spans several sessions or
days, when the goal hides decisions only the user can settle, or when "done" needs to be auditable
later. It does NOT fit a single question, a bounded edit whose shape is already agreed, or open
exploration with no commitment at the end. If it does not fit, say so and tell the user to switch
the mode off — do not drill anyway.

Announce it, once: unless the user turned this mode on themselves, your first cortex_ask_user call
must open by stating that you are treating this as a commission and why, and must offer an option
meaning "skip the contract, just do it". Having said it once, do not keep asking.

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
  branches land in the contract as Out-of-scope items or Gates, never silently dropped.

Phase 2 — write contract.md in the draft directory, with these sections in order:

  # Contract: <title>

  ## Goal (user's words)
  Quote the user's request verbatim. Do not paraphrase.

  ## Inferences
  What you filled in beyond the user's words. Tag each line with its basis:
  (user: …) for drill answers, (repo: path:line) for code findings.

  ## Acceptance criteria
  A-1, A-2, … — testable, each checkable by a command, a file, or a user look.

  ## Out of scope
  Explicit exclusions and deferred branches, with one-line reasons.

  ## Gates
  The few points where execution MUST block on user confirmation (before touching shared state,
  before an irreversible step). Keep this list short.

  ## Revisions
  (append-only; starts empty)

Phase 3 — submit it with cortex_commission_submit. That call blocks until the user decides. On
denial the feedback comes back and the draft survives, so revise and call again. On approval the
draft directory is renamed to the approved slug, the commission is registered, and this session is
bound to it.`;

function draftLocationLine(dir: string): string {
  return `Draft directory (created for you): ${dir}\n`
    + 'Write contract.md there. Do not create or rename that directory yourself.';
}

/**
 * Enter the drafting phase and hand back the creation protocol.
 *
 * Impure since v4: the session decides for itself whether a task is a commission, so the tool is
 * the entry point rather than a briefing handed to a session the user already opted in. It creates
 * the draft directory and sets `commissionDraft` through the loopback webhook (this process has no
 * registry), which is also what makes `cortex_commission_submit` legal afterwards.
 *
 * Idempotent: a session already drafting gets the same directory and the same protocol back, so the
 * [Commission] block can tell a user-initiated session to call it without risking a second draft.
 */
export async function runCommissionStart(
  args: { reasoning?: string },
  deps: InteractionToolDeps,
): Promise<CallToolResultShape> {
  if (!deps.sessionId) return errorResult('cortex_commission_start error: no session id in the MCP env');
  let body: any;
  try {
    const resp = await deps.httpPost(`${deps.webhookBaseUrl}/hook/commission-start`, {
      sessionId: deps.sessionId, channel: deps.channel, reasoning: args.reasoning ?? null,
    });
    body = resp.body;
    if (resp.status !== 200) {
      return errorResult(`cortex_commission_start error: webhook returned status ${resp.status}`);
    }
  } catch (e) {
    return errorResult(`cortex_commission_start error: webhook call failed: ${(e as Error).message}`);
  }
  if (typeof body?.error === 'string') return errorResult(`cortex_commission_start error: ${body.error}`);
  if (!body?.ok || typeof body.dir !== 'string') {
    return errorResult('cortex_commission_start error: server did not return a draft directory');
  }
  const reasoning = (args.reasoning && args.reasoning.trim()) || null;
  return okResult([
    COMMISSION_START_PROTOCOL,
    draftLocationLine(body.dir),
    body.alreadyDrafting ? '(This session was already drafting; the directory above is unchanged.)' : null,
    reasoning ? `(Reasoning recorded: ${reasoning})` : null,
  ].filter(Boolean).join('\n\n'));
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

/** The same four rules the `[Commission]` block carries (see `domain/runs/prompt.ts`). Repeated
 *  here because the skill and the block both arrive on the NEXT turn — the plugin set is fixed at
 *  spawn and the block is a prompt prefix — while the contract lands in the MIDDLE of this one. */
const COMMISSION_EXECUTION_PROTOCOL = `\
1. Surprises are three kinds: an obstacle you route around; a fork you align on; a discovery that invalidates a contract premise. A discovery MUST be surfaced against the contract — never silently absorbed.
2. Completion claims need evidence pointers (file paths, command outputs, EXP ids) in ledger.md.
3. Before this session ends, and at each stage boundary, append a checkpoint CP-N with three diffs — plan vs done, contract vs current direction, assumptions vs reality — graded ok / attention / gate. Re-read contract.md first.
4. Contract gates are blocking: ask the user and wait.`;

/** Written into the final directory the moment the contract lands, so the state record exists from
 *  the first minute. Everything after this point is maintenance, which the commission skill covers. */
const LEDGER_INIT = `\
Now create ledger.md in that directory, derived from the contract:

  # Ledger: <title>

  Status: <one line, overwritten on each update>

  ## Plan
  P-1 … — one item per acceptance criterion, each with a status (todo/doing/done/cut/deferred).
  Cuts and deferrals: mandatory note whenever an item is cut or deferred — what was dropped and why.

  ## Checkpoints
  (CP-N entries, appended)

  ## Log
  (L-NNN entries, appended)

Then start executing.

The \`commission\` skill carries the maintenance protocol in full and loads from your NEXT turn (the
session respawns onto it, keeping this conversation). For the rest of THIS turn, these four rules
are the whole of it:

${COMMISSION_EXECUTION_PROTOCOL}`;

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
    'Put THIS session into commission mode and get the creation protocol: a commission is a long task anchored by a contract the user approves before any work begins. Call it when the work spans several sessions or days, hides decisions only the user can settle, or needs an auditable record of what "done" meant — not for a single question, an already-agreed edit, or open exploration. It creates the draft directory, returns the full drill protocol and contract structure, and is idempotent (safe to call again to re-read the protocol). Unrelated to plan mode; cortex_plan_enter/exit remain for ordinary implementation planning. Optional `reasoning` is recorded for the audit trail.',
    { reasoning: z.string().optional() },
    async (args) => (await runCommissionStart(args ?? {}, deps)) as any,
  );

  server.tool(
    'cortex_commission_submit',
    'Submit a drafted commission contract for human approval, and land the commission if approved. Only legal from a session that entered the mode through cortex_commission_start (or that the user switched into it); it reads contract.md at `contract_file_path`, which must be THIS session\'s own `commissions/_draft-*/` directory, and BLOCKS until the human decides. On approval the draft directory is renamed to the slug of `name`, the commission is registered, this session is bound to it, and the final directory is returned. On denial the feedback comes back and the draft survives: revise and call again.',
    {
      contract_file_path: z.string().describe('Absolute path of the draft contract.md to submit'),
      name: z.string().describe('Final commission name; slugified into the directory name'),
      title: z.string().optional().describe('Display title (defaults to name)'),
      summary: z.string().optional().describe('Optional one-paragraph summary surfaced alongside the contract'),
    },
    async (args) => (await runCommissionSubmit(args as CommissionSubmitArgs, deps)) as any,
  );
}
