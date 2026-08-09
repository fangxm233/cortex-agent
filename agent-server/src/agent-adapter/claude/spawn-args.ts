// input:  Claude options, context, composition, hooks
// output: Claude CLI args and isolated environment
// pos:    Resolves Claude process configuration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import {
  BENCHMARK_THREAD_MCP_CONFIG,
  CORE_MCP_CONFIG,
  DEFAULT_TOOLS,
  EMPTY_MCP_CONFIG,
  FEISHU_MCP_CONFIG,
  MANAGER_QA_MCP_CONFIG,
  MCP_CONFIG,
  SLACK_MCP_CONFIG,
  TASKS_MCP_CONFIG,
  THREAD_MCP_CONFIG,
  TUI_BRIDGE_TOOLS,
  TUI_MCP_CONFIG,
  TUI_STRIP_TOOLS,
  TUI_TOOLS,
  WEB_MCP_CONFIG,
} from './defaults.js';
import { getSettings } from '@core/settings.js';
import type { IdentityJsonValue } from '../../domain/agent-run/identity.js';
import type { McpComposition } from '../types.js';
// The cleanup grace is one backend-neutral quantity: design §5.7 C3 defines the Claude budget as
// "the same quantity as P2", so a second copy of `1000 + 5000` here could only ever drift from it.
import { MCP_CLEANUP_GRACE_MS } from '../pi/mcp-duration.js';
import { buildHooksSettings } from './hooks-builder.js';

/**
 * Adapter mode selector. `print` (default) uses `-p` + stream-json; `tui` uses interactive TUI
 * under tmux with jsonl tail (DR-0012). Both modes share the rest of the CLI surface.
 */
export type ClaudeSpawnMode = 'print' | 'tui';

export interface ClaudeSpawnOptions {
  tools: string | null;
  systemPrompt?: string | null;
  appendSystemPrompt?: string | null;
  model?: string | null;
  claudeAgent?: string | null;
  pluginDirs?: string[] | null;
  outputStyle?: string | null;
  needsResume: boolean;
  sessionId: string;
  /** Declared MCP privilege surface. Defaults to the ordinary direct surface. */
  mcpComposition?: McpComposition;
  /** Concrete MCP files supplied by a frozen one-shot run configuration. */
  mcpConfigPaths?: string[] | null;
  /** Supplemental Claude MCP config written from portable runtime servers. */
  supplementalMcpConfigPath?: string | null;
  /** Omit all configured **ambient** hooks for isolated one-shot execution. */
  disableHooks?: boolean;
  /** Compiled benchmark policy guard. Present makes the guard the entire hooks surface. */
  benchmarkPolicyGuard?: IdentityJsonValue;
  /** Explicit partial-message policy; absent reads the daemon setting. */
  streamDeltas?: boolean;
  /** Layer the cortex-slack MCP server on top of the base config. Set by the adapter for sessions
   *  that originate from Slack (channel carries the `slack:` prefix). Direct composition only. */
  loadSlackMcp?: boolean;
  /** Layer the cortex-feishu MCP server on top of the base config. Set by the adapter for sessions
   *  that originate from Feishu (channel carries the `feishu:` prefix). Direct composition only. */
  loadFeishuMcp?: boolean;
  /** Layer the cortex-web MCP server on top of the base config. Set by the adapter for sessions that
   *  originate from the Web UI (channel carries the `web:` prefix), enabling the send_file tool.
   *  Direct composition only. */
  loadWebMcp?: boolean;
  /** Thinking level from the profile's `thinking` field → `--effort <level>`
   *  (low/medium/high/xhigh/max). Absent → no flag. */
  thinking?: string | null;
  /** Extra CLI options from profile (e.g. {"--thinking": "xhigh"}). */
  extraOption?: Record<string, string> | null;
  /** DR-0012: select adapter mode. Default 'print' preserves -p stream-json behavior. */
  mode?: ClaudeSpawnMode;
  /** True for user-message-initiated sessions (not thread/scheduled pipeline workers). In print
   *  mode, such sessions additionally get the cortex-tui-bridge MCP interaction tools
   *  (cortex_plan_enter/exit, cortex_ask_user) because the native EnterPlanMode/ExitPlanMode/
   *  AskUserQuestion are filtered out by headless `-p`. Non-direct compositions never get them. */
  isUserInitiated?: boolean;
}

/** Token-level assistant streaming gate, read for each spawn argument build. */
export function isStreamDeltasEnabled(): boolean {
  return getSettings().streamDeltas;
}

const MCP_CONFIGS: Record<McpComposition, readonly string[]> = {
  direct: [MCP_CONFIG],
  'thread-control': [CORE_MCP_CONFIG, TASKS_MCP_CONFIG, MANAGER_QA_MCP_CONFIG, THREAD_MCP_CONFIG],
  none: [EMPTY_MCP_CONFIG],
  'benchmark-thread-run': [BENCHMARK_THREAD_MCP_CONFIG],
};

function appendDirectMcpConfigs(
  configs: string[],
  options: ClaudeSpawnOptions,
  isDirect: boolean,
): void {
  if (options.loadSlackMcp && isDirect) configs.push(SLACK_MCP_CONFIG);
  if (options.loadFeishuMcp && isDirect) configs.push(FEISHU_MCP_CONFIG);
  if (options.loadWebMcp && isDirect) configs.push(WEB_MCP_CONFIG);
}

function resolveMcpConfigs(
  options: ClaudeSpawnOptions,
  composition: McpComposition,
  wantsInteractionBridge: boolean,
): string[] {
  const configs = options.mcpConfigPaths
    ? [...options.mcpConfigPaths]
    : [...MCP_CONFIGS[composition]];
  if (options.supplementalMcpConfigPath
    && (composition === 'direct' || composition === 'thread-control')) {
    configs.push(options.supplementalMcpConfigPath);
  }
  if (wantsInteractionBridge) configs.push(TUI_MCP_CONFIG);
  appendDirectMcpConfigs(configs, options, composition === 'direct');
  return configs;
}

/** Print mode uses NDJSON stdio and replay echoes as queued-message delivery acknowledgements. */
function printModeArgs(options: ClaudeSpawnOptions, mode: ClaudeSpawnMode): string[] {
  if (mode !== 'print') return [];
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--replay-user-messages',
  ];
  if (options.streamDeltas ?? isStreamDeltasEnabled()) {
    args.push('--include-partial-messages');
  }
  return args;
}

function resolveEffectiveTools(
  options: ClaudeSpawnOptions,
  mode: ClaudeSpawnMode,
  isDirect: boolean,
  wantsInteractionBridge: boolean,
): string {
  const toolsDefault = mode === 'tui' && isDirect ? TUI_TOOLS : DEFAULT_TOOLS;
  let tools = options.tools || toolsDefault;
  if (mode === 'tui' && options.tools) {
    tools = options.tools.split(',').filter(tool => !TUI_STRIP_TOOLS.has(tool)).join(',');
  }
  if (mode === 'print' && wantsInteractionBridge) {
    tools = [tools, ...TUI_BRIDGE_TOOLS].filter(Boolean).join(',');
  }
  return tools;
}

function appendCoreArgs(
  args: string[],
  configs: string[],
  composition: McpComposition,
  tools: string,
): void {
  args.push(
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
    '--mcp-config', ...configs,
  );
  if (composition === 'none' || composition === 'benchmark-thread-run') {
    args.push('--strict-mcp-config');
  }
  args.push('--tools', tools);
}

function appendTruthyOptions(
  args: string[],
  options: ReadonlyArray<readonly [string, string | null | undefined]>,
): void {
  for (const [flag, value] of options) {
    if (value) args.push(flag, value);
  }
}

/** Thinking precedes extra options so an explicit extra --effort remains last-wins. */
function appendPromptOptions(args: string[], options: ClaudeSpawnOptions): void {
  appendTruthyOptions(args, [
    ['--system-prompt', options.systemPrompt],
    ['--append-system-prompt', options.appendSystemPrompt],
    ['--model', options.model],
    ['--effort', options.thinking],
    ['--agent', options.claudeAgent],
  ]);
}

function appendRepeatedOption(
  args: string[],
  flag: string,
  values: readonly string[] | null | undefined,
): void {
  for (const value of values ?? []) args.push(flag, value);
}

function appendExtraOptions(
  args: string[],
  options: Record<string, string> | null | undefined,
): void {
  for (const [flag, value] of Object.entries(options ?? {})) args.push(flag, value);
}

/** A compiled benchmark guard replaces the ambient hook surface completely. */
function buildClaudeSettings(options: ClaudeSpawnOptions): Record<string, any> {
  const settings: Record<string, any> = {
    hooks: options.benchmarkPolicyGuard !== undefined
      ? options.benchmarkPolicyGuard
      : (options.disableHooks ? {} : buildHooksSettings(options.tools)),
  };
  if (options.outputStyle) settings.outputStyle = options.outputStyle;
  return settings;
}

function appendSessionIdentity(args: string[], options: ClaudeSpawnOptions): void {
  if (options.needsResume) args.push('--resume', options.sessionId);
  else args.push('--session-id', options.sessionId);
}

export function buildSpawnArgs(options: ClaudeSpawnOptions): string[] {
  const mode = options.mode ?? 'print';
  const composition = options.mcpComposition ?? 'direct';
  const isDirect = composition === 'direct';
  const wantsInteractionBridge = isDirect
    && (mode === 'tui' || (mode === 'print' && !!options.isUserInitiated));
  const configs = resolveMcpConfigs(options, composition, wantsInteractionBridge);
  const args = printModeArgs(options, mode);
  const tools = resolveEffectiveTools(options, mode, isDirect, wantsInteractionBridge);
  appendCoreArgs(args, configs, composition, tools);
  appendPromptOptions(args, options);
  appendRepeatedOption(args, '--plugin-dir', options.pluginDirs);
  appendExtraOptions(args, options.extraOption);
  args.push('--settings', JSON.stringify(buildClaudeSettings(options)));
  appendSessionIdentity(args, options);
  return args;
}

/** Cortex agent execution context — surfaces as CORTEX_* env vars so MCP tools
 *  (cortex_context, cortex_schedule_*) can self-discover the current thread/profile/etc.
 *  Optional fields are omitted from env when undefined, so child processes see no key
 *  rather than an empty string. */
export interface CortexAgentContext {
  threadId?: string | null;
  profile?: string | null;
  project?: string | null;
  sessionName?: string | null;
  /** Stable Cortex tracking id (decoupled from the backend session id) → CORTEX_SESSION_ID. */
  trackSessionId?: string | null;
  /** Cortex execution record id, surfaced as CORTEX_EXECUTION_ID to subprocess env. */
  executionId?: string | null;
  /** When true, load the restricted thread MCP composition. */
  useCoreMcp?: boolean;
  /** Recursion depth of the owning thread, surfaced as CORTEX_THREAD_DEPTH so the thread_start
   *  MCP tool can forward it and the daemon-side depth guard can cap nested thread spawning. */
  threadDepth?: number | null;
  /** Owning dispatch task id/project (when the agent runs inside a task-dispatched thread),
   *  surfaced as CORTEX_TASK_ID / CORTEX_TASK_PROJECT so `cortex-task spawn` can infer the
   *  current task as the parent of a child task without the agent re-declaring it. */
  taskId?: string | null;
  taskProject?: string | null;
  taskGeneration?: string | null;
}

export function buildClaudeEnv(
  channel: string,
  sessionId: string,
  callbackSource?: string | null,
  scheduleTaskId?: string | null,
  anthropicBaseUrl?: string,
  extraEnv?: Record<string, string>,
  context?: CortexAgentContext,
  pinnedEnv?: NodeJS.ProcessEnv,
  benchmarkDeadlineEpochMs?: number,
): NodeJS.ProcessEnv {
  // Allowlist-first for a pinned trial: the child starts from the exact trial environment and
  // inherits nothing from the host, so no denylist can leak a host credential or platform
  // surface into the trial (design §13 C5/C7).
  const env: NodeJS.ProcessEnv = pinnedEnv ? { ...pinnedEnv } : { ...process.env };
  delete env.CLAUDECODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE')) delete env[key];
  }
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  // Startup-latency trims — kill network round-trips and first-run/IDE checks that Claude performs
  // at launch but Cortex never benefits from (headless tmux/-p, plugin-loaded skills, no IDE). These
  // only remove non-essential startup work; none change model behavior or disable experiment gates
  // (we deliberately do NOT set DISABLE_TELEMETRY / NONESSENTIAL_TRAFFIC, which would). Must be set
  // AFTER the CLAUDE_CODE* strip loop above. See code.claude.com/docs/en/env-vars.
  env.DISABLE_AUTOUPDATER = '1';                                  // no npm registry update check at launch
  env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = '1'; // skip first-run marketplace install
  env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = '1';                    // no IDE extension auto-install
  env.CLAUDE_CODE_AUTO_CONNECT_IDE = 'false';                     // no IDE auto-connect probe
  env.CLAUDE_CODE_DISABLE_POLICY_SKILLS = '1';                    // skip system managed-skills dir (Cortex uses pluginDirs)
  env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1';                   // no title updates; also skips the title-gen Haiku call in -p
  if (!pinnedEnv) {
    env.SLACK_CHANNEL = channel;
    env.FEISHU_CHANNEL = channel;
    env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  }
  // CORTEX_SESSION_ID is the stable Cortex tracking id (session-activity log routing + MCP context),
  // NOT the backend CLI's self-assigned session id. Falls back to the backend id when unset (threads).
  env.CORTEX_SESSION_ID = context?.trackSessionId ?? sessionId;
  if (callbackSource) env.CORTEX_CALLBACK_SOURCE = callbackSource;
  if (scheduleTaskId) env.CORTEX_SCHEDULE_TASK_ID = scheduleTaskId;
  if (anthropicBaseUrl) env.ANTHROPIC_BASE_URL = anthropicBaseUrl;
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) env[key] = value;
  }
  // The CLI owns the MCP client on this backend, so the only budget Cortex can supply is the pair it
  // reads from its environment: `MCP_TOOL_TIMEOUT` per tool call and `MCP_TIMEOUT` for server
  // startup. Both carry the remaining trial time plus the cleanup grace, so a benchmark call
  // outlives the CLI's native default yet is still cut off with the trial rather than after it.
  // Derived here, at the instant the child environment is built, and never carried as a stored
  // duration; written after the `extraEnv` merge so an inherited value cannot raise the bound.
  if (benchmarkDeadlineEpochMs !== undefined) {
    const budgetMs = Math.max(0, benchmarkDeadlineEpochMs - Date.now()) + MCP_CLEANUP_GRACE_MS;
    env.MCP_TOOL_TIMEOUT = String(budgetMs);
    env.MCP_TIMEOUT = String(budgetMs);
  }
  delete env.CORTEX_THREAD_ID;
  delete env.CORTEX_PROFILE;
  delete env.CORTEX_PROJECT;
  delete env.CORTEX_SESSION_NAME;
  delete env.CORTEX_THREAD_DEPTH;
  delete env.CORTEX_TASK_ID;
  delete env.CORTEX_TASK_PROJECT;
  delete env.CORTEX_TASK_GENERATION;
  if (context?.threadId) env.CORTEX_THREAD_ID = context.threadId;
  if (context?.threadDepth != null) env.CORTEX_THREAD_DEPTH = String(context.threadDepth);
  if (context?.profile) env.CORTEX_PROFILE = context.profile;
  if (context?.project) env.CORTEX_PROJECT = context.project;
  if (context?.sessionName) env.CORTEX_SESSION_NAME = context.sessionName;
  if (context?.executionId) env.CORTEX_EXECUTION_ID = context.executionId;
  if (context?.taskId) env.CORTEX_TASK_ID = context.taskId;
  if (context?.taskProject) env.CORTEX_TASK_PROJECT = context.taskProject;
  if (context?.taskGeneration) env.CORTEX_TASK_GENERATION = context.taskGeneration;
  return env;
}
