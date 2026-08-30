// input:  templates, tool gates, thread state, buffered-input readiness
// output: ready prompts and canonical resolved runtime configs
// pos:    Thread prompt assembly and agent slot resolution
// >>> If I am updated, update my header comment and parent CORTEX.md <<<

import { threadStore } from '@store/thread-repo.js';
import { buildResumeReminder } from '@core/resume-reminder.js';
import { canonicalizeMcpToolAllowlist } from '@core/mcp-tool-gate.js';
import { getAgent, getTemplate, resolveFileRef } from './template-loader.js';
import { getModifiedFilesFromSession } from './artifact-io.js';
import { getDefaultAgent } from '../agents/index.js';
import { loadUserContext } from '../memory/user-context.js';
import { waitForPendingUserInputs } from './pending-user-inputs.js';
import type {
  AgentDefinition, AgentSlot, AgentSlotConfig, AgentSlotId, AgentStep, TemplateAgentRef, ThreadRecord, ThreadTemplate,
} from '@core/types/thread-types.js';
import type {
  ActiveCommissionContext, CommissionPromptContext, DraftCommissionContext,
} from '../commissions/commission-context.js';

/** Resolve the `__active__` agent ref placeholder to the currently active default agent
 *  (set by `!agent`). Falls back to `'main'` when no default is configured. Other names
 *  pass through unchanged. */
export function resolveActiveAgentName(name: string): string {
  return name === '__active__' ? (getDefaultAgent() || 'main') : name;
}

// --- System variable resolution ---
// System variables are resolved at step execution time (not config load time).

function getSystemVars(): Record<string, string> {
  const now = new Date();
  return {
    currentDateTime: now.toLocaleString('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }),
  };
}

/** Replace {{systemVar}} placeholders with system variable values. Unknown vars are left as-is. */
export function resolveSystemVars(text: string): string {
  const vars = getSystemVars();
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => key in vars ? vars[key] : match);
}

// --- Agent slot config resolution ---

type AgentOverrides = Partial<Pick<AgentSlotConfig,
  'promptTemplate' | 'directive' | 'systemPrompt' | 'persistSession' |
  'claudeAgent' | 'outputStyle' | 'tools' | 'pluginDirs' | 'mcpToolAllowlist'>>;

function collectRefOverrides(ref: TemplateAgentRef): AgentOverrides {
  if (typeof ref === 'string') return {};
  const o: AgentOverrides = {};
  if (ref.promptTemplate != null) o.promptTemplate = resolveFileRef('promptTemplate', ref.promptTemplate) ?? ref.promptTemplate;
  if (ref.directive != null) o.directive = resolveFileRef('directive', ref.directive) ?? ref.directive;
  if (ref.systemPrompt != null) o.systemPrompt = resolveFileRef('systemPrompt', ref.systemPrompt) ?? ref.systemPrompt;
  if (ref.persistSession != null) o.persistSession = ref.persistSession;
  if (ref.claudeAgent != null) o.claudeAgent = ref.claudeAgent;
  if (ref.outputStyle != null) o.outputStyle = ref.outputStyle;
  if (ref.tools != null) o.tools = ref.tools;
  if (ref.pluginDirs != null) o.pluginDirs = ref.pluginDirs;
  if (ref.mcpToolAllowlist != null) {
    o.mcpToolAllowlist = canonicalizeMcpToolAllowlist(ref.mcpToolAllowlist);
  }
  return o;
}

/** Resolve a TemplateAgentRef to a full AgentSlotConfig by merging agent definition with optional overrides. */
export function resolveAgentSlotConfig(ref: TemplateAgentRef): AgentSlotConfig | null {
  const rawName = typeof ref === 'string' ? ref : ref.ref;
  const agentName = resolveActiveAgentName(rawName);
  const agentDef = getAgent(agentName);
  if (!agentDef) return null;
  const overrides = collectRefOverrides(ref);
  return {
    slotId: agentName,
    profile: agentDef.profile,
    persistSession: overrides.persistSession ?? agentDef.persistSession,
    directive: overrides.directive ?? agentDef.directive,
    systemPrompt: overrides.systemPrompt ?? agentDef.systemPrompt,
    promptTemplate: overrides.promptTemplate ?? agentDef.promptTemplate,
    claudeAgent: overrides.claudeAgent ?? agentDef.claudeAgent,
    outputStyle: overrides.outputStyle ?? agentDef.outputStyle,
    tools: overrides.tools ?? agentDef.tools,
    pluginDirs: overrides.pluginDirs ?? agentDef.pluginDirs,
    mcpComposition: agentDef.mcpComposition,
    mcpToolAllowlist: overrides.mcpToolAllowlist
      ?? (agentDef.mcpToolAllowlist
        ? canonicalizeMcpToolAllowlist(agentDef.mcpToolAllowlist) : undefined),
    stages: agentDef.stages,
    entryStage: agentDef.entryStage,
  };
}

/** Resolve a single agent name to AgentSlotConfig (for ad-hoc threads) */
export function resolveAgentSlotConfigByName(agentName: string): AgentSlotConfig | null {
  return resolveAgentSlotConfig(agentName);
}

/** Resolve all agent refs in a template to AgentSlotConfigs */
export function resolveTemplateAgents(template: ThreadTemplate): AgentSlotConfig[] {
  const configs: AgentSlotConfig[] = [];
  for (const ref of template.agents) {
    const config = resolveAgentSlotConfig(ref);
    if (config) configs.push(config);
  }
  return configs;
}

/** Resolve the unique profile names a template's agents will actually run with.
 *  Mirrors thread-runner profile resolution (runner.ts): hardcoded agent profiles win;
 *  `__active__` slots resolve to `activeProfile` (the dispatch/scheduler profile that
 *  would be injected via metadata.profileOverride). Null/empty entries are dropped.
 *  Unknown template or no resolvable agents → [] (fail-open; callers decide fallback). */
export function resolveTemplateProfiles(templateName: string, activeProfile: string | null): string[] {
  const template = getTemplate(templateName);
  if (!template) return [];
  const profiles = new Set<string>();
  for (const config of resolveTemplateAgents(template)) {
    const profile = config.profile === '__active__' ? activeProfile : config.profile;
    if (profile) profiles.add(profile);
  }
  return [...profiles];
}

/** Render an `(agent, stage)` pair as the canonical endpoint string used for iterationCounts keys
 *  and transition-rule matching. Stages that are null render as bare agent names. */
export function formatEndpoint(agent: string, stage: string | null): string {
  return stage ? `${agent}:${stage}` : agent;
}

/** Pick the prompt template for this step. For stage-aware agents, use `stages[stage]`;
 *  otherwise fall back to the agent-level `promptTemplate` (single-stage legacy path). */
export function pickStepTemplate(agentConfig: AgentSlotConfig, stage: string | null): { template: string; continuesSession: boolean } {
  if (stage && agentConfig.stages && agentConfig.stages[stage]) {
    const s = agentConfig.stages[stage];
    return { template: s.promptTemplate, continuesSession: s.continuesSession === true };
  }
  return { template: agentConfig.promptTemplate || '{{input}}', continuesSession: false };
}

/** System-level protocol preamble injected into every step prompt of threads that own a workspace artifact. */
export const THREAD_PROTOCOL_PREAMBLE = [
  '[Cortex Thread Protocol]',
  'You are executing inside a Cortex thread. Control it by calling the `thread_abort` /',
  '`thread_split` / `thread_wait` tools (each tool description states when and how) — the',
  'artifact is plain prose, and writing a control keyword into it does nothing.',
  'Task-backed delegation (DR-0014): when CORTEX_TASK_ID is set, stage each child task as JSON',
  'with the Write tool at a per-task unique path, then run `cortex-task spawn --task-file <path>`.',
  'Do not use shared staging filenames or place task text, why, or done-when in shell arguments.',
].join('\n');

// --- Prompt assembly ---

function buildPromptVars(thread: import('@core/types/thread-types.js').ThreadRecord, lastStep: AgentStep | undefined): Record<string, string> {
  const prevModifiedFiles = getModifiedFilesFromSession(lastStep?.sessionId);
  return {
    input: thread.userMessage,
    artifactPath: thread.artifactPath,
    previousOutput: lastStep?.output || '',
    modifiedFiles: prevModifiedFiles.length > 0 ? prevModifiedFiles.map(f => `- ${f}`).join('\n') : '',
    ...getSystemVars(),
  };
}

function applyPromptTemplate(templateStr: string, vars: Record<string, string>): string {
  const withBlocks = templateStr.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, varName, content) => vars[varName] ? content : '',
  );
  return withBlocks.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '');
}

function hasBackendResumeTarget(slot: AgentSlot | undefined): boolean {
  if (!slot) return false;
  if (slot.backendSessionId === undefined) return !!slot.sessionId;
  return !!slot.backendSessionId;
}

interface PendingInputSnapshot {
  legacyMessages: string[];
  userInputIds: string[];
}

interface StepPromptOptions {
  interruptedResume?: boolean;
  disableControlPlane?: boolean;
  pendingSnapshot?: PendingInputSnapshot;
}

function snapshotPendingInputs(threadId: string): PendingInputSnapshot {
  const metadata = threadStore.get(threadId)?.metadata;
  return {
    legacyMessages: [...(metadata?.pendingMessages ?? [])],
    userInputIds: metadata?.pendingUserInputs?.map((input) => input.id) ?? [],
  };
}

export async function buildReadyStepPrompt(
  threadId: string, agentConfig: AgentSlotConfig,
  stage: string | null = null, opts: StepPromptOptions = {},
): Promise<string> {
  const pendingSnapshot = snapshotPendingInputs(threadId);
  await waitForPendingUserInputs(threadId, pendingSnapshot.userInputIds);
  return buildStepPrompt(threadId, agentConfig, stage, { ...opts, pendingSnapshot });
}

export function buildStepPrompt(
  threadId: string,
  agentConfig: AgentSlotConfig,
  stage: string | null = null,
  opts: StepPromptOptions = {},
): string {
  const thread = threadStore.get(threadId);
  if (!thread) return '';
  // Interrupted-step rerun: the original step prompt and the partial work are already in the
  // resumed backend session's history — send only the continuation reminder (plus any buffered
  // user replies), mirroring the direct-session resume (orchestration/resume-dispatcher).
  const prompt = opts.interruptedResume
    ? buildResumeReminder()
    : buildRegularStepPrompt(thread, agentConfig, stage, opts.disableControlPlane === true);
  return appendPendingMessages(thread, prompt, opts.pendingSnapshot).trim();
}

function buildRegularStepPrompt(
  thread: ThreadRecord, agentConfig: AgentSlotConfig,
  stage: string | null, disableControlPlane: boolean,
): string {
  const { template: templateStr, continuesSession } = pickStepTemplate(agentConfig, stage);
  const lastStep = [...thread.steps].reverse().find(s => s.output != null);
  const vars = buildPromptVars(thread, lastStep);

  let prompt = applyPromptTemplate(templateStr, vars);

  const slot = thread.agents[agentConfig.slotId];
  const resumingPersistentSession = agentConfig.persistSession && hasBackendResumeTarget(slot);
  const incremental = continuesSession && resumingPersistentSession;

  if (!incremental && !thread.templateName && lastStep?.output && !templateStr.includes('{{previousOutput}}')) {
    prompt = `Previous agent output:\n\n${lastStep.output}\n\n---\n\n${prompt}`;
  }

  if (!resumingPersistentSession) {
    const prefixes: string[] = [];
    // Thread steps never carry the user profile — only thread-free conversation turns do
    // (see buildConversationPrompt). This keeps multi-agent pipelines profile-agnostic.
    if (agentConfig.directive) prefixes.push(resolveSystemVars(agentConfig.directive));
    if (thread.artifactPath && !disableControlPlane) prefixes.push(THREAD_PROTOCOL_PREAMBLE);
    if (prefixes.length > 0) prompt = prefixes.join('\n\n') + '\n\n' + prompt;
  }

  return prompt;
}

function legacyMessagesAfterSnapshot(current: string[], snapshot: string[]): string[] {
  const maxOverlap = Math.min(current.length, snapshot.length);
  for (let size = maxOverlap; size > 0; size--) {
    const snapshotSuffix = snapshot.slice(snapshot.length - size);
    if (snapshotSuffix.every((message, index) => current[index] === message)) {
      return current.slice(size);
    }
  }
  return current;
}

function consumePendingInputs(
  thread: ThreadRecord, snapshot?: PendingInputSnapshot,
): { messages: string[]; dropped: number } {
  if (!thread.metadata) return { messages: [], dropped: 0 };
  const legacy = thread.metadata.pendingMessages ?? [];
  const userInputs = thread.metadata.pendingUserInputs ?? [];
  const selectedLegacy = snapshot ? snapshot.legacyMessages : legacy;
  const selectedIds = snapshot ? new Set(snapshot.userInputIds) : null;
  const selectedUsers = selectedIds ? userInputs.filter((input) => selectedIds.has(input.id)) : userInputs;
  const legacyTail = selectedLegacy.slice(-10);
  thread.metadata.pendingMessages = snapshot ? legacyMessagesAfterSnapshot(legacy, selectedLegacy) : [];
  thread.metadata.pendingUserInputs = selectedIds
    ? userInputs.filter((input) => !selectedIds.has(input.id))
    : [];
  return {
    messages: [...legacyTail, ...selectedUsers.map((input) => input.text)],
    dropped: selectedLegacy.length - legacyTail.length,
  };
}

/** Append a stable snapshot of buffered notices and user inputs. */
function appendPendingMessages(
  thread: ThreadRecord, prompt: string, snapshot?: PendingInputSnapshot,
): string {
  const { messages, dropped } = consumePendingInputs(thread, snapshot);
  if (messages.length === 0) return prompt;
  const header = dropped > 0
    ? `User replies (${messages.length} buffered, ${dropped} earlier notices dropped):`
    : `User replies (${messages.length} buffered):`;
  const appended = prompt + `\n\n---\n\n${header}\n\n${messages.join('\n\n')}`;
  threadStore.set(thread).catch(() => {});
  return appended;
}

/**
 * Assemble the prompt for a single plain user-conversation turn — the thread-independent
 * counterpart of buildStepPrompt. Plain user messages are NOT wrapped in a thread, so there
 * is no thread record, artifact, previous step, or transition to consider.
 *
 * Fidelity with the legacy default-thread path (templateName='default', isUserInitiated=true):
 *  - applies the default agent's promptTemplate (typically `{{input}}`) with empty thread vars;
 *  - prepends the agent directive (resolved for {{systemVar}});
 *  - prepends the user profile (loadUserContext) — plain conversation is the ONLY path that
 *    injects USER.md; it is on by default unless CORTEX_DISABLE_USER_CONTEXT=1. Thread steps
 *    (buildStepPrompt) never inject it. The caller gates it via opts.includeUserContext so the
 *    profile is sent only on a session's FIRST turn (session resume keeps it in history thereafter);
 *  - prepends a [Session Project] block when opts.project is given — the caller (conversation-runner
 *    via resolveConversationProject) passes it only on the FIRST turn of a Web UI direct session
 *    bound to a user project, so the agent knows which project the session belongs to;
 *  - prepends a [Commission] block when opts.commission is given (fresh commission-bound sessions
 *    only — see resolveConversationCommission): an INDEX of the commission directory plus the
 *    execution protocol (DR-0037) — contract.md / ledger.md are named, never pasted. Pure text
 *    assembly; all file I/O stays in the commissions domain loader;
 *  - NEVER injects THREAD_PROTOCOL_PREAMBLE (no artifact, no [ABORT] protocol for conversations).
 */
export function buildConversationPrompt(
  agentConfig: AgentSlotConfig,
  input: string,
  opts: {
    includeUserContext?: boolean;
    project?: { id: string; contextDir: string } | null;
    commission?: CommissionPromptContext | null;
  } = {},
): string {
  const { includeUserContext = true, project = null, commission = null } = opts;
  const { template: templateStr } = pickStepTemplate(agentConfig, null);
  const vars: Record<string, string> = {
    input,
    artifactPath: '',
    previousOutput: '',
    modifiedFiles: '',
    ...getSystemVars(),
  };
  let prompt = applyPromptTemplate(templateStr, vars);

  const prefixes: string[] = [];
  const userCtx = includeUserContext ? loadUserContext() : null;
  if (userCtx) prefixes.push(userCtx);
  if (agentConfig.directive) prefixes.push(resolveSystemVars(agentConfig.directive));
  if (project) {
    prefixes.push(
      `[Session Project] This session is bound to the project "${project.id}".\n`
      + `Project context directory: ${project.contextDir}\n`
      + `Treat messages in this session as pertaining to this project unless stated otherwise, `
      + `and record project-related findings and status updates there.`,
    );
  }
  if (commission) prefixes.push(buildCommissionBlock(commission));
  if (prefixes.length > 0) prompt = prefixes.join('\n\n') + '\n\n' + prompt;

  return prompt.trim();
}

/** Execution protocol for commission-bound sessions (DR-0037). Deliberately compact: the four
 *  rules the agent must not lose mid-run — surprise triage, evidence, checkpoints, gates. */
const COMMISSION_PROTOCOL = `Commission protocol:
1. Surprises are three kinds: an obstacle you route around; a fork you align on (send_decision for low-stakes picks, a blocking question for high-stakes ones); a discovery that invalidates a contract premise. A discovery MUST be surfaced against the contract — never silently absorbed.
2. Completion claims need evidence pointers (file paths, command outputs, EXP ids) in ledger.md. Scope cuts and deferrals go in the plan section's 缩小/推迟 fields.
3. Before this session ends, and at each stage boundary, append a checkpoint CP-N to ledger.md with three diffs — plan vs done, contract vs current direction, assumptions vs reality — graded ok / attention / gate. Re-read contract.md (including 修订记录) before writing it.
4. Contract gates are blocking: ask the user and wait. A streak of approvals never downgrades a gate.`;

/** A session that is about to CREATE a commission. It has no contract and no ledger yet, so the
 *  block's whole job is to say so and hand the agent to cortex_commission_start, which carries the
 *  drill protocol. Without this the first session of every commission is the one that is told
 *  nothing (DR-0037 v3). */
function buildDraftCommissionBlock(c: DraftCommissionContext): string {
  return [
    '[Commission] This session was created to START a new commission (委托): a long task anchored by '
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
    ? `  ledger.md   — your state record: 状态 line, 计划 items, checkpoints CP-N, log entries L-NNN`
    : `  ledger.md   — NOT created yet. Derive it from the contract's acceptance criteria before working`;
  return [
    `[Commission] This session belongs to the commission "${c.title}" (${c.id}).`,
    `Commission directory: ${c.dir}`,
    `  contract.md — the binding intent reference: goal, inferences, acceptance criteria, exclusions, gates, 修订记录`,
    ledgerLine,
    `  assets/     — rich content you generate; decisions.jsonl — server-written, never touch it`,
    '',
    `Read both files now, before anything else — their contents are not reproduced here, and the `
    + `copies on disk are the only source of truth. Re-read contract.md (including 修订记录) at every `
    + `checkpoint; the user may have edited it since you last looked.`,
    '',
    COMMISSION_PROTOCOL,
  ].join('\n');
}

function buildCommissionBlock(c: CommissionPromptContext): string {
  return c.phase === 'draft' ? buildDraftCommissionBlock(c) : buildActiveCommissionBlock(c);
}
