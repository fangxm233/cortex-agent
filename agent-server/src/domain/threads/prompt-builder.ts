import { threadStore } from '@store/thread-repo.js';
import { buildResumeReminder } from '@core/resume-reminder.js';
import { canonicalizeMcpToolAllowlist } from '@core/mcp-tool-gate.js';
import { resolveSystemVars } from '@core/prompt-template.js';
import { getAgent, getTemplate, resolveFileRef } from './template-loader.js';
import { getModifiedFilesFromSession } from './artifact-io.js';
import { getDefaultAgent } from '../agents/index.js';
import { composeUserPrompt } from '../runs/prompt.js';
import { waitForPendingUserInputs } from './pending-user-inputs.js';
import type {
  AgentSlot, AgentSlotConfig, TemplateAgentRef, ThreadRecord, ThreadTemplate,
} from '@core/types/thread-types.js';

/** Re-exported so `@domain/threads` stays the one import surface for thread callers; the
 *  implementation is the layer-0 template engine every prompt composer shares. */
export { resolveSystemVars };

/** Resolve the `__active__` agent ref placeholder to the currently active default agent
 *  (set by `!agent`). With a `channel`, that channel's own selection answers first — a thread
 *  running on a channel that picked an agent runs the agent the channel picked, the same way its
 *  profile follows the channel. Falls back to `'main'` when nothing is configured. Other names
 *  pass through unchanged. */
export function resolveActiveAgentName(name: string, channel?: string): string {
  return name === '__active__' ? (getDefaultAgent(channel) || 'main') : name;
}

// --- Agent slot config resolution ---

type AgentOverrides = Partial<Pick<AgentSlotConfig,
  'promptTemplate' | 'directive' | 'systemPrompt' | 'persistSession' |
  'claudeAgent' | 'outputStyle' | 'tools' | 'pluginDirs' | 'mcpToolAllowlist' |
  'loadRules' | 'disableHooks' | 'skills' | 'settingSources' | 'projectContext'>>;

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
  if (ref.loadRules != null) o.loadRules = ref.loadRules;
  if (ref.disableHooks != null) o.disableHooks = ref.disableHooks;
  if (ref.skills != null) o.skills = ref.skills;
  if (ref.settingSources != null) o.settingSources = ref.settingSources;
  if (ref.projectContext != null) o.projectContext = ref.projectContext;
  return o;
}

/** Resolve a TemplateAgentRef to a full AgentSlotConfig by merging agent definition with optional
 *  overrides. `channel` only matters for an `__active__` ref — see {@link resolveActiveAgentName}. */
export function resolveAgentSlotConfig(ref: TemplateAgentRef, channel?: string): AgentSlotConfig | null {
  const rawName = typeof ref === 'string' ? ref : ref.ref;
  const agentName = resolveActiveAgentName(rawName, channel);
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
    loadRules: overrides.loadRules ?? agentDef.loadRules,
    disableHooks: overrides.disableHooks ?? agentDef.disableHooks,
    skills: overrides.skills ?? agentDef.skills,
    settingSources: overrides.settingSources ?? agentDef.settingSources,
    projectContext: overrides.projectContext ?? agentDef.projectContext,
    stages: agentDef.stages,
    entryStage: agentDef.entryStage,
  };
}

/** Resolve a single agent name to AgentSlotConfig (for ad-hoc threads) */
export function resolveAgentSlotConfigByName(agentName: string, channel?: string): AgentSlotConfig | null {
  return resolveAgentSlotConfig(agentName, channel);
}

/** Resolve all agent refs in a template to AgentSlotConfigs */
export function resolveTemplateAgents(template: ThreadTemplate, channel?: string): AgentSlotConfig[] {
  const configs: AgentSlotConfig[] = [];
  for (const ref of template.agents) {
    const config = resolveAgentSlotConfig(ref, channel);
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

/**
 * Assemble one thread step's prompt. The composition itself — template, prefix blocks, trim — is
 * the run layer's ({@link composeUserPrompt}); everything this function adds is thread state: which
 * stage's template applies, what the previous step produced, whether the slot's session already
 * carries the bootstrap, and which buffered user replies ride along.
 *
 * Thread steps deliberately carry NO user profile and no project/commission block — only
 * thread-free conversation turns do (see orchestration/conversation-request.ts). That keeps
 * multi-agent pipelines profile-agnostic.
 */
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
  if (opts.interruptedResume) {
    return (buildResumeReminder() + (pendingAppendix(thread, opts.pendingSnapshot) ?? '')).trim();
  }

  const { template, continuesSession } = pickStepTemplate(agentConfig, stage);
  const lastStep = [...thread.steps].reverse().find(s => s.output != null);
  // A live persistent session already received the directive and the protocol preamble on an
  // earlier step, so none of the prefix blocks are resent. `continuesSession` says the step
  // continues the same piece of work, which additionally means the previous output is already
  // in that session's history and must not be pasted in again.
  const resumed = !!(agentConfig.persistSession && hasBackendResumeTarget(thread.agents[agentConfig.slotId]));
  const carryPrevious = !(continuesSession && resumed) && !thread.templateName
    && !!lastStep?.output && !template.includes('{{previousOutput}}');

  return composeUserPrompt(
    { directive: agentConfig.directive, promptTemplate: template },
    thread.userMessage,
    {
      vars: {
        artifactPath: thread.artifactPath,
        previousOutput: lastStep?.output || '',
        modifiedFiles: getModifiedFilesFromSession(lastStep?.sessionId).map(f => `- ${f}`).join('\n'),
      },
      lead: carryPrevious ? `Previous agent output:\n\n${lastStep!.output}` : null,
      preamble: thread.artifactPath && !opts.disableControlPlane ? THREAD_PROTOCOL_PREAMBLE : null,
      resumed,
      appendix: pendingAppendix(thread, opts.pendingSnapshot),
    },
  );
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

/** The buffered notices and user replies that arrived while the step was queued, rendered as the
 *  block appended after the step body. Draining is a side effect: the snapshot is removed from the
 *  thread record and the record persisted, so the same replies are never delivered twice. */
function pendingAppendix(thread: ThreadRecord, snapshot?: PendingInputSnapshot): string | null {
  const { messages, dropped } = consumePendingInputs(thread, snapshot);
  if (messages.length === 0) return null;
  const header = dropped > 0
    ? `User replies (${messages.length} buffered, ${dropped} earlier notices dropped):`
    : `User replies (${messages.length} buffered):`;
  threadStore.set(thread).catch(() => {});
  return `\n\n---\n\n${header}\n\n${messages.join('\n\n')}`;
}
