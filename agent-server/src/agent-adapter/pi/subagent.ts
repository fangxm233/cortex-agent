// input:  PI roles, model options, child processes, TypeBox
// output: PI Agent execution with runtime chain prompt notices
// pos:    Orchestrates PI subagents and parses their streams
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Type } from '@sinclair/typebox';
import { parse as yamlParse } from 'yaml';
import { PI_AGENT_DIR, ensurePIAgentRoles } from './agent-dir.js';
import { MCP_BRIDGE_PATH, TOOL_SHIMS_PATH } from './defaults.js';
import type { ExtensionContext, ToolDefinition } from './pi-ext-types.js';
import { PI_INTERACTION_BRIDGE_ENV } from './spawn-args.js';
import { encodeSubagentNotice, type SubagentNotice } from './subagent-notice.js';

export const MAX_SUBAGENT_TASKS = 8;
export const MAX_SUBAGENT_CONCURRENCY = 8;
export const MAX_SUBAGENT_MODEL_CHOICES = 32;
export const MAX_SUBAGENT_MODEL_LIST_CHARS = 1_200;
export const SUBAGENT_KILL_GRACE_MS = 5_000;

const MODEL_OVERRIDE_DESCRIPTION =
  'Optional PI model override in provider/model[:thinking] format. ' +
  'Omit to use the role model, then the current provider/model, then the PI default.';

const TaskSchema = Type.Object({
  description: Type.String({ description: 'Short description of the delegated task.' }),
  prompt: Type.String({ description: 'Complete task prompt for the subagent.' }),
  subagent_type: Type.String({ description: 'Role name, such as explore, general-purpose, or plan.' }),
  model: Type.Optional(Type.String({ description: MODEL_OVERRIDE_DESCRIPTION })),
});

const SubagentParameters = Type.Object({
  description: Type.Optional(Type.String({ description: 'Short description for single mode.' })),
  prompt: Type.Optional(Type.String({ description: 'Complete prompt for single mode.' })),
  subagent_type: Type.Optional(Type.String({
    description: 'Role name for single mode, such as explore, general-purpose, or plan.',
  })),
  model: Type.Optional(Type.String({ description: MODEL_OVERRIDE_DESCRIPTION })),
  parallel: Type.Optional(Type.Array(TaskSchema, {
    minItems: 1,
    maxItems: MAX_SUBAGENT_TASKS,
    description: 'Tasks to execute concurrently.',
  })),
  chain: Type.Optional(Type.Array(TaskSchema, {
    minItems: 1,
    maxItems: MAX_SUBAGENT_TASKS,
    description: 'Tasks to execute sequentially; {previous} inserts the prior output.',
  })),
});

export interface SubagentModelOption {
  provider: string;
  id: string;
}

interface SubagentTask {
  description: string;
  prompt: string;
  subagent_type: string;
  model?: string;
}

type SubagentParams = SubagentTask | { parallel: SubagentTask[] } | { chain: SubagentTask[] };
type SubagentMode = 'single' | 'parallel' | 'chain';

interface AgentRole {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
}

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SubagentResult {
  description: string;
  prompt: string;
  subagentType: string;
  exitCode: number;
  output: string;
  stderr: string;
  usage: SubagentUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface SubagentDetails {
  mode: SubagentMode;
  results: SubagentResult[];
  usage: SubagentUsage;
}

export type SubagentSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SubagentToolDeps {
  spawn: SubagentSpawn;
  command: string;
  agentDir: string;
  ensureRoles(): void;
  toolShimsPath: string;
  mcpBridgePath: string;
  killGraceMs: number;
  /** Override the child→server channel. Tests substitute a recorder; production leaves it unset
   *  and the real `ctx.ui.notify` channel is built per call. */
  channel?: (parentToolCallId: string, ctx: ExtensionContext) => SubagentChannel | undefined;
}

interface ChildAccumulator {
  output: string;
  usage: SubagentUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

interface Invocation {
  mode: SubagentMode;
  tasks: SubagentTask[];
}

interface PromptFile {
  filePath: string | null;
  cleanup(): void;
}

/** Called for every event a child emits, with the accumulator so the notice can name the model as
 *  soon as the child has reported one. Best-effort by contract — see processEvent. */
type ChildEventForwarder = (event: Record<string, unknown>, acc: ChildAccumulator) => void;

/** Carries one running child's events out to the server. Built per `agent` call so it can stamp
 *  the parent's tool-call id, and per child so it can stamp which of up to eight it is. */
export interface SubagentChannel {
  forChild(index: number, task: { description: string; prompt: string; subagent_type: string }): ChildEventForwarder;
}

/** The real channel: PI's `ctx.ui.notify`, the one fire-and-forget message an extension gets on
 *  the RPC stream. Absent (or throwing) simply costs attribution — the subagent still runs and its
 *  final output still returns through the tool result, exactly as before. */
export function subagentChannel(
  parentToolCallId: string,
  ctx: { ui?: { notify?: (message: string) => void } } | undefined,
  forwardRuntimePrompt = false,
): SubagentChannel | undefined {
  const notify = ctx?.ui?.notify;
  if (typeof notify !== 'function' || !parentToolCallId) return undefined;
  const send = (message: string): void => {
    try { notify.call(ctx!.ui, message); } catch { /* best-effort */ }
  };
  return {
    forChild(index, task) {
      const ref = `${parentToolCallId}#${index}`;
      let promptPending = forwardRuntimePrompt && index > 0;
      return (event, acc) => {
        const notices = noticesFor(ref, task, acc, event);
        for (let i = 0; i < notices.length; i++) {
          const withPrompt = promptPending && i === 0 ? { ...notices[i], prompt: task.prompt } : notices[i];
          send(encodeSubagentNotice(withPrompt));
        }
        if (notices.length) promptPending = false;
      };
    },
  };
}

/** Translate one child stdout event into the notices the transcript can render. Returns [] for
 *  everything else — deltas, lifecycle, usage — so the channel stays quiet between real actions. */
function noticesFor(
  ref: string,
  task: { description: string; subagent_type: string },
  acc: ChildAccumulator,
  event: Record<string, unknown>,
): SubagentNotice[] {
  const base = {
    ref, type: task.subagent_type, description: task.description,
    model: acc.model ?? null,
  };
  const type = event.type;
  if (type === 'tool_execution_start') {
    const id = event.toolCallId;
    const name = event.toolName;
    if (typeof id !== 'string' || typeof name !== 'string') return [];
    return [{ ...base, kind: 'tool_use', toolUseId: `${ref}:${id}`, name, input: event.args ?? {} }];
  }
  if (type === 'tool_execution_end') {
    const id = event.toolCallId;
    if (typeof id !== 'string') return [];
    return [{
      ...base, kind: 'tool_result', toolUseId: `${ref}:${id}`,
      ok: event.isError !== true, content: toolResultText(event.result),
    }];
  }
  const message = messageEndMessage(event);
  if (!message || message.role !== 'assistant') return [];
  // `model` is read off THIS message, not the accumulator, because the accumulator has not yet
  // recorded it when the forwarder runs — the notice would otherwise lag one message behind.
  const model = typeof message.model === 'string' ? message.model : base.model;
  const text = textFromMessage(message);
  return text ? [{ ...base, model, kind: 'assistant_text', text }] : [];
}

function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const content = (result as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text')
    .map((b) => String((b as Record<string, unknown>).text ?? ''))
    .join('');
}

interface ChildCollectionState {
  accumulator: ChildAccumulator;
  buffer: string;
  stderr: string;
  closed: boolean;
  aborted: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
}

function emptyUsage(): SubagentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function addTurnUsage(target: SubagentUsage, source: SubagentUsage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  target.contextTokens = source.contextTokens || target.contextTokens;
  target.turns += source.turns;
}

function addChildUsage(target: SubagentUsage, source: SubagentUsage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  target.contextTokens += source.contextTokens;
  target.turns += source.turns;
}

function aggregateUsage(results: SubagentResult[]): SubagentUsage {
  const total = emptyUsage();
  for (const result of results) addChildUsage(total, result.usage);
  return total;
}

function parseTools(value: unknown): string[] | undefined {
  const tools = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string' ? value.split(',') : [];
  const normalized = tools.map((tool) => tool.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function parseRole(content: string): AgentRole | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) return null;
  const frontmatter = yamlParse(match[1]) as Record<string, unknown> | null;
  if (!frontmatter || typeof frontmatter.name !== 'string') return null;
  if (typeof frontmatter.description !== 'string') return null;
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: parseTools(frontmatter.tools),
    model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined,
    systemPrompt: match[2].trim(),
  };
}

function loadRoles(agentDir: string): AgentRole[] {
  const rolesDir = path.join(agentDir, 'agents');
  const roles: AgentRole[] = [];
  for (const entry of readdirSync(rolesDir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const role = parseRole(readFileSync(path.join(rolesDir, entry.name), 'utf8'));
    if (role) roles.push(role);
  }
  return roles;
}

function findRole(roles: AgentRole[], name: string): AgentRole {
  const role = roles.find((candidate) => candidate.name === name);
  if (role) return role;
  const available = roles.map((candidate) => candidate.name).sort().join(', ') || 'none';
  throw new Error(`Unknown subagent_type "${name}". Available roles: ${available}.`);
}

function resolveInvocation(params: SubagentParams): Invocation {
  const record = params as Record<string, unknown>;
  const hasSingle = ['description', 'prompt', 'subagent_type'].some((key) => key in record);
  const hasParallel = Array.isArray(record.parallel);
  const hasChain = Array.isArray(record.chain);
  if (Number(hasSingle) + Number(hasParallel) + Number(hasChain) !== 1) {
    throw new Error('Provide exactly one Agent mode: single fields, parallel, or chain.');
  }
  if (hasParallel) return checkedInvocation('parallel', record.parallel as SubagentTask[]);
  if (hasChain) return checkedInvocation('chain', record.chain as SubagentTask[]);
  validateTask(record as unknown as SubagentTask);
  return { mode: 'single', tasks: [record as unknown as SubagentTask] };
}

function checkedInvocation(mode: SubagentMode, tasks: SubagentTask[]): Invocation {
  if (tasks.length === 0) throw new Error(`${mode} requires at least one task.`);
  if (tasks.length > MAX_SUBAGENT_TASKS) {
    throw new Error(`Agent ${mode} task maximum is ${MAX_SUBAGENT_TASKS}.`);
  }
  for (const task of tasks) validateTask(task);
  return { mode, tasks };
}

function validateTask(task: SubagentTask): void {
  for (const key of ['description', 'prompt', 'subagent_type'] as const) {
    if (typeof task[key] !== 'string' || task[key].trim() === '') {
      throw new Error(`Agent task requires a non-empty ${key}.`);
    }
  }
}

function createPromptFile(role: AgentRole): PromptFile {
  if (!role.systemPrompt) return { filePath: null, cleanup: () => undefined };
  const directory = mkdtempSync(path.join(tmpdir(), 'cortex-pi-subagent-'));
  const safeName = role.name.replace(/[^\w.-]+/g, '_');
  const filePath = path.join(directory, `${safeName}.md`);
  writeFileSync(filePath, role.systemPrompt, { encoding: 'utf8', mode: 0o600 });
  return {
    filePath,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function selectedModel(task: SubagentTask, role: AgentRole, ctx: ExtensionContext) {
  const explicit = task.model?.trim();
  if (explicit) return { model: explicit };
  const roleModel = role.model?.trim();
  if (roleModel) return { model: roleModel };
  if (ctx.model) return { model: ctx.model.id, provider: ctx.model.provider };
  return {};
}

function buildChildArgs(
  task: SubagentTask,
  role: AgentRole,
  ctx: ExtensionContext,
  promptFile: string | null,
  deps: SubagentToolDeps,
): string[] {
  const args = ['--mode', 'json', '-p', '--no-session', '--no-extensions'];
  const selection = selectedModel(task, role, ctx);
  if (selection.provider) args.push('--provider', selection.provider);
  if (selection.model) args.push('--model', selection.model);
  if (role.tools?.length) args.push('--tools', role.tools.join(','));
  if (promptFile) args.push('--append-system-prompt', promptFile);
  args.push('--extension', deps.toolShimsPath, '--extension', deps.mcpBridgePath);
  args.push(`Task: ${task.prompt}`);
  return args;
}

function buildChildEnv(agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    CORTEX_PI_SUBAGENT: '1',
  };
  delete env.CORTEX_THREAD_ID;
  delete env.CORTEX_TASK_ID;
  delete env[PI_INTERACTION_BRIDGE_ENV];
  return env;
}

function textFromMessage(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: string; text: string } => (
      !!part && typeof part === 'object'
      && (part as any).type === 'text'
      && typeof (part as any).text === 'string'
    ))
    .map((part) => part.text)
    .join('\n');
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

function parseEventLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line) as unknown;
    return event && typeof event === 'object' && !Array.isArray(event)
      ? event as Record<string, unknown>
      : null;
  } catch { return null; }
}

function messageEndMessage(event: Record<string, unknown>): Record<string, unknown> | null {
  if (event.type !== 'message_end' || !event.message || typeof event.message !== 'object') return null;
  return event.message as Record<string, unknown>;
}

function stringOrPrevious(value: unknown, previous: string | undefined): string | undefined {
  return typeof value === 'string' ? value : previous;
}

function recordTerminalState(
  accumulator: ChildAccumulator,
  message: Record<string, unknown>,
): void {
  const stopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined;
  if (!stopReason) {
    accumulator.errorMessage = stringOrPrevious(message.errorMessage, accumulator.errorMessage);
    return;
  }
  accumulator.stopReason = stopReason;
  accumulator.errorMessage = typeof message.errorMessage === 'string'
    ? message.errorMessage
    : undefined;
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

function processEvent(
  accumulator: ChildAccumulator,
  line: string,
  forward?: ChildEventForwarder,
): void {
  const event = parseEventLine(line);
  if (!event) return;
  // Forward FIRST and unconditionally: the accumulator only ever cared about `message_end`, but
  // the transcript wants the child's tool calls too, and those are exactly the events that used
  // to be dropped here. The model is read off the accumulator so a notice can name it as soon as
  // the child's first message reports one.
  if (forward) {
    try { forward(event, accumulator); }
    catch { /* the channel is best-effort: a broken notice must not fail the subagent */ }
  }
  const message = messageEndMessage(event);
  if (!message) return;
  recordUsage(accumulator, message);
  recordAssistantMessage(accumulator, message);
}

function isFailed(result: SubagentResult): boolean {
  return result.exitCode !== 0
    || result.stopReason === 'error'
    || result.stopReason === 'aborted';
}

function resultText(result: SubagentResult): string {
  if (isFailed(result)) {
    return result.errorMessage || result.output || result.stderr || '(no output)';
  }
  return result.output || result.stderr || '(no output)';
}

function createChildResult(
  task: SubagentTask,
  accumulator: ChildAccumulator,
  exitCode: number,
  stderr: string,
): SubagentResult {
  return {
    description: task.description,
    prompt: task.prompt,
    subagentType: task.subagent_type,
    exitCode,
    output: accumulator.output,
    stderr,
    usage: accumulator.usage,
    model: accumulator.model,
    stopReason: accumulator.stopReason,
    errorMessage: accumulator.errorMessage,
  };
}

function runChild(
  task: SubagentTask,
  role: AgentRole,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  deps: SubagentToolDeps,
  forward?: ChildEventForwarder,
): Promise<SubagentResult> {
  const promptFile = createPromptFile(role);
  const args = buildChildArgs(task, role, ctx, promptFile.filePath, deps);
  const child = deps.spawn(deps.command, args, {
    cwd: ctx.cwd,
    env: buildChildEnv(deps.agentDir),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return collectChild(child, task, signal, deps.killGraceMs, forward).finally(promptFile.cleanup);
}

function consumeStdout(
  state: ChildCollectionState, chunk: unknown, forward?: ChildEventForwarder,
): void {
  state.buffer += String(chunk);
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() ?? '';
  for (const line of lines) processEvent(state.accumulator, line, forward);
}

function abortChild(child: ChildProcess, state: ChildCollectionState, graceMs: number): void {
  state.aborted = true;
  child.kill('SIGTERM');
  state.killTimer = setTimeout(() => {
    if (!state.closed) child.kill('SIGKILL');
  }, graceMs);
}

function markChildClosed(state: ChildCollectionState): void {
  state.closed = true;
  if (state.killTimer) clearTimeout(state.killTimer);
}

function finishChild(
  state: ChildCollectionState,
  task: SubagentTask,
  code: number | null,
  signal: NodeJS.Signals | null,
): SubagentResult {
  markChildClosed(state);
  if (state.buffer.trim()) processEvent(state.accumulator, state.buffer);
  if (signal && !state.aborted) {
    state.accumulator.stopReason = 'error';
    state.accumulator.errorMessage ??= `Subagent terminated by signal ${signal}.`;
  }
  return createChildResult(task, state.accumulator, code ?? 1, state.stderr);
}

function collectChild(
  child: ChildProcess,
  task: SubagentTask,
  signal: AbortSignal | undefined,
  killGraceMs: number,
  forward?: ChildEventForwarder,
): Promise<SubagentResult> {
  return new Promise((resolve, reject) => {
    const state: ChildCollectionState = {
      accumulator: { output: '', usage: emptyUsage() },
      buffer: '', stderr: '', closed: false, aborted: false, killTimer: null,
    };
    const onAbort = () => abortChild(child, state, killGraceMs);
    child.stdout?.on('data', (chunk) => consumeStdout(state, chunk, forward));
    child.stderr?.on('data', (chunk) => { state.stderr += chunk.toString(); });
    child.once('error', (error) => {
      markChildClosed(state);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code, closeSignal) => {
      signal?.removeEventListener('abort', onAbort);
      const result = finishChild(state, task, code, closeSignal);
      if (state.aborted) reject(new Error('Subagent was aborted.'));
      else resolve(result);
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function failedChildResult(task: SubagentTask, error: unknown): SubagentResult {
  const message = error instanceof Error ? error.message : String(error);
  const accumulator: ChildAccumulator = {
    output: '',
    usage: emptyUsage(),
    stopReason: 'error',
    errorMessage: message,
  };
  return createChildResult(task, accumulator, 1, '');
}

async function runTask(
  task: SubagentTask,
  roles: AgentRole[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  deps: SubagentToolDeps,
  forward?: ChildEventForwarder,
): Promise<SubagentResult> {
  const role = findRole(roles, task.subagent_type);
  try {
    const result = await runChild(task, role, ctx, signal, deps, forward);
    if (!result.model) result.model = selectedModel(task, role, ctx).model;
    return result;
  } catch (error) {
    if (signal?.aborted) throw error;
    return failedChildResult(task, error);
  }
}

function parallelContent(results: SubagentResult[]): string {
  const succeeded = results.filter((result) => !isFailed(result)).length;
  const sections = results.map((result) => {
    const status = isFailed(result) ? 'failed' : 'completed';
    return `### [${result.description}] ${status}\n\n${resultText(result)}`;
  });
  return `Parallel: ${succeeded}/${results.length} succeeded\n\n${sections.join('\n\n---\n\n')}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  execute: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await execute(items[index], index);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function executeParallel(
  tasks: SubagentTask[],
  roles: AgentRole[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  deps: SubagentToolDeps,
  channel?: SubagentChannel,
): Promise<SubagentResult[]> {
  // The index is the task's position, not completion order: parallel children finish out of
  // order, and a block keyed by arrival would rename itself as the race resolves.
  return mapWithConcurrency(tasks, MAX_SUBAGENT_CONCURRENCY, (task, index) => (
    runTask(task, roles, ctx, signal, deps, channel?.forChild(index, task))
  ));
}

async function executeChain(
  tasks: SubagentTask[],
  roles: AgentRole[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  deps: SubagentToolDeps,
  channel?: SubagentChannel,
): Promise<SubagentResult[]> {
  const results: SubagentResult[] = [];
  let previous = '';
  let index = 0;
  for (const original of tasks) {
    const task = { ...original, prompt: original.prompt.replace(/\{previous\}/g, previous) };
    const result = await runTask(task, roles, ctx, signal, deps, channel?.forChild(index++, task));
    results.push(result);
    if (isFailed(result)) break;
    previous = result.output;
  }
  return results;
}

function buildToolResult(mode: SubagentMode, results: SubagentResult[]) {
  const details: SubagentDetails = { mode, results, usage: aggregateUsage(results) };
  if (mode === 'parallel') {
    return { content: [{ type: 'text', text: parallelContent(results) }], details };
  }
  const last = results.at(-1)!;
  const prefix = isFailed(last) ? `Agent failed: ` : '';
  return { content: [{ type: 'text', text: prefix + resultText(last) }], details };
}

function resolveDeps(overrides?: Partial<SubagentToolDeps>): SubagentToolDeps {
  const agentDir = overrides?.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? PI_AGENT_DIR;
  return {
    spawn: overrides?.spawn ?? defaultSpawn,
    command: overrides?.command ?? 'pi',
    agentDir,
    ensureRoles: overrides?.ensureRoles ?? (() => ensurePIAgentRoles({ agentDir })),
    toolShimsPath: overrides?.toolShimsPath ?? TOOL_SHIMS_PATH,
    mcpBridgePath: overrides?.mcpBridgePath ?? MCP_BRIDGE_PATH,
    killGraceMs: overrides?.killGraceMs ?? SUBAGENT_KILL_GRACE_MS,
  };
}

async function executeInvocation(
  invocation: Invocation,
  roles: AgentRole[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  deps: SubagentToolDeps,
  channel?: SubagentChannel,
) {
  for (const task of invocation.tasks) findRole(roles, task.subagent_type);
  if (invocation.mode === 'parallel') {
    const results = await executeParallel(invocation.tasks, roles, ctx, signal, deps, channel);
    return buildToolResult(invocation.mode, results);
  }
  if (invocation.mode === 'chain') {
    const results = await executeChain(invocation.tasks, roles, ctx, signal, deps, channel);
    return buildToolResult(invocation.mode, results);
  }
  const task = invocation.tasks[0];
  const result = await runTask(task, roles, ctx, signal, deps, channel?.forChild(0, task));
  return buildToolResult(invocation.mode, [result]);
}

const SUBAGENT_DESCRIPTION =
  'Delegate a task to an isolated PI subagent. Supports single, parallel, and chain modes. ' +
  'Model overrides use provider/model[:thinking].';

function modelOptionName(option: SubagentModelOption): string | null {
  const provider = option.provider.trim();
  const id = option.id.trim();
  return provider && id ? `${provider}/${id}` : null;
}

function uniqueModelNames(options: SubagentModelOption[]): string[] {
  const names = new Set<string>();
  for (const option of options) {
    const name = modelOptionName(option);
    if (name) names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function boundedModelNames(names: string[]): string[] {
  const selected: string[] = [];
  let characters = 0;
  for (const name of names) {
    const added = name.length + (selected.length > 0 ? 2 : 0);
    if (selected.length >= MAX_SUBAGENT_MODEL_CHOICES) break;
    if (characters + added > MAX_SUBAGENT_MODEL_LIST_CHARS) continue;
    selected.push(name);
    characters += added;
  }
  return selected;
}

function toolDescription(options: SubagentModelOption[]): string {
  const names = uniqueModelNames(options);
  if (names.length === 0) return SUBAGENT_DESCRIPTION;
  const selected = boundedModelNames(names);
  const omitted = names.length - selected.length;
  const suffix = omitted > 0 ? ` (+${omitted} more)` : '';
  return `${SUBAGENT_DESCRIPTION} Available model overrides: ${selected.join(', ')}${suffix}.`;
}

export function createSubagentTool(
  overrides?: Partial<SubagentToolDeps>,
  modelOptions: SubagentModelOption[] = [],
): ToolDefinition<typeof SubagentParameters, SubagentDetails> {
  const deps = resolveDeps(overrides);
  return {
    name: 'agent',
    label: 'Agent',
    description: toolDescription(modelOptions),
    parameters: SubagentParameters,
    async execute(toolCallId, params, signal, _update, ctx) {
      deps.ensureRoles();
      const invocation = resolveInvocation(params as SubagentParams);
      return executeInvocation(
        invocation, loadRoles(deps.agentDir), ctx, signal, deps,
        deps.channel?.(toolCallId, ctx) ?? subagentChannel(toolCallId, ctx, invocation.mode === 'chain'),
      );
    },
  };
}
