// input:  PI spawn options, task context, policy guard
// output: Isolated PI argv and subprocess environment
// pos:    Builds PI process arguments and environment
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { IdentityJsonValue } from '../../domain/agent-run/identity.js';
import type { AgentSpawnConfig, McpComposition } from '../types.js';
import {
  PI_LEASE_STATE_ENV, PI_MCP_COMPOSITION_ENV, PI_POLICY_GUARD_ENV, GATE2_LEASE_STATE,
} from './policy-guard.js';
import { PI_BENCHMARK_DEADLINE_ENV } from './mcp-duration.js';
import { PI_PLUGIN_MCP_CONFIG_ENV } from './mcp-config.js';

export interface PISpawnOptions {
  sessionDir: string;
  /** Session UUID for legacy callers that intentionally delegate lookup to PI. */
  sessionId?: string | null;
  /** Exact session JSONL path; preferred so PI opens one transcript without scanning. */
  sessionPath?: string | null;
  /** Model identifier (e.g. "deepseek-v4-flash[1m]"); context-window suffix is stripped. */
  model?: string | null;
  /** PI provider name (e.g. "anthropic", "deepseek", "openai-codex"). When set together with model,
   *  emits `--provider <name>`. When omitted, PI infers provider from model name prefix or its default.
   *  Sourced from the cortex profile's `mode` field at adapter-spawn time. */
  provider?: string | null;
  systemPrompt?: string | null;
  /** Single string or multi-value array; pi args.js:49-51 accepts repeated --append-system-prompt flags. */
  appendSystemPrompt?: string | string[] | null;
  pluginDirs?: string[] | null;
  pluginSkillDirs?: string[] | null;
  /** PI extension file paths; each emits a repeated --extension flag (pi args.js:95-98). */
  extensionPaths?: string[] | null;
  /** Thinking level from the profile's `thinking` field → `--thinking <level>`
   *  (off/minimal/low/medium/high/xhigh). Absent → no flag. */
  thinking?: string | null;
  /** Extra CLI options from profile (e.g. {"--thinking": "xhigh"}). */
  extraOption?: Record<string, string> | null;
}

/** Strip context-window suffix like "[1m]" from model strings (e.g. "deepseek-v4-flash[1m]" → "deepseek-v4-flash"). */
function stripModelSuffix(model: string): string {
  return model.replace(/\[.*?\]$/, '');
}

function appendModelArgs(args: string[], opts: PISpawnOptions): void {
  if (!opts.model) return;
  args.push('--model', stripModelSuffix(opts.model));
  // Provider is profile-selected and only meaningful alongside an explicit model.
  if (opts.provider) args.push('--provider', opts.provider);
}

function appendSessionArgs(args: string[], opts: PISpawnOptions): void {
  // Explicit legacy IDs retain precedence over exact transcript paths.
  if (opts.sessionId && opts.sessionId.length > 0) {
    args.push('--session', opts.sessionId);
    return;
  }
  if (opts.sessionPath && opts.sessionPath.length > 0) args.push('--session', opts.sessionPath);
}

function appendOptionalArg(args: string[], flag: string, value: string | null | undefined): void {
  if (value && value.length > 0) args.push(flag, value);
}

function appendArgs(args: string[], flag: string, values: readonly string[]): void {
  for (const value of values) args.push(flag, value);
}

function appendNonEmptyArgs(args: string[], flag: string, values: readonly string[]): void {
  for (const value of values) {
    if (value.length > 0) args.push(flag, value);
  }
}

function promptValues(value: PISpawnOptions['appendSystemPrompt']): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function appendExtraOptions(args: string[], options: PISpawnOptions['extraOption']): void {
  for (const [key, value] of Object.entries(options ?? {})) args.push(key, value);
}

export interface PIEnvOptions {
  sessionId?: string | null;
  channel?: string | null;
  callbackSource?: string | null;
  scheduleTaskId?: string | null;
  extraEnv?: Record<string, string> | null;
  context?: AgentSpawnConfig['cortexContext'];
  piAgentDir: string;
  allowedTools?: string | null;
  /** Compiled benchmark policy guard. Present puts the child in guarded mode (§13 GT6). */
  policyGuard?: IdentityJsonValue;
  /** Which key of that guard this spawn selects. Absent keeps the one-shot parent's default
   *  (design section 16 (16.1) LS7). */
  leaseState?: string;
  /** Resolved MCP composition; the bridge derives its server set from it (§5.6 P1). */
  mcpComposition?: McpComposition;
  /** Absolute trial deadline the MCP bridge bounds its calls against (§5.6 P2/P5). */
  deadlineEpochMs?: number;
  /** Private path to the typed plugin MCP config written by the adapter. */
  pluginMcpConfigPath?: string | null;
  /** Explicit marker for the restricted PI subagent surface. */
  subagentMarker?: string | null;
}

const RESET_CONTEXT_KEYS = [
  'SLACK_CHANNEL', 'FEISHU_CHANNEL',
  'CORTEX_SESSION_ID', 'CORTEX_THREAD_ID', 'CORTEX_PROFILE',
  'CORTEX_PROJECT', 'CORTEX_SESSION_NAME', 'CORTEX_EXECUTION_ID',
  'CORTEX_THREAD_DEPTH', 'CORTEX_TASK_ID', 'CORTEX_TASK_PROJECT',
  'CORTEX_TASK_GENERATION',
  'CORTEX_CALLBACK_SOURCE', 'CORTEX_SCHEDULE_TASK_ID',
  'CORTEX_PI_ALLOWED_TOOLS', 'CORTEX_PI_SUBAGENT', PI_PLUGIN_MCP_CONFIG_ENV,
  PI_POLICY_GUARD_ENV, PI_LEASE_STATE_ENV, PI_MCP_COMPOSITION_ENV, PI_BENCHMARK_DEADLINE_ENV,
] as const;

function setOptional(env: NodeJS.ProcessEnv, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== '') env[key] = String(value);
}

function applyContext(env: NodeJS.ProcessEnv, options: PIEnvOptions): void {
  const context = options.context;
  setOptional(env, 'CORTEX_SESSION_ID', context?.trackSessionId ?? options.sessionId);
  setOptional(env, 'CORTEX_CALLBACK_SOURCE', options.callbackSource);
  setOptional(env, 'CORTEX_SCHEDULE_TASK_ID', options.scheduleTaskId);
  setOptional(env, 'CORTEX_THREAD_ID', context?.threadId);
  setOptional(env, 'CORTEX_PROFILE', context?.profile);
  setOptional(env, 'CORTEX_PROJECT', context?.project);
  setOptional(env, 'CORTEX_SESSION_NAME', context?.sessionName);
  setOptional(env, 'CORTEX_EXECUTION_ID', context?.executionId);
  setOptional(env, 'CORTEX_THREAD_DEPTH', context?.threadDepth);
  setOptional(env, 'CORTEX_TASK_ID', context?.taskId);
  setOptional(env, 'CORTEX_TASK_PROJECT', context?.taskProject);
  setOptional(env, 'CORTEX_TASK_GENERATION', context?.taskGeneration);
}

export function buildPiEnv(
  options: PIEnvOptions,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inheritedEnv, ...(options.extraEnv ?? {}) };
  for (const key of RESET_CONTEXT_KEYS) delete env[key];
  env.PI_CODING_AGENT_DIR = options.piAgentDir;
  env.CORTEX_BACKEND = 'pi';
  if (options.channel) {
    env.SLACK_CHANNEL = options.channel;
    env.FEISHU_CHANNEL = options.channel;
  }
  setOptional(env, 'CORTEX_PI_ALLOWED_TOOLS', options.allowedTools);
  // GT6: the guard travels as its own variable and carries its lease-state input with it. Presence
  // alone puts the child in guarded mode, so an empty or malformed value denies rather than allows.
  if (options.policyGuard !== undefined) {
    env[PI_POLICY_GUARD_ENV] = JSON.stringify(options.policyGuard);
    // The selected state, not a constant: an in-trial step names the state it was armed under, and
    // the one-shot parent path — which supplies none — keeps Gate 2's default.
    env[PI_LEASE_STATE_ENV] = options.leaseState ?? GATE2_LEASE_STATE;
  }
  setOptional(env, PI_MCP_COMPOSITION_ENV, options.mcpComposition);
  setOptional(env, PI_BENCHMARK_DEADLINE_ENV, options.deadlineEpochMs);
  setOptional(env, PI_PLUGIN_MCP_CONFIG_ENV, options.pluginMcpConfigPath);
  setOptional(env, 'CORTEX_PI_SUBAGENT', options.subagentMarker);
  applyContext(env, options);
  return env;
}

export function buildSpawnArgs(opts: PISpawnOptions): string[] {
  const args: string[] = ['--mode', 'rpc', '--session-dir', opts.sessionDir];
  appendModelArgs(args, opts);
  appendSessionArgs(args, opts);
  appendOptionalArg(args, '--system-prompt', opts.systemPrompt);
  appendNonEmptyArgs(args, '--append-system-prompt', promptValues(opts.appendSystemPrompt));
  appendArgs(args, '--skill', [...(opts.pluginSkillDirs ?? []), ...(opts.pluginDirs ?? [])]);
  appendArgs(args, '--extension', opts.extensionPaths ?? []);
  // Before extraOption so an explicit {"--thinking": ...} still wins (CLI last-wins).
  appendOptionalArg(args, '--thinking', opts.thinking);
  appendExtraOptions(args, opts.extraOption);
  return args;
}
