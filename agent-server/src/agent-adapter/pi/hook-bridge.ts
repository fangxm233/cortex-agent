// input:  PI ExtensionAPI, session env, declarative hook registry
// output: Ordered PI hook handlers with native results and mutations
// pos:    Compiles registry entries into PI event handlers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { DEFAULTS_DIR, HOOKS_DIR } from '../../core/utils.js';
import { createLogger } from '../../core/log.js';
import {
  filterHookEntries,
  loadHookRegistry,
  type AgentHookEvent,
  type HookEntry,
} from '../../store/hook-registry.js';

const log = createLogger('hook-bridge');

/** The slice of PI's extension context the bridge reads. Structural so tests can pass a stub. */
export interface HookContext {
  cwd: string;
  sessionManager?: { getSessionFile(): string | undefined };
}

/** The slice of PI's ExtensionAPI the bridge registers through. */
export interface HookHost {
  on(event: string, handler: (event: any, ctx: HookContext) => unknown): void;
}

/** Event fired by PI before a built-in or registered tool is executed. Input is mutable. */
export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

/** Event fired by PI after a tool has finished executing. */
export interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: unknown;
  details?: unknown;
  isError: boolean;
}

export interface BeforeAgentStartEvent {
  prompt?: string;
  systemPrompt?: string;
}

/** Return type for tool_call handlers: block the tool call or let it proceed. */
export type ToolCallReturn = { block: true; reason?: string } | undefined;

// PI tool name → Claude-native name used by agent:* registry matchers.
const TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  ask_user_question: 'AskUserQuestion',
  enter_plan_mode: 'EnterPlanMode',
  exit_plan_mode: 'ExitPlanMode',
  todo_write: 'TodoWrite',
  skill: 'Skill',
  agent: 'Agent',
};

const AGENT_EVENT_MAP: Record<AgentHookEvent, string> = {
  'agent:pre-tool': 'tool_call',
  'agent:post-tool': 'tool_result',
  'agent:session-start': 'before_agent_start',
  'agent:session-end': 'session_shutdown',
  'agent:pre-compact': 'session_before_compact',
  'agent:user-prompt': 'input',
  'agent:turn-end': 'turn_end',
};

const CLAUDE_EVENT_MAP: Record<AgentHookEvent, string> = {
  'agent:pre-tool': 'PreToolUse',
  'agent:post-tool': 'PostToolUse',
  'agent:session-start': 'SessionStart',
  'agent:session-end': 'SessionEnd',
  'agent:pre-compact': 'PreCompact',
  'agent:user-prompt': 'UserPromptSubmit',
  'agent:turn-end': 'Stop',
};

/** Map a PI lowercase/snake_case tool name to the Claude-native PascalCase name. */
export function toClaude(piName: string): string {
  return TOOL_NAME_MAP[piName] ?? (piName.charAt(0).toUpperCase() + piName.slice(1));
}

/**
 * Normalize PI tool input for hook scripts.
 * PI's built-in read/write/edit use `path`; Claude hook scripts expect `file_path`.
 * Copies `input.path → input.file_path` for those three tools.
 * Grep passes through unchanged (memory-ref-tracker reads `tool_input.path` for Grep).
 */
export function normalizePiInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (
    (toolName === 'read' || toolName === 'write' || toolName === 'edit') &&
    typeof input.path === 'string'
  ) {
    return { ...input, file_path: input.path };
  }
  return { ...input };
}

/**
 * Derive the Cortex session ID from the PI extension context.
 * Falls back to the session env's CORTEX_SESSION_ID, then 'unknown'.
 * Guards for getSessionFile() returning undefined (in-memory or pre-session state).
 */
export function getSessionId(ctx: HookContext, env: NodeJS.ProcessEnv = process.env): string {
  const f = ctx.sessionManager?.getSessionFile();
  if (f) return path.basename(f, '.jsonl');
  return env['CORTEX_SESSION_ID'] ?? 'unknown';
}

interface TextContent {
  type: 'text';
  text: string;
}

interface ClaudeHookPayload {
  hook_event_name: string;
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  cwd?: string;
  tool_response?: unknown;
  tool_output?: string;
  is_error?: boolean;
}

interface HookSpecificOutput {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
}

interface HookResult extends Record<string, unknown> {
  hookSpecificOutput?: HookSpecificOutput;
}

function extractToolOutput(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (item): item is TextContent =>
        typeof item === 'object' && item !== null &&
        (item as Record<string, unknown>).type === 'text',
    )
    .map((item) => item.text)
    .join('');
}

/** A hook script runs in the session's environment (not the daemon's), pinned to its session. */
function hookEnvironment(env: NodeJS.ProcessEnv, sessionId: string): NodeJS.ProcessEnv {
  const cacheSessionId = env.CORTEX_CACHE_SESSION_ID ?? env.CORTEX_SESSION_ID;
  return {
    ...env,
    ...(cacheSessionId ? { CORTEX_CACHE_SESSION_ID: cacheSessionId } : {}),
    CORTEX_SESSION_ID: sessionId,
  };
}

function parseHookOutput(stdout: string | null): unknown {
  if (!stdout?.trim()) return undefined;
  try {
    return JSON.parse(stdout.trim()) as unknown;
  } catch {
    return undefined;
  }
}

function failedProcess(status: number | null, stderr: string | null): Error | null {
  if (status === 0) return null;
  const detail = stderr?.trim() ? `: ${stderr.trim()}` : '';
  return new Error(`exited with code ${status}${detail}`);
}

/**
 * Run one hook process to completion without blocking the event loop. The bridge lives in the
 * daemon now, so a synchronous wait here would stall every other session for the hook's whole
 * runtime; PI awaits handler promises, so the tool call still waits for its own hook.
 */
function spawnHook(
  command: string,
  args: string[],
  payload: ClaudeHookPayload | Record<string, unknown>,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: hookEnvironment(env, String(payload.session_id ?? 'unknown')),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`timed out after ${timeoutMs}ms`));
        return;
      }
      const failure = failedProcess(status, stderr);
      if (failure) reject(failure);
      else resolve(parseHookOutput(stdout));
    });
    // A hook may exit before reading its stdin; that must not surface as an unhandled error.
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}

function asHookResult(value: unknown): HookResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as HookResult;
}

export async function runHookScript(
  scriptPath: string,
  payload: ClaudeHookPayload,
  timeoutMs = 30_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookResult> {
  return asHookResult(await spawnHook(process.execPath, [scriptPath], payload, timeoutMs, env));
}

async function runHookEntry(
  entry: HookEntry,
  payload: ClaudeHookPayload | Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const timeoutMs = (entry.run.timeout ?? 30) * 1_000;
  try {
    if (entry.run.script) {
      return await spawnHook(process.execPath, [path.join(HOOKS_DIR, entry.run.script)], payload, timeoutMs, env);
    }
    return await spawnHook('sh', ['-c', entry.run.command!], payload, timeoutMs, env);
  } catch (error) {
    log.error(`${entry.id} error:`, error);
    return undefined;
  }
}

function matchesTool(entry: HookEntry, toolName: string): boolean {
  if (typeof entry.matcher !== 'string') return true;
  const canonicalName = toolName.startsWith('mcp__') ? toolName : toClaude(toolName);
  const candidate = entry.event.startsWith('agent:') ? canonicalName : toolName;
  return new RegExp(entry.matcher).test(candidate);
}

function nativeEventFor(entry: HookEntry): string | null {
  if (entry.event.startsWith('pi:')) return entry.event.slice(3);
  if (entry.event.startsWith('agent:')) return AGENT_EVENT_MAP[entry.event as AgentHookEvent];
  return null;
}

function entriesForEvent(eventName: string): HookEntry[] {
  const deployed = filterHookEntries(loadHookRegistry(), { backend: 'pi' });
  const entries = deployed.length > 0 ? deployed : filterHookEntries(
    loadHookRegistry(path.join(DEFAULTS_DIR, 'config', 'hooks')),
    { backend: 'pi' },
  );
  return entries.filter((entry) => nativeEventFor(entry) === eventName);
}

function toolPayload(
  hookEventName: string,
  event: ToolCallEvent | ToolResultEvent,
  ctx: HookContext,
  env: NodeJS.ProcessEnv,
): ClaudeHookPayload {
  const payload: ClaudeHookPayload = {
    hook_event_name: hookEventName,
    session_id: getSessionId(ctx, env),
    tool_name: toClaude(event.toolName),
    tool_input: normalizePiInput(event.toolName, event.input),
    tool_use_id: event.toolCallId,
    cwd: ctx.cwd,
  };
  if ('content' in event) addToolResultFields(payload, event);
  return payload;
}

function addToolResultFields(payload: ClaudeHookPayload, event: ToolResultEvent): void {
  payload.tool_output = extractToolOutput(event.content);
  payload.tool_response = event.details ?? null;
  payload.is_error = event.isError;
}

function lifecyclePayload(
  entry: HookEntry,
  event: unknown,
  ctx: HookContext,
  env: NodeJS.ProcessEnv,
): ClaudeHookPayload | Record<string, unknown> {
  if (entry.event.startsWith('pi:')) return nativePayload(entry.event.slice(3), event, ctx, env);
  const source = typeof event === 'object' && event !== null
    ? event as Record<string, unknown>
    : { event };
  return {
    ...source,
    hook_event_name: CLAUDE_EVENT_MAP[entry.event as AgentHookEvent],
    session_id: getSessionId(ctx, env),
    tool_name: '',
    tool_input: {},
    tool_use_id: '',
    cwd: ctx.cwd,
  };
}

function nativePayload(
  eventName: string,
  event: unknown,
  ctx: HookContext,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const source = typeof event === 'object' && event !== null
    ? event as Record<string, unknown>
    : { event };
  return {
    ...source,
    hook_event_name: eventName,
    session_id: getSessionId(ctx, env),
    cwd: ctx.cwd,
  };
}

function payloadForToolEntry(
  entry: HookEntry,
  nativeEvent: string,
  event: ToolCallEvent | ToolResultEvent,
  ctx: HookContext,
  env: NodeJS.ProcessEnv,
): ClaudeHookPayload | Record<string, unknown> {
  if (entry.event.startsWith('pi:')) return nativePayload(nativeEvent, event, ctx, env);
  return toolPayload(CLAUDE_EVENT_MAP[entry.event as AgentHookEvent], event, ctx, env);
}

function applyUpdatedInput(event: ToolCallEvent, output: HookSpecificOutput | undefined): void {
  if (!output?.updatedInput || typeof output.updatedInput !== 'object') return;
  for (const key of Object.keys(event.input)) delete event.input[key];
  Object.assign(event.input, output.updatedInput);
}

function blockResult(result: HookResult): ToolCallReturn {
  const output = result.hookSpecificOutput;
  if (output?.permissionDecision !== 'deny') return undefined;
  return {
    block: true,
    reason: output.permissionDecisionReason ?? 'Blocked by hook registry',
  };
}

export async function handlePreToolUse(
  event: ToolCallEvent,
  ctx: HookContext,
  entries = entriesForEvent('tool_call'),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ToolCallReturn> {
  for (const entry of entries) {
    if (!matchesTool(entry, event.toolName)) continue;
    const payload = payloadForToolEntry(entry, 'tool_call', event, ctx, env);
    const result = asHookResult(await runHookEntry(entry, payload, env));
    applyUpdatedInput(event, result.hookSpecificOutput);
    const blocked = blockResult(result);
    if (blocked) return blocked;
    if (entry.event.startsWith('pi:') && result.block === true) {
      return { block: true, reason: typeof result.reason === 'string' ? result.reason : undefined };
    }
  }
  return undefined;
}

function appendContext(event: ToolResultEvent, context: string | undefined): boolean {
  if (!context) return false;
  const content = Array.isArray(event.content) ? event.content : [];
  content.push({ type: 'text', text: context });
  event.content = content;
  return true;
}

export async function handlePostToolUse(
  event: ToolResultEvent,
  ctx: HookContext,
  entries = entriesForEvent('tool_result'),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ content?: unknown } | undefined> {
  let contentModified = false;
  for (const entry of entries) {
    if (!matchesTool(entry, event.toolName)) continue;
    const payload = payloadForToolEntry(entry, 'tool_result', event, ctx, env);
    const result = asHookResult(await runHookEntry(entry, payload, env));
    contentModified = appendContext(event, result.hookSpecificOutput?.additionalContext) || contentModified;
  }
  return contentModified ? { content: event.content } : undefined;
}

async function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: HookContext,
  entries: HookEntry[],
  env: NodeJS.ProcessEnv,
): Promise<{ systemPrompt: string } | undefined> {
  let systemPrompt = event.systemPrompt ?? '';
  let modified = false;
  for (const entry of entries) {
    event.systemPrompt = systemPrompt;
    const result = asHookResult(await runHookEntry(entry, lifecyclePayload(entry, event, ctx, env), env));
    const context = result.hookSpecificOutput?.additionalContext;
    if (!context) continue;
    systemPrompt += `\n\n${context}`;
    modified = true;
  }
  if (!modified) return undefined;
  event.systemPrompt = systemPrompt;
  return { systemPrompt };
}

async function handleLifecycleEvent(
  event: unknown,
  ctx: HookContext,
  entries: HookEntry[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const entry of entries) await runHookEntry(entry, lifecyclePayload(entry, event, ctx, env), env);
}

function dispatchAgentEntry(
  eventName: string,
  entry: HookEntry,
  event: unknown,
  ctx: HookContext,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const entries = [entry];
  if (eventName === 'tool_call') return handlePreToolUse(event as ToolCallEvent, ctx, entries, env);
  if (eventName === 'tool_result') return handlePostToolUse(event as ToolResultEvent, ctx, entries, env);
  if (eventName === 'before_agent_start') {
    return handleBeforeAgentStart(event as BeforeAgentStartEvent, ctx, entries, env);
  }
  return handleLifecycleEvent(event, ctx, entries, env);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function replaceRecord(
  target: Record<string, unknown>,
  replacement: Record<string, unknown>,
): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

function applyNativeMutation(eventName: string, event: unknown, result: unknown): unknown {
  if (!isRecord(event) || !isRecord(result)) return result;
  if (eventName === 'before_provider_headers') {
    if (isRecord(event.headers) && isRecord(result.headers)) replaceRecord(event.headers, result.headers);
    return undefined;
  }
  if (eventName !== 'tool_call' || !isRecord(event.input) || !isRecord(result.input)) return result;
  replaceRecord(event.input, result.input);
  const handlerResult = { ...result };
  delete handlerResult.input;
  return Object.keys(handlerResult).length > 0 ? handlerResult : undefined;
}

async function dispatchNativeEntry(
  eventName: string,
  entry: HookEntry,
  event: unknown,
  ctx: HookContext,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const isToolEvent = eventName === 'tool_call' || eventName === 'tool_result';
  const toolName = (event as { toolName?: unknown })?.toolName;
  if (isToolEvent && (typeof toolName !== 'string' || !matchesTool(entry, toolName))) return undefined;
  const result = await runHookEntry(entry, nativePayload(eventName, event, ctx, env), env);
  return applyNativeMutation(eventName, event, result);
}

function dispatchEntry(
  eventName: string,
  entry: HookEntry,
  event: unknown,
  ctx: HookContext,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  if (entry.event.startsWith('pi:')) return dispatchNativeEntry(eventName, entry, event, ctx, env);
  return dispatchAgentEntry(eventName, entry, event, ctx, env);
}

/** Register every deployed PI hook entry on the session, scripts running in the session's env. */
export function installHookBridge(pi: HookHost, env: NodeJS.ProcessEnv): void {
  const entries = filterHookEntries(loadHookRegistry(), { backend: 'pi' });
  for (const entry of entries) {
    const eventName = nativeEventFor(entry);
    if (!eventName) continue;
    pi.on(eventName, (event: unknown, ctx: HookContext) => dispatchEntry(eventName, entry, event, ctx, env));
  }
}
