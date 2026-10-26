import { renderPromptTemplate, promptSystemVars, resolveSystemVars } from '@core/prompt-template.js';
import { loadCortexRules } from '../memory/rules-loader.js';
import { loadUserContext } from '../memory/user-context.js';
import type { BoardPromptContext } from '../boards/board-context.js';

// --- System prompt ---

/** The system-prompt-bearing half of an {@link import('./request.js').AgentSpec}. */
export interface SystemPromptSpec {
  /** Extra system text appended after the ambient rules — a subagent role's body. */
  appendSystemPrompt?: string | null;
}

/**
 * Everything appended to the backend's own system prompt: the ambient global rules, then the
 * caller's own text, then — for a clean run — the workspace section. A subagent role reaches its
 * child through the second part — with no rules loaded, the role body is all the child sees.
 *
 * Rules and the workspace section arrive as arguments rather than being loaded here so the
 * composition stays a pure function of its inputs; {@link globalRuleBodies} and `workspacePrompt`
 * are the loaders the run layer pairs it with.
 */
export function composeSystemPrompt(
  spec: SystemPromptSpec,
  sources: { rules?: readonly string[]; workspace?: string | null } = {},
): string | undefined {
  const parts = [...(sources.rules ?? [])];
  const extra = spec.appendSystemPrompt?.trim();
  if (extra) parts.push(extra);
  if (sources.workspace) parts.push(sources.workspace);
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
  /** The board this session is bound to, delivered once per binding. */
  board?: BoardPromptContext | null;
  /** Team mode, lead side: one roster line per active worker, and the unread routine updates
   *  section (`[Unread routine updates]` …) when there is one. */
  team?: { roster: string[]; unread?: string } | null;
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
 * board, team or worker — and every block is optional. A caller that passes none gets the
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
    opts.board ? buildBoardBlock(opts.board) : null,
    opts.team ? buildTeamBlock(opts.team.roster, opts.team.unread) : null,
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

/** The lead's standing rules plus its live roster, re-sent every turn while it has workers. Unread
 *  routine updates, when there are any, close the block. */
export function buildTeamBlock(roster: readonly string[], unread?: string): string {
  const block = `[Team] You lead these workers (persistent sessions you manage with the worker_* tools):
${roster.length > 0 ? roster.join('\n') : '- (no active workers)'}
Rules:
1. After dispatching work, end your turn. Worker reports and questions wake you as they arrive. Updates a worker marks routine do not wake you; they appear under [Unread routine updates] on your next turn. Never poll or wait.
2. Continue a worker with worker_send when the topic and code area are the same and its context is still relevant; otherwise write a self-contained handoff and spawn a fresh one.
3. Answer workers' questions and approve their plans yourself with worker_answer; ask the user with cortex_ask_user only when you are unsure what they would want.
4. Do not run repeated review loops on a worker's output.`;
  return unread ? `${block}\n\n${unread}` : block;
}

/** A worker's first-turn orientation. */
export function buildWorkerBlock(worker: { name: string; lead: string }): string {
  return `[Worker] You are worker "${worker.name}" of the lead session "${worker.lead}". `
    + 'Each final reply is delivered to the lead and wakes it. If a turn has nothing new for the lead '
    + '(a stale or duplicate signal, a routine check, work still running with no change), call '
    + 'mark_routine before your final reply: the reply is then recorded for the lead without waking '
    + 'it. Ask for decisions with cortex_ask_user; they are handled by the lead, as are your plan '
    + 'approvals. The user may also open this session and talk to you directly. Keep final replies '
    + 'concise: conclusions, output paths, and open items. You cannot create workers yourself.';
}

/** Names the board and the editing etiquette; the component classes live in the board skill. */
export function buildBoardBlock(b: BoardPromptContext): string {
  return [
    `[Board] This session is bound to the board "${b.title}" (${b.id}).`,
    `Board directory: ${b.dir}`,
    `  board.html — the page body you edit (HTML, body content only); images go in assets/`,
    `  decisions.jsonl — written by the server from send_decision; do not edit`,
    '',
    'Read board.html before anything else. Update it at milestones and whenever the status '
    + 'changes. Take every time you write from the clock (current_time), never from memory. '
    + 'Prefer the preset component classes from the board skill.',
  ].join('\n');
}
