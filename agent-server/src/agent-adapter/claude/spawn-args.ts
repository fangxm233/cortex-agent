// input:  Claude options, task context, composition, hooks
// output: Claude CLI arguments and isolated child environment
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

export function buildSpawnArgs(options: ClaudeSpawnOptions): string[] {
  const mode: ClaudeSpawnMode = options.mode ?? 'print';
  const composition = options.mcpComposition ?? 'direct';
  const isDirect = composition === 'direct';
  const wantsInteractionBridge = isDirect
    && (mode === 'tui' || (mode === 'print' && !!options.isUserInitiated));
  const mcpConfigs = options.mcpConfigPaths
    ? [...options.mcpConfigPaths]
    : [...MCP_CONFIGS[composition]];
  if (wantsInteractionBridge) mcpConfigs.push(TUI_MCP_CONFIG);
  // Slack-originated sessions additionally layer the cortex-slack server (slack_send_file tool).
  // Suppressed for non-direct compositions.
  if (options.loadSlackMcp && isDirect) mcpConfigs.push(SLACK_MCP_CONFIG);
  // Feishu-originated sessions additionally layer the cortex-feishu server (Feishu document tools).
  // Suppressed for non-direct compositions.
  if (options.loadFeishuMcp && isDirect) mcpConfigs.push(FEISHU_MCP_CONFIG);
  // Web-UI-originated sessions additionally layer the cortex-web server (send_file tool).
  // Suppressed for non-direct compositions.
  if (options.loadWebMcp && isDirect) mcpConfigs.push(WEB_MCP_CONFIG);
  // TUI tool whitelist swaps the three native interaction tools for their MCP bridge equivalents;
  // non-direct TUI sessions have no bridge server, so they fall back to the standard tool set.
  const toolsDefault = (mode === 'tui' && isDirect) ? TUI_TOOLS : DEFAULT_TOOLS;

  const args: string[] = [];

  if (mode === 'print') {
    // Stream-json over stdio for -p mode (current behavior — preserved exactly for regression)
    args.push(
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      // Echo every user message back as a `user` event carrying `isReplay: true`, at the moment
      // the CLI CONSUMES it rather than when it was written. That echo is the delivery
      // ack for a mid-turn injected message — the only signal that distinguishes "queued in the
      // CLI" from "in the model's view". Only the injection ack consumes these events; every other
      // `user` handler ignores replays (they are otherwise indistinguishable from the tool_result
      // carriers print mode already emits).
      '--replay-user-messages',
    );
    // Token-level streaming: adds `stream_event` lines (message_start / content_block_start /
    // content_block_delta / …) on top of the complete `assistant` / `result` events, which are
    // unchanged — the addition is purely incremental, so every existing parser stays correct.
    // It is what lets the Web UI show text as it is generated instead of waiting for the whole
    // block (measured gap on a long reply: first delta at ~3.5s vs the complete event at ~25s).
    // TUI mode reads the session jsonl, not stdout, so the flag would be pure overhead there.
    if (options.streamDeltas ?? isStreamDeltasEnabled()) args.push('--include-partial-messages');
  }
  // TUI mode: strip native interaction tools (AskUserQuestion / EnterPlanMode / ExitPlanMode)
  // from ALL sessions (user messages and threads alike). These tools require stdin/stdout
  // interaction that tmux-pasted TUI sessions cannot provide.
  let effectiveTools = options.tools || toolsDefault;
  if (mode === 'tui' && options.tools) {
    effectiveTools = options.tools.split(',').filter(t => !TUI_STRIP_TOOLS.has(t)).join(',');
  }
  // Print mode, user-initiated direct sessions: append the cortex-tui-bridge interaction tools.
  // The native EnterPlanMode/ExitPlanMode/AskUserQuestion are dropped by headless -p regardless of
  // the allowlist, so these MCP equivalents are the only way plan/ask reaches the user. TUI mode
  // already carries them via TUI_TOOLS, so only the print branch needs the append.
  if (mode === 'print' && wantsInteractionBridge) {
    effectiveTools = [effectiveTools, ...TUI_BRIDGE_TOOLS].filter(Boolean).join(',');
  }

  // Both modes: permission bypass + MCP + tools
  args.push(
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
    '--mcp-config', ...mcpConfigs,
  );
  if (composition === 'none' || composition === 'benchmark-thread-run') {
    args.push('--strict-mcp-config');
  }
  args.push('--tools', effectiveTools);
  if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  if (options.model) args.push('--model', options.model);
  // Before extraOption so an explicit extraOption {"--effort": ...} still wins (CLI last-wins).
  if (options.thinking) args.push('--effort', options.thinking);
  if (options.claudeAgent) args.push('--agent', options.claudeAgent);
  if (options.pluginDirs) {
    for (const dir of options.pluginDirs) args.push('--plugin-dir', dir);
  }
  if (options.extraOption) {
    for (const [k, v] of Object.entries(options.extraOption)) args.push(k, v);
  }
  // A compiled benchmark guard is the whole hook surface: the ambient registry is never consulted,
  // and `disableHooks` keeps its shipped meaning of "no AMBIENT hooks" (design §13 GT5, §6.5).
  const settings: Record<string, any> = {
    hooks: options.benchmarkPolicyGuard !== undefined
      ? options.benchmarkPolicyGuard
      : (options.disableHooks ? {} : buildHooksSettings(options.tools)),
  };
  if (options.outputStyle) settings.outputStyle = options.outputStyle;
  args.push('--settings', JSON.stringify(settings));
  if (options.needsResume) args.push('--resume', options.sessionId);
  else args.push('--session-id', options.sessionId);
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
