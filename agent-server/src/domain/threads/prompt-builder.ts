// input:  templates, artifacts, thread and backend state
// output: resume-aware thread prompts and slot configs
// pos:    Thread prompt assembly and agent slot resolution
// >>> If I am updated, update my header comment and parent CORTEX.md <<<

import { threadStore } from '@store/thread-repo.js';
import { getAgent, getTemplate, resolveFileRef } from './template-loader.js';
import { getModifiedFilesFromSession } from './artifact-io.js';
import { getDefaultAgent } from '../agents/index.js';
import { loadUserContext } from '../memory/user-context.js';
import type {
  AgentDefinition, AgentSlot, AgentSlotConfig, AgentSlotId, AgentStep, TemplateAgentRef, ThreadTemplate,
} from '@core/types/thread-types.js';

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
      timeZone: 'Asia/Shanghai',
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
  'claudeAgent' | 'outputStyle' | 'tools' | 'pluginDirs'>>;

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
  'You are executing inside a Cortex thread. Control of the thread is done by calling tools, NOT by',
  'writing markers in the artifact — the artifact is plain prose and mentioning a control keyword in',
  'it does nothing.',
  'If the task cannot be completed (missing dependencies, contradictory requirements, or repeated',
  'unrecoverable failures), call the `thread_abort` tool with a kind (too-big | mis-scoped |',
  'blocked-external) and a one-line diagnosis to terminate the thread — terminal state `aborted`,',
  'distinct from `failed`. Use this only when truly blocked: normal retries, minor issues, or',
  'disagreements with the plan are not abort cases.',
  'Decomposition: if your task is actually several independently verifiable units, call the',
  '`thread_split` tool with the subtasks instead of grinding through it.',
  'Task-backed delegation (DR-0014): when CORTEX_TASK_ID is set, create child tasks with',
  '`cortex-task spawn`, then call `thread_wait` to suspend; you are re-entered once ALL awaited',
  'children finish, with their results injected. Acceptance before trust: verify each child',
  'deliverable against its done_when',
  'yourself (read files, run tests) — never accept a child\'s self-report as evidence.',
  'Checkpoint gate (DR-0017): thread_wait is REJECTED unless you updated your artifact during the',
  'current step — write your checkpoint (delegations & acceptance criteria / decisions made /',
  'remaining plan / assumptions) to the artifact before suspending.',
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

export function buildStepPrompt(threadId: string, agentConfig: AgentSlotConfig, stage: string | null = null): string {
  const thread = threadStore.get(threadId);
  if (!thread) return '';
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
    if (thread.artifactPath) prefixes.push(THREAD_PROTOCOL_PREAMBLE);
    if (prefixes.length > 0) prompt = prefixes.join('\n\n') + '\n\n' + prompt;
  }

  // Phase 6: include buffered user messages in the next step's prompt.
  // Messages accumulated while the previous step was executing are appended
  // so the agent sees the user's reply.
  if (thread.metadata?.pendingMessages?.length) {
    // Take the last 10 messages to cap prompt growth
    const messages = thread.metadata.pendingMessages.slice(-10);
    const count = thread.metadata.pendingMessages.length;
    const dropped = count > 10 ? count - 10 : 0;
    const header = dropped > 0
      ? `User replies (last ${messages.length}, ${dropped} earlier dropped):`
      : `User replies (${count} buffered):`;
    prompt += `\n\n---\n\n${header}\n\n${messages.join('\n\n')}`;
    // Clear buffer synchronously on in-memory object
    thread.metadata.pendingMessages = [];
    // Fire-and-forget persist — see thread-executor.ts bufferUserMessage for
    // rationale on why set() is used instead of mutate() here.
    threadStore.set(thread).catch(() => {});
  }

  return prompt.trim();
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
 *  - NEVER injects THREAD_PROTOCOL_PREAMBLE (no artifact, no [ABORT] protocol for conversations).
 */
export function buildConversationPrompt(
  agentConfig: AgentSlotConfig,
  input: string,
  opts: { includeUserContext?: boolean; project?: { id: string; contextDir: string } | null } = {},
): string {
  const { includeUserContext = true, project = null } = opts;
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
      + `Treat messages in this session as pertaining to this project unless stated otherwise. `
      + `project-related findings and status updates there.`,
    );
  }
  if (prefixes.length > 0) prompt = prefixes.join('\n\n') + '\n\n' + prompt;

  return prompt.trim();
}
