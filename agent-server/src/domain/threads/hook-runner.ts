// input:  thread store, HookBus, agents and run service
// output: lifecycle event emitters and hook-agent execution
// pos:    Adapts thread lifecycle hooks to the shared HookBus
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { readFileSync } from 'fs';
import { randomUUID } from 'node:crypto';
import { threadStore } from '@store/thread-repo.js';
import { getSessionKey, recordStepResult, resolveTargetResumeId } from './index.js';
import { getClaudeMode, getActiveBackend, getActiveProfile } from '../agents/index.js';
import { resolveProfileConfig, type ResolvedProfileConfig } from '../agents/profile-manager.js';
import { sessionStore } from '@store/session-registry-repo.js';
import {
  emitCortexEvent,
  type HookEmitResult,
  type HookSpec,
} from '@core/hook-bus.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { Icons } from '../../core/icons.js';
import { startRun } from '@domain/runs/service.js';
import type { AgentSpec, RunObserver, RunRequest } from '@domain/runs/request.js';
import type { RunEvent } from '@domain/runs/events.js';
import type {
  ThreadHookConfig,
  HookResult,
  HookContext,
  RunThreadOptions,
} from '@core/types/thread-types.js';

const log = createLogger('thread-hook');

const DEFAULT_HOOK_TIMEOUT = 30000;

/** Build the complete payload passed to registry and scoped hooks through stdin. */
function buildHookContext(
  threadId: string,
  phase: 'start' | 'transition' | 'end',
  previousAgent?: string,
): HookContext {
  const thread = threadStore.get(threadId)!;
  let artifactContent = '';
  try {
    artifactContent = readFileSync(thread.artifactPath, 'utf8');
  } catch {}
  const taskProject = thread.metadata?.taskProject ?? null;
  return {
    threadId,
    templateName: thread.templateName || '',
    phase,
    source: thread.metadata?.trigger ?? null,
    project: taskProject ?? thread.projectId,
    projectId: thread.projectId,
    taskId: thread.metadata?.taskId ?? null,
    taskProject,
    currentStepIndex: thread.currentStepIndex,
    steps: thread.steps,
    activeAgent: thread.activeAgent,
    previousAgent: previousAgent ?? null,
    artifactContent,
    userMessage: thread.userMessage,
    totalCostUsd: thread.totalCostUsd,
    pendingControlAction: thread.metadata?.pendingControl?.action ?? null,
  };
}

function normalizeScopedHook(id: string, config: ThreadHookConfig): HookSpec {
  return {
    id,
    command: config.command,
    args: config.args,
    timeoutMs: config.timeout ?? DEFAULT_HOOK_TIMEOUT,
    result: 'hook-result',
  };
}

function asHookResult(emitted: HookEmitResult): HookResult | null {
  if (emitted.error || typeof emitted.result !== 'object' || emitted.result === null) return null;
  const value = emitted.result as Partial<HookResult>;
  if (typeof value.insertAgent !== 'boolean' && typeof value.targetAgent !== 'string') {
    log.error(`Hook output missing insertAgent or targetAgent field (${emitted.id})`);
    return null;
  }
  return {
    ...value,
    insertAgent: typeof value.insertAgent === 'boolean' ? value.insertAgent : false,
  } as HookResult;
}

/** Synthetic profile for an unknown configured name: keeps the requested name so the facade still
 *  rejects it, while its backend/mode mirror the legacy active-backend execution record. */
function fallbackHookProfile(profileName: string): ResolvedProfileConfig {
  return {
    name: profileName,
    model: '',
    backend: getActiveBackend(),
    mode: getClaudeMode(),
    provider: null,
    extraEnv: {},
    extraOption: {},
    claudeBackend: 'print',
    thinking: null,
    maxOutputTokens: null,
    fallback: [],
  };
}

function resolveHookProfile(profileName: string): ResolvedProfileConfig {
  try {
    return resolveProfileConfig(profileName);
  } catch {
    return fallbackHookProfile(profileName);
  }
}

/** Same background policy as a thread step: the hook turn carries a threadId, so the legacy facade
 *  fell back to the settings-gated inline wait. */
function hookBackgroundPolicy(): 'inline' | 'none' {
  return getSettings().bgContinuation ? 'inline' : 'none';
}

/** Run a hook agent and record it as a step in the thread.
 *  Two modes:
 *  - insertAgent: create a new temporary agent (existing behavior)
 *  - targetAgent: send prompt to an existing agent's persistent session (claude-bridge handles alive/dead)
 */
async function runHookAgent(
  threadId: string,
  hookResult: HookResult,
  phase: string,
  opts: RunThreadOptions,
): Promise<void> {
  if (!hookResult.prompt) return;

  const thread = threadStore.get(threadId);
  if (!thread) { log.error(`Thread not found: ${threadId}, skipping hook agent`); return; }
  const isTargetMode = !!hookResult.targetAgent;

  // Determine slotId, sessionKey, sessionId, profile based on mode
  let slotId: string;
  let sessionKey: string;
  let sessionId: string | null;
  let profileName: string;
  let trackSessionId: string | null = null;

  if (isTargetMode) {
    // targetAgent mode: send prompt to existing agent's session
    const targetSlot = thread.agents[hookResult.targetAgent!];
    if (!targetSlot) {
      log.error(`targetAgent "${hookResult.targetAgent}" not found in thread ${threadId}, skipping`);
      return;
    }
    slotId = hookResult.targetAgent!;
    sessionKey = getSessionKey(threadId, slotId);
    // Backend resume target (track/backend decoupling aware): slot.backendSessionId, legacy
    // slot.sessionId fallback, else the slot's most recent step. claude-bridge: the id does not
    // matter while the process is alive (found by sessionKey, stdin write); when dead → --resume.
    sessionId = resolveTargetResumeId(targetSlot, thread.steps);
    trackSessionId = targetSlot.sessionId ?? null;
    profileName = hookResult.profile
      ? (hookResult.profile === '__active__' ? getActiveProfile(opts.channel) : hookResult.profile)
      : (targetSlot.profile === '__active__' ? getActiveProfile(opts.channel) : targetSlot.profile);
  } else {
    // insertAgent mode: create new temporary agent
    if (!hookResult.insertAgent) return;
    slotId = `hook:${phase}`;
    sessionKey = getSessionKey(threadId, slotId);
    sessionId = null;
    profileName = hookResult.profile === '__active__' || !hookResult.profile
      ? getActiveProfile(opts.channel)
      : hookResult.profile;
  }

  let prompt = hookResult.prompt;
  if (hookResult.directive) {
    prompt = hookResult.directive + '\n\n' + prompt;
  }

  // Notify Slack
  const slackLabel = isTargetMode ? `→ ${slotId}` : `hook:${phase}`;
  try {
    await opts.adapter.postMessage(opts.destination, {
      text: `${Icons.hook} Hook agent (*${slackLabel}*) starting...`,
    }, opts.threadAnchorId ? { threadId: opts.threadAnchorId } : undefined);
  } catch {}

  const meta = thread.metadata;
  const executionKind = meta?.trigger === 'task-dispatch' ? 'dispatch'
    : meta?.trigger === 'scheduled' ? 'scheduled'
    : 'local';
  const sessionName = isTargetMode ? null : await sessionStore.generateSessionName();
  const stepStartTime = new Date().toISOString();

  const spec: AgentSpec = {
    systemPrompt: null,
    directive: null,
    promptTemplate: null,
    tools: null,
    pluginDirs: [],
    // The legacy hook path declared no MCP composition, which resolves to 'direct'.
    mcp: { composition: 'direct', allowlist: null },
    backendOptions: {},
  };

  const request: RunRequest = {
    runId: randomUUID(),
    session: {
      sessionId: trackSessionId,
      backendSessionId: sessionId,
      engineKey: sessionKey,
      // The legacy hook path passed no sessionName to the facade; keep it off the spawn context.
      sessionName: null,
    },
    profile: resolveHookProfile(profileName),
    spec,
    prompt: { text: prompt, attachments: [] },
    context: {
      channel: opts.channel,
      project: thread.projectId,
      // One trigger for the execution record and facade cost attribution (the legacy path used
      // 'thread-hook' for the record and the thread trigger for cost).
      trigger: meta?.trigger || 'thread-hook',
      threadId: thread.id,
      threadDepth: meta?.depth ?? 0,
      taskId: meta?.taskId ?? null,
      taskProject: meta?.taskProject ?? null,
      taskGeneration: meta?.dispatchGeneration ?? null,
      scheduleTaskId: meta?.scheduleTaskId ?? null,
      executionKind,
      isUserInitiated: false,
      commissionMode: false,
      commissionTools: false,
    },
    policy: {
      background: hookBackgroundPolicy(),
      recordCost: true,
      hooks: true,
      loadRules: true,
      mcpComposition: 'direct',
      browserCdpEndpoint: null,
      captureTranscripts: false,
    },
  };

  const run = startRun(request, [{
    onEvent(event: RunEvent): void {
      if (event.type !== 'assistant_text') return;
      opts.adapter.postMessage(
        opts.destination, { text: event.text },
        opts.threadAnchorId ? { threadId: opts.threadAnchorId } : undefined,
      ).catch(() => {});
    },
  } satisfies RunObserver]);

  // The run owns the hook turn's execution record, registry registration, teardown and completion.
  // A failed turn rejects here and skips the step record exactly as the legacy finally did.
  const result: any = await run.result;

  // Record step
  const stepEndTime = new Date().toISOString();
  const stepDurationS = (new Date(stepEndTime).getTime() - new Date(stepStartTime).getTime()) / 1000;

  await recordStepResult(threadId, slotId, {
    sessionId: result?.sessionId || null,
    sessionName,
    executionId: run.executionId,
    input: prompt,
    startedAt: stepStartTime,
    output: result?.finalOutput || null,
    costUsd: result?.total_cost_usd || null,
    numTurns: result?.num_turns || null,
    durationS: stepDurationS,
  });

  if (result?.sessionId && sessionName) {
    await sessionStore.registerSession(sessionName, {
      sessionId: result.sessionId,
      channel: opts.channel,
      backend: request.profile.backend,
      kind: 'local',
      origin: 'thread',
      label: `[${threadId}:${slotId}]`,
      profileName,
      projectId: thread.projectId,
    });
  }

  log.info(`Hook agent (${slackLabel}) completed for thread ${threadId}`);
}

export interface LifecycleHookConfigs {
  template?: ThreadHookConfig;
  extra?: ThreadHookConfig;
}

function scopedHooks(
  context: HookContext,
  configs: LifecycleHookConfigs,
): HookSpec[] {
  const hooks: HookSpec[] = [];
  if (configs.template) {
    hooks.push(normalizeScopedHook(`template:${context.templateName}:${context.phase}`, configs.template));
  }
  if (configs.extra) {
    hooks.push(normalizeScopedHook(`extra:${context.threadId}:${context.phase}`, configs.extra));
  }
  return hooks;
}

/** Emit one lifecycle event with registry and per-call scoped hooks. */
export async function executeLifecycleHooks(
  threadId: string,
  phase: 'start' | 'transition' | 'end',
  configs: LifecycleHookConfigs,
  opts: RunThreadOptions,
  previousAgent?: string,
  logSuffix?: string,
): Promise<void> {
  const context = buildHookContext(threadId, phase, previousAgent);
  if (configs.template || configs.extra) {
    const phaseName = `on${phase[0].toUpperCase()}${phase.slice(1)}`;
    log.info(`Executing ${phaseName} hooks for thread ${threadId}${logSuffix ? ` ${logSuffix}` : ''}`);
  }
  const emitted = await emitCortexEvent(`cortex:thread.${phase}`, context, {
    scopedHooks: scopedHooks(context, configs),
  });
  for (const item of emitted) {
    const hookResult = asHookResult(item);
    if (hookResult && (hookResult.insertAgent || hookResult.targetAgent)) {
      await runHookAgent(threadId, hookResult, phase, opts);
    }
  }
}

/** Backward-compatible single scoped-hook entry point. */
export async function executeLifecycleHook(
  threadId: string,
  phase: 'start' | 'transition' | 'end',
  hookConfig: ThreadHookConfig | undefined,
  opts: RunThreadOptions,
  previousAgent?: string,
  logSuffix?: string,
): Promise<void> {
  await executeLifecycleHooks(
    threadId,
    phase,
    { template: hookConfig },
    opts,
    previousAgent,
    logSuffix,
  );
}
