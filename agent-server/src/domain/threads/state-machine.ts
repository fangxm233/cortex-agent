// input:  thread store, templates, task parser, artifact I/O
// output: thread lifecycle, provider pauses, and control transitions
// pos:    Thread state machine and suspension wait-set resolver
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import * as path from 'path';
import { ctx as jobCtx } from '@domain/scheduling/job-registry.js';
import { WORKSPACE_DIR } from '@core/utils.js';
import { ensureTaskArtifact } from '@core/task-node.js';
import { createLogger } from '@core/log.js';
import { threadStore } from '@store/thread-repo.js';

const log = createLogger('state-machine');
import { getTemplate, getAgent } from './template-loader.js';
import { resolveAgentSlotConfigByName, resolveTemplateAgents, resolveActiveAgentName } from './prompt-builder.js';
import { resolveStageName, parseTarget } from './utils.js';
import { checkContractBudget } from './contract.js';
import { scanAllTasks } from '@core/task-parser.js';
import type {
  ThreadRecord, ThreadTemplate, AgentDefinition,
  AgentSlotConfig, AgentSlotId, AgentSlot, AgentStep,
  StepResult, TransitionResult, TransitionRule,
} from '@core/types/thread-types.js';

// --- Thread lifecycle events ---
// Published on the shared bus (job-registry ctx — the same seam the runner's session.message
// publish uses) so the web UI / TUI thread views refetch on lifecycle edges. No-op without a bus.

function publishThreadEvent(e: Record<string, unknown>): void {
  jobCtx.bus?.publish(e as any);
}

/** `agent` or `agent:stage` — matches the transition endpoint syntax (runner's status label). */
function stepLabel(agentSlotId: AgentSlotId, stage: string | null | undefined): string {
  return stage ? `${agentSlotId}:${stage}` : agentSlotId;
}

// --- Agent slot helpers ---

function newAgentSlot(config: AgentSlotConfig): AgentSlot {
  return {
    slotId: config.slotId,
    profile: config.profile,
    sessionId: null,
    sessionName: null,
    status: 'idle',
    lastOutput: null,
    persistSession: config.persistSession,
  };
}

function buildTemplateSlots(templateName: string): { agentSlots: Record<AgentSlotId, AgentSlot>; entryAgent: AgentSlotId; entryStage: string | null } {
  const template = getTemplate(templateName);
  if (!template) throw new Error(`Unknown thread template: ${templateName}`);
  const entryAgent = resolveActiveAgentName(template.entryAgent);
  const agentSlots: Record<AgentSlotId, AgentSlot> = {};
  let entryConfig: AgentSlotConfig | null = null;
  for (const config of resolveTemplateAgents(template)) {
    agentSlots[config.slotId] = newAgentSlot(config);
    if (config.slotId === entryAgent) entryConfig = config;
  }
  const entryStage = resolveStageName(entryConfig, template.entryStage || null);
  return { agentSlots, entryAgent, entryStage };
}

function buildAdHocSlots(agentName: string): { agentSlots: Record<AgentSlotId, AgentSlot>; entryAgent: AgentSlotId; entryStage: string | null } {
  const agentConfig = resolveAgentSlotConfigByName(agentName);
  if (!agentConfig) throw new Error(`Unknown agent: ${agentName}`);
  return {
    agentSlots: { [agentConfig.slotId]: newAgentSlot(agentConfig) },
    entryAgent: agentConfig.slotId,
    entryStage: resolveStageName(agentConfig, null),
  };
}

function createWorkspace(threadId: string): { workspacePath: string; artifactPath: string } {
  const workspacePath = path.join(WORKSPACE_DIR, 'threads', threadId);
  const artifactPath = path.join(workspacePath, 'artifact.md');
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(artifactPath, '');
  return { workspacePath, artifactPath };
}

/** sha256 of the artifact content at `artifactPath` (missing/unreadable file → hash of ''). */
function hashArtifactAt(artifactPath: string): string {
  let content = '';
  try { content = readFileSync(artifactPath, 'utf8'); } catch { /* absent == empty */ }
  return createHash('sha256').update(content).digest('hex');
}

/** DR-0017 W2 checkpoint gate predicate: true iff the thread HAS a recorded step-start
 *  baseline and the artifact content still matches it (i.e. the agent has not written its
 *  checkpoint this step). Every uncertain case — no artifactPath, no baseline — returns
 *  false so the gate FAILS OPEN (never blocks a legitimate wait). */
export function isArtifactUnchangedSinceStepStart(threadId: string): boolean {
  const thread = threadStore.get(threadId);
  if (!thread?.artifactPath) return false;
  const baseline = thread.metadata?.stepStartArtifactHash;
  if (!baseline) return false;
  return hashArtifactAt(thread.artifactPath) === baseline;
}

/** Templates whose dispatch threads keep their artifact on the TASK node instead of the
 *  tmp workspace (DR-0017 W1): durable, git-versioned with the context repo, survives
 *  thread death/rotation/cleanup. Comma-separated env override. */
export function isTaskArtifactTemplate(templateName: string | null | undefined): boolean {
  if (!templateName) return false;
  const raw = process.env.CORTEX_TASK_ARTIFACT_TEMPLATES ?? 'manager';
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(templateName);
}

interface ThreadRecordInit {
  id: string;
  channel: string;
  projectId?: string;                // defaults to 'general' in makeThreadRecord
  templateName: string | null;
  platformThreadId: string | null;
  userMessage: string;
  userMessageTs: string;
  workspacePath: string;
  artifactPath: string;
  agents: Record<AgentSlotId, AgentSlot>;
  activeAgent: AgentSlotId;
  activeStage: string | null;
  metadata: import('@core/types/thread-types.js').ThreadMetadata | null;
}

function makeThreadRecord(init: ThreadRecordInit): ThreadRecord {
  const now = new Date().toISOString();
  return {
    ...init,
    projectId: init.projectId ?? 'general',
    status: 'running',
    currentStepIndex: 0,
    steps: [],
    iterationCounts: {},
    totalCostUsd: 0,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    error: null,
    abortReason: null,
  };
}

// --- Thread creation ---

export function createThread(channel: string, options: {
  templateName?: string | null;
  agentName?: string | null;
  userMessage: string;
  userMessageTs: string;
  platformThreadId?: string | null;
  projectId?: string;
  metadata?: import('@core/types/thread-types.js').ThreadMetadata | null;
}): ThreadRecord {
  const isTemplate = !!options.templateName;
  if (!isTemplate && !options.agentName) {
    throw new Error('createThread requires either templateName or agentName');
  }
  const { agentSlots, entryAgent, entryStage } = isTemplate
    ? buildTemplateSlots(options.templateName!)
    : buildAdHocSlots(options.agentName!);
  const id = threadStore.generateId();
  const { workspacePath, artifactPath: workspaceArtifact } = createWorkspace(id);
  // DR-0017 W1: a manager-template dispatch thread anchors its artifact on the task node
  // (context/projects/{project}/manager/{taskId}/artifact.md). An existing artifact is
  // inherited, never truncated — a new incarnation continues from the last checkpoint.
  const m = options.metadata;
  const artifactPath = (isTaskArtifactTemplate(options.templateName) && m?.taskId && m?.taskProject)
    ? ensureTaskArtifact(m.taskProject, m.taskId)
    : workspaceArtifact;

  const thread = makeThreadRecord({
    id, channel,
    projectId: options.projectId,
    templateName: options.templateName || null,
    platformThreadId: options.platformThreadId || null,
    userMessage: options.userMessage,
    userMessageTs: options.userMessageTs,
    workspacePath, artifactPath,
    agents: agentSlots, activeAgent: entryAgent, activeStage: entryStage,
    // DR-0017 W2: baseline for the checkpoint gate — the artifact state the first step starts
    // against (non-empty for a rehydrated manager inheriting a task-keyed artifact).
    metadata: { ...(options.metadata ?? {}), stepStartArtifactHash: hashArtifactAt(artifactPath) },
  });
  threadStore.set(thread);
  publishThreadEvent({ type: 'thread.created', threadId: id, templateName: options.templateName || 'ad-hoc' });
  const mode = isTemplate ? `template=${options.templateName}` : `agent=${options.agentName}`;
  log.info(`Created thread ${id} (${mode}, workspace=${workspacePath})`);
  return thread;
}

// --- Add agent to existing thread ---

/** Lazy workspace creation for auto-records that started without a filesystem workspace. */
function ensureThreadWorkspace(thread: ThreadRecord): void {
  if (thread.workspacePath) return;
  thread.workspacePath = path.join(WORKSPACE_DIR, 'threads', thread.id);
  thread.artifactPath = path.join(thread.workspacePath, 'artifact.md');
  mkdirSync(thread.workspacePath, { recursive: true });
  writeFileSync(thread.artifactPath, '');
}

/** Add or reset an agent slot, preserving any existing persistent session. */
function upsertAgentSlot(thread: ThreadRecord, config: AgentSlotConfig): void {
  const existing = thread.agents[config.slotId];
  thread.agents[config.slotId] = {
    slotId: config.slotId,
    profile: config.profile,
    sessionId: existing?.sessionId || null,
    ...(existing?.backendSessionId !== undefined ? { backendSessionId: existing.backendSessionId } : {}),
    sessionName: existing?.sessionName || null,
    status: 'idle',
    lastOutput: null,
    persistSession: config.persistSession,
  };
}

export async function addAgentToThread(threadId: string, agentName: string, userMessage?: string | null): Promise<ThreadRecord> {
  const thread = threadStore.get(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  const agentConfig = resolveAgentSlotConfigByName(agentName);
  if (!agentConfig) throw new Error(`Unknown agent: ${agentName}`);

  ensureThreadWorkspace(thread);

  await threadStore.mutate(threadId, (t) => {
    upsertAgentSlot(t, agentConfig);
    t.activeAgent = agentName;
    t.activeStage = resolveStageName(agentConfig, null);
    t.status = 'running';
    if (userMessage) t.userMessage = userMessage;
    t.endedAt = null;
    t.error = null;
  });
  log.info(`Added agent ${agentName} to thread ${threadId}`);
  return thread;
}

// --- Step resolution ---

interface NextStepInfo {
  agentSlotId: AgentSlotId;
  agentConfig: AgentSlotConfig;
  isFirstStep: boolean;
  stage: string | null;
}

function resolveAdHocNextStep(thread: ThreadRecord): NextStepInfo | null {
  const agentConfig = resolveAgentSlotConfigByName(thread.activeAgent);
  if (!agentConfig) return null;
  const stage = resolveStageName(agentConfig, thread.activeStage);
  return { agentSlotId: thread.activeAgent, agentConfig, isFirstStep: thread.steps.length === 0, stage };
}

function resolveTemplateNextStep(thread: ThreadRecord): NextStepInfo | null {
  const template = getTemplate(thread.templateName!);
  if (!template) return null;
  const resolvedAgents = resolveTemplateAgents(template);
  const isFirstStep = thread.steps.length === 0;
  const target = isFirstStep ? resolveActiveAgentName(template.entryAgent) : thread.activeAgent;
  const agentConfig = resolvedAgents.find(a => a.slotId === target);
  if (!agentConfig) return null;
  const explicit = isFirstStep ? (template.entryStage || null) : thread.activeStage;
  const stage = resolveStageName(agentConfig, explicit);
  return { agentSlotId: target, agentConfig, isFirstStep, stage };
}

export function resolveNextStep(threadId: string): NextStepInfo | null {
  const thread = threadStore.get(threadId);
  if (!thread || thread.status !== 'running') return null;
  return thread.templateName ? resolveTemplateNextStep(thread) : resolveAdHocNextStep(thread);
}

// --- Step session identity (track/backend id decoupling) ---

/** Prepare the slot's session ids for a step about to run, mirroring the direct path's
 *  trackSessionId/backendSessionId split (conversation-runner):
 *  - `trackSessionId` (slot.sessionId) — stable Cortex id, the conversation-history / UI
 *    transcript key + CORTEX_SESSION_ID. Minted HERE (before the agent spawns) and persisted,
 *    so a RUNNING step is queryable/streamable by the web UI. persistSession slots keep it
 *    across steps; non-persist slots get a fresh one per step (fresh conversation).
 *  - `resumeSessionId` (slot.backendSessionId) — the backend `--resume` target, resolved at
 *    the previous settle. Legacy records (field absent) held the backend id in slot.sessionId:
 *    migrated in place, keeping that id as BOTH keys for history continuity.
 *  Publishes `thread.step.started` after persisting, so subscribers refetching `threads.get`
 *  already see the new sessionId. */
export async function beginStepSession(
  threadId: string,
  agentSlotId: AgentSlotId,
  stage: string | null,
): Promise<{ trackSessionId: string; resumeSessionId: string | null }> {
  let track = '';
  let resume: string | null = null;
  await threadStore.mutate(threadId, (t) => {
    const slot = t.agents[agentSlotId];
    if (!slot) throw new Error(`Agent slot not found: ${agentSlotId} in ${threadId}`);
    if (slot.backendSessionId === undefined) slot.backendSessionId = slot.sessionId ?? null;
    if (!slot.sessionId || !slot.persistSession) slot.sessionId = randomUUID();
    track = slot.sessionId;
    resume = slot.persistSession ? (slot.backendSessionId ?? null) : null;
  });
  publishThreadEvent({ type: 'thread.step.started', threadId, step: stepLabel(agentSlotId, stage) });
  return { trackSessionId: track, resumeSessionId: resume };
}

// --- Step result recording ---

interface StepResultInput {
  sessionId?: string | null;
  backendSessionId?: string | null;
  sessionName?: string | null;
  executionId?: string | null;
  input?: string | null;
  startedAt?: string | null;
  output: string | null;
  costUsd: number | null;
  numTurns: number | null;
  durationS: number | null;
  stage?: string | null;
}

function makeAgentStep(stepIndex: number, agentSlotId: AgentSlotId, result: StepResultInput): AgentStep {
  return {
    stepIndex, agentSlotId,
    stage: result.stage ?? null,
    executionId: result.executionId || null,
    sessionId: result.sessionId || null,
    backendSessionId: result.backendSessionId ?? null,
    sessionName: result.sessionName || null,
    input: result.input || '',
    output: result.output,
    costUsd: result.costUsd,
    numTurns: result.numTurns,
    durationS: result.durationS,
    startedAt: result.startedAt || null,
    endedAt: new Date().toISOString(),
  };
}

function updateSlotAfterStep(slot: AgentSlot, result: StepResultInput): void {
  slot.status = 'completed';
  slot.lastOutput = result.output;
  if (result.sessionId && slot.persistSession) slot.sessionId = result.sessionId;
  // Backend resume target for the next step of a persist slot (track/backend decoupling).
  if (result.backendSessionId && slot.persistSession) slot.backendSessionId = result.backendSessionId;
  if (result.sessionName) slot.sessionName = result.sessionName;
}

export async function recordStepResult(threadId: string, agentSlotId: AgentSlotId, result: StepResultInput): Promise<AgentStep> {
  const thread = threadStore.get(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  const step = makeAgentStep(thread.currentStepIndex, agentSlotId, result);

  await threadStore.mutate(threadId, (t) => {
    t.steps.push(step);
    t.currentStepIndex++;
    if (result.costUsd != null) t.totalCostUsd += result.costUsd;
    const slot = t.agents[agentSlotId];
    if (slot) updateSlotAfterStep(slot, result);
    // DR-0017 W2: the artifact as this step left it IS the next step's start state
    // (nothing writes the artifact between steps) — refresh the checkpoint-gate baseline.
    if (t.artifactPath) (t.metadata ??= {}).stepStartArtifactHash = hashArtifactAt(t.artifactPath);
  });
  publishThreadEvent({
    type: 'thread.step.finished',
    threadId,
    step: stepLabel(agentSlotId, result.stage ?? null),
    result: (result.output ?? '').slice(0, 200),
  });
  return step;
}

// --- Transition evaluation ---

function checkTemplateLimits(thread: ThreadRecord, template: ThreadTemplate): TransitionResult | null {
  if (thread.currentStepIndex >= template.maxTotalSteps) {
    return { shouldTransition: false, reason: 'max_iterations' };
  }
  if (template.maxTotalCostUsd != null && thread.totalCostUsd >= template.maxTotalCostUsd) {
    return { shouldTransition: false, reason: 'cost_limit' };
  }
  // DR-0014: per-thread delegation-contract budget (second gate after the spawn-time
  // tree guards — catches a single thread burning through its allowance step by step).
  if (checkContractBudget(thread)) {
    return { shouldTransition: false, reason: 'cost_limit' };
  }
  return null;
}

function applyTransition(thread: ThreadRecord, rule: TransitionRule, result: TransitionResult): TransitionResult {
  if (rule.condition.type === 'convergence') {
    const edgeKey = `${rule.from}→${rule.to}`;
    thread.iterationCounts[edgeKey] = (thread.iterationCounts[edgeKey] || 0) + 1;
  }
  thread.activeAgent = result.nextAgent!;
  thread.activeStage = result.nextStage ?? null;
  threadStore.set(thread);
  publishThreadEvent({ type: 'thread.transitioned', threadId: thread.id, from: rule.from, to: rule.to });
  return result;
}

/** Does `rule.from` match the last step? Matches on `(agent, stage)`: a bare `agent` endpoint
 *  matches any stage of that agent; an `agent:stage` endpoint matches only that specific stage. */
function ruleFromMatches(rule: TransitionRule, lastStep: AgentStep): boolean {
  const parsed = parseTarget(rule.from);
  if (parsed.agent !== lastStep.agentSlotId) return false;
  if (parsed.stage === null) return true;
  // Rule explicitly pins a stage — only match if last step ran that stage.
  const lastStage = lastStep.stage ?? resolveStageName(getAgent(lastStep.agentSlotId), null);
  return parsed.stage === lastStage;
}

function readArtifactOutput(thread: ThreadRecord, step: AgentStep): string {
  try {
    return readFileSync(thread.artifactPath, 'utf8');
  } catch {
    return step.output || '';
  }
}

/** Resolve rule.to into the concrete (agent, stage) that should execute next. */
function resolveTransitionTo(rule: TransitionRule): { nextAgent: string; nextStage: string | null } {
  const { agent, stage } = parseTarget(rule.to);
  const agentDef = getAgent(agent);
  return { nextAgent: agent, nextStage: resolveStageName(agentDef, stage) };
}

function evaluateConvergence(thread: ThreadRecord, rule: TransitionRule, output: string): TransitionResult {
  const marker = rule.condition.marker || '';
  const maxIter = rule.condition.maxIterations || 3;
  const count = thread.iterationCounts[`${rule.from}→${rule.to}`] || 0;
  if (marker && output.includes(marker)) return { shouldTransition: false, reason: 'converged' };
  if (count >= maxIter) return { shouldTransition: false, reason: 'max_iterations' };
  const { nextAgent, nextStage } = resolveTransitionTo(rule);
  return { shouldTransition: true, nextAgent, nextStage, reason: 'transition' };
}

function evaluatePatternMatch(rule: TransitionRule, output: string, expectMatch: boolean): TransitionResult {
  const pattern = rule.condition.pattern || '';
  try {
    const matches = new RegExp(pattern).test(output);
    if (matches === expectMatch) {
      const { nextAgent, nextStage } = resolveTransitionTo(rule);
      return { shouldTransition: true, nextAgent, nextStage, reason: 'transition' };
    }
  } catch {
    log.error(`Invalid regex pattern in ${rule.condition.type}: ${pattern}`);
  }
  return { shouldTransition: false, reason: 'no_matching_transition' };
}

function evaluateCondition(thread: ThreadRecord, step: AgentStep, rule: TransitionRule): TransitionResult {
  switch (rule.condition.type) {
    case 'always': {
      const { nextAgent, nextStage } = resolveTransitionTo(rule);
      return { shouldTransition: true, nextAgent, nextStage, reason: 'transition' };
    }
    case 'convergence':
      return evaluateConvergence(thread, rule, readArtifactOutput(thread, step));
    case 'output_contains':
      return evaluatePatternMatch(rule, readArtifactOutput(thread, step), true);
    case 'output_not_contains':
      return evaluatePatternMatch(rule, readArtifactOutput(thread, step), false);
    default:
      return { shouldTransition: false, reason: 'no_matching_transition' };
  }
}

export function evaluateTransitions(threadId: string): TransitionResult {
  const fallback: TransitionResult = { shouldTransition: false, reason: 'no_matching_transition' };
  const thread = threadStore.get(threadId);
  if (!thread || !thread.templateName) return fallback;

  const template = getTemplate(thread.templateName);
  if (!template) return fallback;

  const limit = checkTemplateLimits(thread, template);
  if (limit) return limit;

  const lastStep = thread.steps[thread.steps.length - 1];
  if (!lastStep) return fallback;

  const applicableRules = template.transitions.filter(r => ruleFromMatches(r, lastStep));
  for (const rule of applicableRules) {
    const result = evaluateCondition(thread, lastStep, rule);
    if (result.shouldTransition) return applyTransition(thread, rule, result);
    if (result.reason === 'converged' || result.reason === 'max_iterations') return result;
  }
  return fallback;
}

// --- Thread lifecycle ---

export async function cancelThread(threadId: string): Promise<boolean> {
  const thread = threadStore.get(threadId);
  if (!thread) return false;
  if (thread.status === 'completed' || thread.status === 'failed'
      || thread.status === 'cancelled' || thread.status === 'aborted') return false;

  await threadStore.mutate(threadId, (t) => {
    t.status = 'cancelled';
    t.endedAt = new Date().toISOString();
  });
  // No dedicated cancelled/aborted event variants — map to thread.failed so every
  // subscribed thread view (web/TUI) gets its terminal refetch hint.
  publishThreadEvent({ type: 'thread.failed', threadId, error: 'cancelled' });
  log.info(`Cancelled thread ${threadId}`);
  return true;
}

// --- Out-of-band control plane (DR-0015 problem 1) ---
// Agents signal abort / split / wait_children by calling explicit MCP tools (thread_abort /
// thread_split / thread_wait), which write metadata.pendingControl on their own thread via the
// webhook `control` action. The runner reads that typed field at the step boundary — NEVER by
// scanning the artifact for string markers. This eliminates the false-positive class where worker
// prose that merely mentions "[ABORT]" / "No [ABORT]" / a plan saying "[ABORT: too-big]" used to
// trip a real control action (2026-06-13 double-abort incident, DR-0015).

export type PendingControl = NonNullable<ThreadRecord['metadata']>['pendingControl'];

/** Peek the thread's pending control signal (does NOT clear it). Returns null when none set. */
export function peekPendingControl(threadId: string): PendingControl | null {
  return threadStore.get(threadId)?.metadata?.pendingControl ?? null;
}

/** Clear the thread's pending control signal so an intent fires exactly once. */
export async function clearPendingControl(threadId: string): Promise<void> {
  const thread = threadStore.get(threadId);
  if (!thread?.metadata?.pendingControl) return;
  await threadStore.mutate(threadId, (t) => {
    if (t.metadata) t.metadata.pendingControl = null;
  });
}

/** Derive a split detection from a thread's pending control signal — the dispatch path's
 *  injected `detect` (replaces the old artifact-scanning detectSplitMarker). The subtask array
 *  was validated as a typed tool argument, so the only "error" case is an empty array. */
export function detectSplitFromControl(threadId: string): SplitDetection {
  const control = peekPendingControl(threadId);
  if (!control || control.action !== 'split') return { split: false, subtasks: null, error: null };
  const subtasks = control.subtasks;
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    return { split: true, subtasks: null, error: 'thread_split called with an empty subtasks array' };
  }
  return { split: true, subtasks, error: null };
}

function isTerminal(status: ThreadRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'aborted';
}

interface WaitTargets {
  onTasks?: string[] | null;
  onThreads?: string[] | null;
}

function hasExplicitWaitTargets(targets?: WaitTargets): boolean {
  return targets?.onTasks != null || targets?.onThreads != null;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function threadWaitCandidates(parent: ThreadRecord, requested?: string[]): string[] {
  const inferred = parent.metadata?.waitingOn ?? [];
  const candidates = uniqueIds(requested ?? inferred);
  if (requested == null) return candidates;
  const linked = new Set([...(parent.metadata?.childThreadIds ?? []), ...inferred]);
  return candidates.filter((id) => linked.has(id)
    || threadStore.get(id)?.metadata?.parentThreadId === parent.id);
}

/** Live (open, unblocked) child tasks of the given task, read straight from TASKS.yaml via
 *  the zero-dependency core parser — no domain/tasks import (avoids a layer cycle).
 *  Wait set = UNION of parent-linked children and the task's own unmet depends_on: any
 *  not-done dependency at manager runtime was added by the manager itself (pre-existing
 *  deps were cleared before dispatch by the actionability filter), so suspension stays
 *  correct even when the manager created children without the parent field (bulk-add +
 *  edit --add-depends-on instead of decompose --keep-parent — 2026-06-11 incident
 *  thr_6faa13a1: [WAIT_CHILDREN] emitted, suspension found no children, thread completed). */
function liveChildTaskIds(taskId: string, taskProject: string): string[] {
  try {
    const tasks = scanAllTasks(taskProject);
    const own = tasks.find((t) => t.id === taskId);
    const depIds = new Set(own?.depends_on ?? []);
    return tasks
      .filter((t) => t.id && t.id !== taskId
        && (t.parent === taskId || depIds.has(t.id))
        && t.status !== 'done' && !t.blocked_by)
      .map((t) => t.id);
  } catch {
    return [];
  }
}

function liveTaskWaitIds(taskId: string | undefined, project: string | undefined, requested?: string[]): string[] {
  if (!taskId || !project || requested?.length === 0) return [];
  const live = liveChildTaskIds(taskId, project);
  if (requested == null) return live;
  const linked = new Set(live);
  return uniqueIds(requested).filter((id) => linked.has(id));
}

function resolveWaitSets(thread: ThreadRecord, targets?: WaitTargets): { threads: string[]; tasks: string[] } {
  const explicit = hasExplicitWaitTargets(targets);
  return {
    threads: threadWaitCandidates(thread, explicit ? (targets?.onThreads ?? []) : undefined),
    tasks: liveTaskWaitIds(
      thread.metadata?.taskId ?? undefined,
      thread.metadata?.taskProject ?? undefined,
      explicit ? (targets?.onTasks ?? []) : undefined,
    ),
  };
}

/** Try to suspend the thread until its waited-on children finish. With no targets, infer
 *  live task/thread children; supplying either target list replaces the entire inferred set.
 *  Inside one store mutation, persist both resolved sets and enter waiting when either is non-empty.
 *  Returns true iff the thread entered waiting.
 *  Either interleaving with the completion callback converges: callback-first → nothing
 *  left to wait on (results already in pendingMessages); runner-first → callback sees
 *  waiting and resumes when both lists empty. The task-side race (a child completing
 *  between the snapshot and the waiting persist, its event missed) is closed by
 *  reconcileWaitingTasks right after suspension. */
export async function tryEnterWaiting(threadId: string, targets?: WaitTargets): Promise<boolean> {
  const thread = threadStore.get(threadId);
  if (!thread) return false;
  const explicit = hasExplicitWaitTargets(targets);
  const hasInferredSources = !!thread.metadata?.waitingOn?.length
    || !!(thread.metadata?.taskId && thread.metadata?.taskProject);
  if (!explicit && !hasInferredSources) return false;

  const waitSets = resolveWaitSets(thread, targets);
  let liveThreads: string[] = [];
  let entered = false;
  await threadStore.mutate(threadId, (t) => {
    const m = (t.metadata ??= {});
    liveThreads = waitSets.threads.filter((id) => {
      const child = threadStore.get(id);
      return !!child && !isTerminal(child.status);
    });
    m.waitingOn = liveThreads;
    m.waitingOnTasks = waitSets.tasks;
    if (liveThreads.length > 0 || waitSets.tasks.length > 0) {
      t.status = 'waiting';
      entered = true;
    }
  });
  if (entered) {
    log.info(`Thread ${threadId} suspended, waiting on ${liveThreads.length} thread children + ${waitSets.tasks.length} task children`);
  }
  return entered;
}

export interface SplitDetection {
  split: boolean;
  subtasks: any[] | null;
  error: string | null;
}

/** Terminate the thread with status='aborted'. Idempotent — returns false if thread is already terminal. */
export async function abortThread(threadId: string, reason: string | null): Promise<boolean> {
  const thread = threadStore.get(threadId);
  if (!thread) return false;
  if (thread.status === 'completed' || thread.status === 'failed'
      || thread.status === 'cancelled' || thread.status === 'aborted') return false;

  await threadStore.mutate(threadId, (t) => {
    t.status = 'aborted';
    t.abortReason = reason;
    t.endedAt = new Date().toISOString();
  });
  publishThreadEvent({ type: 'thread.failed', threadId, error: `aborted${reason ? `: ${reason}` : ''}` });
  const reasonTag = reason ? ` (${reason})` : '';
  log.info(`Aborted thread ${threadId}${reasonTag}`);
  return true;
}

export async function completeThread(threadId: string): Promise<boolean> {
  const thread = threadStore.get(threadId);
  if (!thread) return false;

  await threadStore.mutate(threadId, (t) => {
    t.status = 'completed';
    t.endedAt = new Date().toISOString();
  });
  publishThreadEvent({ type: 'thread.completed', threadId });
  log.info(`Completed thread ${threadId}`);
  return true;
}

export async function failThread(threadId: string, error: string): Promise<boolean> {
  const thread = threadStore.get(threadId);
  if (!thread) return false;

  await threadStore.mutate(threadId, (t) => {
    t.status = 'failed';
    t.error = error;
    t.endedAt = new Date().toISOString();
  });
  publishThreadEvent({ type: 'thread.failed', threadId, error });
  log.info(`Failed thread ${threadId}: ${error}`);
  return true;
}

/** Pause a thread that was interrupted mid-run by an API rate limit. Non-terminal: the
 *  thread keeps its currentStepIndex/agents and is re-entered (from the interrupted step)
 *  by the resume-dispatcher when the rate-limit window resets. Does NOT set endedAt.
 *  Idempotent. */
export async function markThreadRateLimited(
  threadId: string,
  provider?: string | null,
  note?: string,
): Promise<boolean> {
  const thread = threadStore.get(threadId);
  if (!thread) return false;

  await threadStore.mutate(threadId, (t) => {
    t.status = 'rate_limited';
    t.error = note ?? 'Paused — interrupted by API rate limit';
    const metadata = t.metadata ??= {};
    metadata.interruptedByRateLimit = true;
    if (provider !== undefined) metadata.rateLimitProvider = provider;
  });
  log.info(`Rate-limit paused thread ${threadId}`);
  return true;
}
