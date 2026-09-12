// input:  one task + role, a cwd, the parent's env, and a nested-session factory
// output: one SubagentResult from a nested in-process PI session
// pos:    Runs a `pi` subagent child, for both the PI shim and the daemon runner
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import type { AgentRole } from '@domain/agents/roles.js';
import { roleToolsForBackend } from '@domain/agents/roles.js';
import { addTurnUsage, emptyUsage, finiteNumber } from '@domain/agents/subagent/usage.js';
import type {
  ChildAccumulator, ChildEventForwarder, SubagentResult, SubagentTask,
} from '@domain/agents/subagent/types.js';
import { createChildSession, type ChildSessionFactory, type ChildSessionHandle } from './child-session.js';
import { messageEndMessage, textFromMessage } from './child-events.js';
import { PI_INTERACTION_BRIDGE_ENV } from './session-options.js';

/** The parent's current model, offered when neither the task nor the role names one. */
export interface PiModelFallback {
  id: string;
  provider?: string;
}

export interface PiChildRequest {
  task: SubagentTask;
  role: AgentRole;
  cwd: string;
  /** PI agent dir whose auth.json and models.json the child authenticates and routes with. */
  agentDir: string;
  /** The parent session's env; the child's is derived from it. */
  parentEnv: NodeJS.ProcessEnv;
  fallbackModel?: PiModelFallback | null;
  /** Nested session factory; tests substitute a fake. */
  createSession?: ChildSessionFactory;
  /** The Cortex extensions the child loads, closed over the child's own env. */
  childExtensions: (env: NodeJS.ProcessEnv) => InlineExtension[];
  signal?: AbortSignal;
  forward?: ChildEventForwarder;
}

/** Explicit task model → role model → the parent's current model. */
export function selectPiModel(
  task: SubagentTask,
  role: AgentRole,
  fallback?: PiModelFallback | null,
): { model?: string; provider?: string } {
  const explicit = task.model?.trim();
  if (explicit) return { model: explicit };
  const roleModel = role.model?.trim();
  if (roleModel) return { model: roleModel };
  if (fallback) return { model: fallback.id, provider: fallback.provider };
  return {};
}

/** The child's env: the parent's, marked as a subagent and stripped of the thread scope and the
 *  interaction bridge, so the child's tool shims skip the Agent tool and its MCP bridge loads only
 *  the core bundle. */
export function buildChildEnv(parentEnv: NodeJS.ProcessEnv, agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv, PI_CODING_AGENT_DIR: agentDir, CORTEX_PI_SUBAGENT: '1' };
  delete env.CORTEX_THREAD_ID;
  delete env.CORTEX_TASK_ID;
  delete env[PI_INTERACTION_BRIDGE_ENV];
  return env;
}

/** Run one task on its own nested PI session; the session is disposed however the run ends. */
export async function runPiChild(request: PiChildRequest): Promise<SubagentResult> {
  const { task, role } = request;
  const selection = selectPiModel(task, role, request.fallbackModel);
  const create = request.createSession ?? createChildSession;
  const handle = await create({
    cwd: request.cwd,
    agentDir: request.agentDir,
    provider: selection.provider ?? null,
    model: selection.model ?? null,
    tools: roleToolsForBackend(role, 'pi'),
    appendSystemPrompt: role.systemPrompt ? [role.systemPrompt] : [],
    extensions: request.childExtensions(buildChildEnv(request.parentEnv, request.agentDir)),
  });
  try {
    const result = await collectChild(handle, task, request.signal, request.forward);
    if (!result.model) result.model = selection.model;
    return result;
  } finally {
    handle.dispose();
  }
}

/**
 * Drive the child through one prompt. PI's `prompt()` resolves once the run is over, so the
 * accumulator is complete when it returns; an abort in the meantime stops the run and rejects,
 * whatever PI's own stop reason ended up being.
 */
async function collectChild(
  handle: ChildSessionHandle,
  task: SubagentTask,
  signal: AbortSignal | undefined,
  forward?: ChildEventForwarder,
): Promise<SubagentResult> {
  if (signal?.aborted) throw new Error('Subagent was aborted.');
  const accumulator: ChildAccumulator = { output: '', usage: emptyUsage() };
  const unsubscribe = handle.session.subscribe((event) => {
    processEvent(accumulator, event as unknown as Record<string, unknown>, forward);
  });
  const onAbort = (): void => { void handle.session.abort().catch(() => undefined); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await handle.session.prompt(`Task: ${task.prompt}`);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    unsubscribe();
  }
  if (signal?.aborted) throw new Error('Subagent was aborted.');
  return childResult(task, accumulator);
}

export function childResult(task: SubagentTask, accumulator: ChildAccumulator): SubagentResult {
  return {
    description: task.description,
    prompt: task.prompt,
    subagentType: task.subagent_type,
    output: accumulator.output,
    usage: accumulator.usage,
    model: accumulator.model,
    backend: 'pi',
    stopReason: accumulator.stopReason,
    errorMessage: accumulator.errorMessage,
  };
}

function processEvent(
  accumulator: ChildAccumulator,
  event: Record<string, unknown>,
  forward?: ChildEventForwarder,
): void {
  // Forward FIRST and unconditionally: the accumulator only cares about `message_end`, but the
  // transcript wants the child's tool calls too. The model is read off the accumulator so a notice
  // can name it as soon as the child's first message reports one.
  if (forward) {
    try { forward(event, accumulator); }
    catch { /* the channel is best-effort: a broken notice must not fail the subagent */ }
  }
  const message = messageEndMessage(event);
  if (!message) return;
  recordUsage(accumulator, message);
  recordAssistantMessage(accumulator, message);
}

function recordUsage(accumulator: ChildAccumulator, message: Record<string, unknown>): void {
  if (message.role !== 'assistant') return;
  const usage = message.usage as Record<string, unknown> | undefined;
  const cost = usage?.cost as Record<string, unknown> | undefined;
  addTurnUsage(accumulator.usage, {
    input: finiteNumber(usage?.input),
    output: finiteNumber(usage?.output),
    cacheRead: finiteNumber(usage?.cacheRead),
    cacheWrite: finiteNumber(usage?.cacheWrite),
    cost: finiteNumber(cost?.total),
    contextTokens: finiteNumber(usage?.totalTokens),
    turns: 1,
  });
}

function stringOrPrevious(value: unknown, previous: string | undefined): string | undefined {
  return typeof value === 'string' ? value : previous;
}

function recordTerminalState(accumulator: ChildAccumulator, message: Record<string, unknown>): void {
  const stopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined;
  if (!stopReason) {
    accumulator.errorMessage = stringOrPrevious(message.errorMessage, accumulator.errorMessage);
    return;
  }
  accumulator.stopReason = stopReason;
  accumulator.errorMessage = typeof message.errorMessage === 'string' ? message.errorMessage : undefined;
}

function recordAssistantMessage(
  accumulator: ChildAccumulator,
  message: Record<string, unknown>,
): void {
  if (message.role !== 'assistant') return;
  accumulator.output = textFromMessage(message) || accumulator.output;
  accumulator.model = stringOrPrevious(message.model, accumulator.model);
  recordTerminalState(accumulator, message);
}
