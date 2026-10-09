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
  return load ? loadCortexRules() : [];
}

// --- User prompt ---

/** The user-prompt-bearing half of an {@link import('./request.js').AgentSpec}. */
export interface UserPromptSpec {
  /** Role/identity text prepended to the rendered body. */
  directive?: string | null;
  /** Template over `{{input}}` and the system variables; null/empty means "the input verbatim". */
  promptTemplate?: string | null;
}

export interface UserPromptOptions {
  /** The USER.md profile block — see {@link userProfileBlock}. */
  userContext?: string | null;
  /** Names the project a session is bound to, so the agent knows where its findings belong. */
  project?: { id: string; contextDir: string } | null;
  /** The conversation-history directory, so the agent can find any session's transcript. */
  transcriptDir?: string | null;
  /** Index + protocol for a commission-bound session (DR-0037). */
  commission?: CommissionPromptContext | null;
  /** Team mode, lead side: one roster line per active worker. */
  team?: { roster: string[] } | null;
  /** Team mode, worker side: its own name and its lead's title. */
  worker?: { name: string; lead: string } | null;
  /** True when the engine session already received the prefix blocks on an earlier turn. Every
   *  prefix is then dropped: a resumed session still has them in its history, so re-sending them
   *  burns tokens and can contradict what the model was already told. */
  resumed?: boolean;
}

/**
 * Assemble one turn's user prompt: the agent's template rendered over the turn's variables, with
 * the ambient blocks the session needs in front of it.
 *
 * Prefix order is fixed — user profile, agent directive, session project, transcript location,
 * commission, team or worker — and every block is optional. A caller that passes none gets the
 * rendered template alone, trimmed.
 */
export function composeUserPrompt(
  spec: UserPromptSpec,
  input: string,
  opts: UserPromptOptions = {},
): string {
  const body = renderPromptTemplate(spec.promptTemplate || '{{input}}', { input, ...promptSystemVars() });
  const prefixes = opts.resumed ? [] : ambientPrefixes(spec, opts);
  return [...prefixes, body].join('\n\n').trim();
}

function ambientPrefixes(spec: UserPromptSpec, opts: UserPromptOptions): string[] {
  return [
    opts.userContext,
    spec.directive ? resolveSystemVars(spec.directive) : null,
    opts.project ? buildProjectBlock(opts.project) : null,
    opts.transcriptDir ? buildTranscriptBlock(opts.transcriptDir) : null,
    opts.commission ? buildCommissionBlock(opts.commission) : null,
    opts.team ? buildTeamBlock(opts.team.roster) : null,
    opts.worker ? buildWorkerBlock(opts.worker) : null,
  ].filter((block): block is string => !!block);
}

/**
 * The user profile for conversation turns — the ONLY path that injects USER.md. Callers gate it
 * to a session's FIRST turn; resume keeps the block in backend history thereafter.
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

function buildTranscriptBlock(dir: string): string {
  return `[Session Transcripts] The full transcript of any Cortex session is at ${dir}/<sessionId>.jsonl.`;
}

/** The lead's standing rules plus its live roster, re-sent every turn while it has workers. */
export function buildTeamBlock(roster: readonly string[]): string {
  return `[Team] You lead these workers (persistent sessions you manage with the worker_* tools):
${roster.join('\n')}
Rules:
1. After dispatching work, end your turn. A worker's report arrives as a new message and wakes you once the worker has finished with nothing left running or waited on (a failed or stopped turn reports at once); its questions arrive as they are raised. Its interim replies are shown to the user but do not wake you. Never poll or wait.
2. Continue a worker with worker_send when the topic and code area are the same and its context is still relevant; otherwise write a self-contained handoff and spawn a fresh one.
3. Answer workers' questions and approve their plans yourself with worker_answer; ask the user with cortex_ask_user only when you are unsure what they would want.
4. Do not run repeated review loops on a worker's output.`;
}

/** A worker's first-turn orientation. */
export function buildWorkerBlock(worker: { name: string; lead: string }): string {
  return `[Worker] You are worker "${worker.name}" of the lead session "${worker.lead}". `
    + 'Your final reply is delivered to the lead, and wakes it, when you finish with nothing left '
    + 'running or waited on (no background task, open waitpoint or pending question). A reply that '
    + 'ends a turn while such work is still pending is recorded as progress without waking the lead, '
    + 'so make the finishing reply self-contained. The user may also open this session and talk to '
    + 'you directly. Your questions (cortex_ask_user) and plan approvals are handled by the lead. '
    + 'Keep final replies concise: conclusions, output paths, and open items. You cannot create '
    + 'workers yourself.';
}

/** Execution protocol for commission-bound sessions (DR-0037). Deliberately compact: the four
 *  rules the agent must not lose mid-run — surprise triage, evidence, checkpoints, gates. */
const COMMISSION_PROTOCOL = `Commission protocol:
1. Surprises are three kinds: an obstacle you route around; a fork you align on (send_decision for low-stakes picks, a blocking question for high-stakes ones); a discovery that invalidates a contract premise. A discovery MUST be surfaced against the contract — never silently absorbed.
2. Completion claims need evidence pointers (file paths, command outputs, EXP ids) in ledger.md. Scope cuts and deferrals go in the plan section's "Cuts and deferrals" note.
3. Before this session ends, and at each stage boundary, append a checkpoint CP-N to ledger.md with three diffs — plan vs done, contract vs current direction, assumptions vs reality — graded ok / attention / gate. Re-read contract.md (including its Revisions section) before writing it.
4. Contract gates are blocking: ask the user and wait. A streak of approvals never downgrades a gate.`;

/** A session drafting a contract. It has no contract and no ledger yet, so the block's whole job is
 *  to say so and hand the agent to cortex_commission_start, which carries the drill protocol.
 *
 *  Two ways in since v4 — the agent called the tool itself, or the user switched the mode on for a
 *  session already in flight — and the block cannot tell which. It does not need to: the tool is
 *  idempotent, so "call it if you have not already" is correct either way, and the second sentence
 *  keeps a user-initiated entry from turning into a round of asking whether to proceed. */
function buildDraftCommissionBlock(c: DraftCommissionContext): string {
  return [
    '[Commission] This session is drafting a commission contract: a long task anchored by a '
    + 'contract the user approves before any work begins.',
    `Draft directory: ${c.dir}`,
    '',
    'If you have not already received the creation protocol in this session, call '
    + 'cortex_commission_start now, before investigating or asking anything — it carries the drill '
    + 'protocol and the contract structure, and is idempotent. If the user turned this mode on for '
    + 'you, that is the decision made: start drilling rather than asking whether to.',
    'Implement nothing until the contract is approved through cortex_commission_submit. If you '
    + 'conclude the task does not warrant a commission, say so plainly and let the user close it.',
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
