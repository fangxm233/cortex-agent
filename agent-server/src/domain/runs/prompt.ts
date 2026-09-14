import { renderPromptTemplate, promptSystemVars, resolveSystemVars } from '@core/prompt-template.js';
import { loadCortexRules } from '../memory/rules-loader.js';
import { loadUserContext } from '../memory/user-context.js';
import type { CommissionPromptContext, ActiveCommissionContext, DraftCommissionContext } from '../commissions/commission-context.js';

// --- System prompt ---

/** The system-prompt-bearing half of an {@link import('./request.js').AgentSpec}. */
export interface SystemPromptSpec {
  /** Extra system text appended after the ambient rules — a subagent role's body. */
  appendSystemPrompt?: string | null;
}

/**
 * Everything appended to the backend's own system prompt: the ambient global rules, then the
 * caller's own text. A subagent role reaches its child through the second half — with no rules
 * loaded, the role body is all the child sees.
 *
 * Rules arrive as an argument rather than being loaded here so the composition stays a pure
 * function of its inputs; {@link globalRuleBodies} is the loader the run layer pairs it with.
 */
export function composeSystemPrompt(
  spec: SystemPromptSpec,
  sources: { rules?: readonly string[] } = {},
): string | undefined {
  const parts = [...(sources.rules ?? [])];
  const extra = spec.appendSystemPrompt?.trim();
  if (extra) parts.push(extra);
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}

/** The ambient global rule bodies, or none when the run opts out (a frozen subagent role). */
export function globalRuleBodies(load: boolean): string[] {
  return load ? loadCortexRules().global.map((rule) => rule.body) : [];
}

// --- User prompt ---

/** The user-prompt-bearing half of an {@link import('./request.js').AgentSpec}. A thread step
 *  passes the stage's template here rather than the agent-level one — stage selection is thread
 *  policy, and by the time composition runs the template has already been chosen. */
export interface UserPromptSpec {
  /** Role/identity text prepended to the rendered body. */
  directive?: string | null;
  /** Template with `{{input}}` and friends; a null/empty template means "the input verbatim". */
  promptTemplate?: string | null;
}

export interface UserPromptOptions {
  /** Template variables beyond `{{input}}`. System variables are applied last and win. */
  vars?: Record<string, string>;
  /** The USER.md profile block — see {@link userProfileBlock}. */
  userContext?: string | null;
  /** Names the project a session is bound to, so the agent knows where its findings belong. */
  project?: { id: string; contextDir: string } | null;
  /** Index + protocol for a commission-bound session (DR-0037). */
  commission?: CommissionPromptContext | null;
  /** A control-plane preamble (the thread protocol) — the last prefix before the body. */
  preamble?: string | null;
  /** Text spliced between the prefixes and the rendered body, separated by a `---` rule. The
   *  ad-hoc thread path carries the previous step's output here when the template never asked
   *  for `{{previousOutput}}`. */
  lead?: string | null;
  /** Text appended after the body — buffered user replies that arrived while the turn was queued.
   *  Appended before the final trim, so it is the appendix, not the body, that ends the prompt. */
  appendix?: string | null;
  /** True when the engine session already received the prefix blocks on an earlier turn. Every
   *  prefix is then dropped: a resumed session still has them in its history, so re-sending them
   *  burns tokens and can contradict what the model was already told. */
  resumed?: boolean;
}

/**
 * Assemble one turn's user prompt: the agent's template rendered over the turn's variables, with
 * the ambient blocks the session needs in front of it.
 *
 * Prefix order is fixed — user profile, agent directive, session project, commission, control-plane
 * preamble — and every block is optional. A caller that passes none (and no lead/appendix) gets the
 * rendered template alone, trimmed.
 */
export function composeUserPrompt(
  spec: UserPromptSpec,
  input: string,
  opts: UserPromptOptions = {},
): string {
  const vars: Record<string, string> = {
    input,
    artifactPath: '',
    previousOutput: '',
    modifiedFiles: '',
    ...opts.vars,
    ...promptSystemVars(),
  };
  let prompt = renderPromptTemplate(spec.promptTemplate || '{{input}}', vars);

  if (opts.lead) prompt = `${opts.lead}\n\n---\n\n${prompt}`;

  if (!opts.resumed) {
    const prefixes: string[] = [];
    if (opts.userContext) prefixes.push(opts.userContext);
    if (spec.directive) prefixes.push(resolveSystemVars(spec.directive));
    if (opts.project) prefixes.push(buildProjectBlock(opts.project));
    if (opts.commission) prefixes.push(buildCommissionBlock(opts.commission));
    if (opts.preamble) prefixes.push(opts.preamble);
    if (prefixes.length > 0) prompt = prefixes.join('\n\n') + '\n\n' + prompt;
  }

  if (opts.appendix) prompt += opts.appendix;
  return prompt.trim();
}

/**
 * The user profile for plain, thread-free conversation turns — the ONLY path that injects USER.md.
 * Thread steps never do, which keeps multi-agent pipelines profile-agnostic. Callers gate it to a
 * session's FIRST turn; resume keeps the block in backend history thereafter.
 */
export function userProfileBlock(include: boolean): string | null {
  return include ? loadUserContext() : null;
}

// --- Ambient blocks ---

function buildProjectBlock(project: { id: string; contextDir: string }): string {
  return `[Session Project] This session is bound to the project "${project.id}".\n`
    + `Project context directory: ${project.contextDir}\n`
    + `Treat messages in this session as pertaining to this project unless stated otherwise, `
    + `and record project-related findings and status updates there.`;
}

/** Execution protocol for commission-bound sessions (DR-0037). Deliberately compact: the four
 *  rules the agent must not lose mid-run — surprise triage, evidence, checkpoints, gates. */
const COMMISSION_PROTOCOL = `Commission protocol:
1. Surprises are three kinds: an obstacle you route around; a fork you align on (send_decision for low-stakes picks, a blocking question for high-stakes ones); a discovery that invalidates a contract premise. A discovery MUST be surfaced against the contract — never silently absorbed.
2. Completion claims need evidence pointers (file paths, command outputs, EXP ids) in ledger.md. Scope cuts and deferrals go in the plan section's "Cuts and deferrals" note.
3. Before this session ends, and at each stage boundary, append a checkpoint CP-N to ledger.md with three diffs — plan vs done, contract vs current direction, assumptions vs reality — graded ok / attention / gate. Re-read contract.md (including its Revisions section) before writing it.
4. Contract gates are blocking: ask the user and wait. A streak of approvals never downgrades a gate.`;

/** A session that is about to CREATE a commission. It has no contract and no ledger yet, so the
 *  block's whole job is to say so and hand the agent to cortex_commission_start, which carries the
 *  drill protocol. Without this the first session of every commission is the one that is told
 *  nothing (DR-0037 v3). */
function buildDraftCommissionBlock(c: DraftCommissionContext): string {
  return [
    '[Commission] This session was created to START a new commission: a long task anchored by '
    + 'a contract the user approves before any work begins.',
    `Draft directory (already created by the server): ${c.dir}`,
    '',
    'Call cortex_commission_start now, before investigating or asking anything — it carries the '
    + 'drill protocol and the contract structure. Implement nothing until the contract is approved '
    + 'through cortex_commission_submit.',
  ].join('\n');
}

/** Index, not snapshot: the block names the two files and tells the agent to read them. Their
 *  contents are deliberately NOT pasted in — they grow without bound and the user may edit
 *  contract.md at any time, so a snapshot is both expensive and potentially stale. */
function buildActiveCommissionBlock(c: ActiveCommissionContext): string {
  const ledgerLine = c.hasLedger
    ? `  ledger.md   — your state record: Status line, Plan items, checkpoints CP-N, log entries L-NNN`
    : `  ledger.md   — NOT created yet. Derive it from the contract's acceptance criteria before working`;
  return [
    `[Commission] This session belongs to the commission "${c.title}" (${c.id}).`,
    `Commission directory: ${c.dir}`,
    `  contract.md — the binding intent reference: goal, inferences, acceptance criteria, exclusions, gates, revisions`,
    ledgerLine,
    `  assets/     — rich content you generate; decisions.jsonl — server-written, never touch it`,
    '',
    `Read both files now, before anything else — their contents are not reproduced here, and the `
    + `copies on disk are the only source of truth. Re-read contract.md (including its Revisions `
    + `section) at every checkpoint; the user may have edited it since you last looked.`,
    '',
    COMMISSION_PROTOCOL,
  ].join('\n');
}

function buildCommissionBlock(c: CommissionPromptContext): string {
  return c.phase === 'draft' ? buildDraftCommissionBlock(c) : buildActiveCommissionBlock(c);
}
