// input:  thread-store, active-handles, mode-manager, domain/threads
// output: executeLifecycleHook — Thread lifecycle hook executor
// pos:    onStart/onTransition/onEnd hook subsystem for the Thread system
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { threadStore } from '@store/thread-repo.js';
import { getSessionKey, recordStepResult, resolveTargetResumeId } from './index.js';
import { runAgent, getClaudeMode, getActiveBackend, getActiveProfile } from '../agents/index.js';
import * as executionRegistry from '../executions/registry.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { DATA_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { Icons } from '../../core/icons.js';
import { runningExecutions } from '../../core/running-executions.js';
import type {
  ThreadHookConfig,
  HookResult,
  HookContext,
  RunThreadOptions,
} from '@core/types/thread-types.js';

const log = createLogger('thread-hook');

const DEFAULT_HOOK_TIMEOUT = 30000;

/** Build context object to pass to hook script via stdin. */
function buildHookContext(threadId: string, phase: 'start' | 'transition' | 'end', previousAgent?: string): HookContext {
  const thread = threadStore.get(threadId)!;
  let artifactContent = '';
  try {
    artifactContent = readFileSync(thread.artifactPath, 'utf8');
  } catch {}

  return {
    threadId,
    templateName: thread.templateName || '',
    phase,
    currentStepIndex: thread.currentStepIndex,
    steps: thread.steps,
    activeAgent: thread.activeAgent,
    previousAgent,
    artifactContent,
    userMessage: thread.userMessage,
    totalCostUsd: thread.totalCostUsd,
    pendingControlAction: thread.metadata?.pendingControl?.action ?? null,
  };
}

/** Execute a hook script and parse its JSON result. Returns { insertAgent: false } on any error.
 *
 *  hookConfig.command is run via `sh -c 'command "$@"' hook <args>`, so the caller can write the
 *  full shell invocation (including interpreter, e.g. "node ~/.cortex/hooks/foo.mjs") and
 *  dynamic hookConfig.args become positional $1..$N on the command line. cwd = DATA_DIR.
 */
async function executeHook(hookConfig: ThreadHookConfig, context: HookContext): Promise<HookResult> {
  const timeout = hookConfig.timeout || DEFAULT_HOOK_TIMEOUT;
  const command = hookConfig.command;
  const args = hookConfig.args || [];
  const label = args.length ? `${command} ${args.join(' ')}` : command;

  return new Promise<HookResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    // `sh -c '<command> "$@"' hook <args>`: the shell parses <command>, then appends <args> as
    // positional params $1..$N. No manual quoting — args with spaces survive intact.
    const proc = spawn('sh', ['-c', `${command} "$@"`, 'hook', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: DATA_DIR,
      timeout,
    });

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        log.error(`Hook error (${label}): ${err.message}`);
        resolve({ insertAgent: false });
      }
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;

      if (code !== 0) {
        log.error(`Hook exited with code ${code} (${label})${stderr ? ': ' + stderr.trim() : ''}`);
        resolve({ insertAgent: false });
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        // Valid if: has insertAgent (boolean), or has targetAgent (string)
        if (typeof result.insertAgent !== 'boolean' && typeof result.targetAgent !== 'string') {
          log.error(`Hook output missing insertAgent or targetAgent field (${label})`);
          resolve({ insertAgent: false });
          return;
        }
        if (typeof result.insertAgent !== 'boolean') result.insertAgent = false;
        resolve(result as HookResult);
      } catch (e: any) {
        log.error(`Failed to parse hook output as JSON (${label}): ${e.message}`);
        resolve({ insertAgent: false });
      }
    });

    // Send context to stdin
    proc.stdin.write(JSON.stringify(context));
    proc.stdin.end();
  });
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

  // Register execution (inherit metadata from thread for correct attribution)
  const meta = thread.metadata;
  const execution = executionRegistry.startLocalExecution({
    kind: meta?.trigger === 'task-dispatch' ? 'dispatch'
      : meta?.trigger === 'scheduled' ? 'scheduled'
      : 'local',
    channel: opts.channel,
    project: thread.projectId,
    trigger: 'thread-hook',
    backend: getActiveBackend(),
    billingMode: getClaudeMode(),
    sessionId,
    label: `[${slackLabel}] ${prompt.substring(0, 40)}`,
    scheduleTaskId: meta?.scheduleTaskId || null,
    threadId,
    agentSlotId: slotId,
  });

  const sessionName = isTargetMode ? null : await sessionStore.generateSessionName();
  const stepStartTime = new Date().toISOString();

  const handle = runAgent(prompt, {
    channel: opts.channel,
    sessionId,
    sessionKey,
    files: [],
    profileName,
    project: thread.projectId,
    trigger: meta?.trigger || undefined,
    onFallback: null,
    isUserInitiated: false,
    onAssistantMessage: (text: string) => {
      opts.adapter.postMessage(opts.destination, { text }, opts.threadAnchorId ? { threadId: opts.threadAnchorId } : undefined).catch(() => {});
    },
    onProgress: null,
  });

  runningExecutions.register({
    threadId,
    channel: opts.channel,
    agentSlotId: slotId,
    executionId: execution.id,
    kind: execution.kind,
    kill: () => handle.kill(),
    backend: getActiveBackend(),
  });

  let result: any;
  try {
    result = await handle.promise;
  } finally {
    runningExecutions.remove(execution.id);
  }

  // Record step
  const stepEndTime = new Date().toISOString();
  const stepDurationS = (new Date(stepEndTime).getTime() - new Date(stepStartTime).getTime()) / 1000;

  await recordStepResult(threadId, slotId, {
    sessionId: result?.sessionId || null,
    sessionName,
    executionId: execution.id,
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
      backend: getActiveBackend(),
      kind: 'local',
      origin: 'thread',
      label: `[${threadId}:${slotId}]`,
      profileName: getActiveProfile(opts.channel),
      projectId: thread.projectId,
    });
  }

  executionRegistry.completeExecution(execution.id, {
    costUsd: result?.total_cost_usd,
    numTurns: result?.num_turns,
    durationS: stepDurationS,
    finalOutput: result?.finalOutput || null,
  });

  log.info(`Hook agent (${slackLabel}) completed for thread ${threadId}`);
}

/** Run a lifecycle hook (onStart/onTransition/onEnd) if configured.
 *  logSuffix lets callers preserve detailed log info (e.g. transition arrows). */
export async function executeLifecycleHook(
  threadId: string,
  phase: 'start' | 'transition' | 'end',
  hookConfig: ThreadHookConfig | undefined,
  opts: RunThreadOptions,
  previousAgent?: string,
  logSuffix?: string,
): Promise<void> {
  if (!hookConfig) return;
  const phaseName = `on${phase[0].toUpperCase()}${phase.slice(1)}`;
  log.info(`Executing ${phaseName} hook for thread ${threadId}${logSuffix ? ' ' + logSuffix : ''}`);
  const hookContext = buildHookContext(threadId, phase, previousAgent);
  const hookResult = await executeHook(hookConfig, hookContext);
  if (hookResult.insertAgent || hookResult.targetAgent) {
    await runHookAgent(threadId, hookResult, phase, opts);
  }
}
