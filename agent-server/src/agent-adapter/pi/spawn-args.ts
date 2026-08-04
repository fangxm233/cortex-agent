// input:  PI spawn options and task-aware AgentSpawnConfig context
// output: PI argv and isolated CORTEX_* subprocess environment
// pos:    Pure PI argument and environment construction
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { IdentityJsonValue } from '../../domain/agent-run/identity.js';
import type { AgentSpawnConfig, McpComposition } from '../types.js';
import {
  PI_LEASE_STATE_ENV, PI_MCP_COMPOSITION_ENV, PI_POLICY_GUARD_ENV, GATE2_LEASE_STATE,
} from './policy-guard.js';
import { PI_BENCHMARK_DEADLINE_ENV } from './mcp-duration.js';

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
  /** Resolved MCP composition; the bridge derives its server set from it (§5.6 P1). */
  mcpComposition?: McpComposition;
  /** Absolute trial deadline the MCP bridge bounds its calls against (§5.6 P2/P5). */
  deadlineEpochMs?: number;
}

const RESET_CONTEXT_KEYS = [
  'CORTEX_SESSION_ID', 'CORTEX_THREAD_ID', 'CORTEX_PROFILE',
  'CORTEX_PROJECT', 'CORTEX_SESSION_NAME', 'CORTEX_EXECUTION_ID',
  'CORTEX_THREAD_DEPTH', 'CORTEX_TASK_ID', 'CORTEX_TASK_PROJECT',
  'CORTEX_TASK_GENERATION',
  'CORTEX_CALLBACK_SOURCE', 'CORTEX_SCHEDULE_TASK_ID',
  'CORTEX_PI_ALLOWED_TOOLS',
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
    env[PI_LEASE_STATE_ENV] = GATE2_LEASE_STATE;
  }
  setOptional(env, PI_MCP_COMPOSITION_ENV, options.mcpComposition);
  setOptional(env, PI_BENCHMARK_DEADLINE_ENV, options.deadlineEpochMs);
  applyContext(env, options);
  return env;
}

export function buildSpawnArgs(opts: PISpawnOptions): string[] {
  const args: string[] = ['--mode', 'rpc', '--session-dir', opts.sessionDir];

  if (opts.model) {
    const cleaned = stripModelSuffix(opts.model);
    args.push('--model', cleaned);
    // Provider is decided by the active cortex profile (mode field). For non-Claude PI providers
    // (deepseek / openai-codex / etc.) cortex writes a multi-provider models.json (writeProvidersConfig)
    // that overrides each provider's baseUrl to the gateway, then PI selects the matching provider here.
    if (opts.provider) {
      args.push('--provider', opts.provider);
    }
  }

  // --session accepts a UUID or an exact path. The adapter resolves and supplies a path;
  // sessionId remains for explicit legacy callers.
  if (opts.sessionId && opts.sessionId.length > 0) {
    args.push('--session', opts.sessionId);
  } else if (opts.sessionPath && opts.sessionPath.length > 0) {
    args.push('--session', opts.sessionPath);
  }

  if (opts.systemPrompt && opts.systemPrompt.length > 0) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  if (opts.appendSystemPrompt) {
    const values = Array.isArray(opts.appendSystemPrompt)
      ? opts.appendSystemPrompt
      : [opts.appendSystemPrompt];
    for (const v of values) {
      if (v.length > 0) args.push('--append-system-prompt', v);
    }
  }

  if (opts.pluginDirs) {
    for (const dir of opts.pluginDirs) {
      args.push('--skill', dir);
    }
  }

  if (opts.extensionPaths) {
    for (const ext of opts.extensionPaths) {
      args.push('--extension', ext);
    }
  }

  // Before extraOption so an explicit extraOption {"--thinking": ...} still wins (CLI last-wins).
  if (opts.thinking) {
    args.push('--thinking', opts.thinking);
  }

  if (opts.extraOption) {
    for (const [k, v] of Object.entries(opts.extraOption)) args.push(k, v);
  }

  return args;
}
