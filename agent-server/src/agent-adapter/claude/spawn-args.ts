// input:  Claude options, composition, tool gates, hooks
// output: Claude args, interaction tools, MCP configs, env
// pos:    Resolves Claude process configuration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash } from 'crypto';
import {
  CORE_MCP_CONFIG,
  DEFAULT_TOOLS,
  EMPTY_MCP_CONFIG,
  FEISHU_MCP_CONFIG,
  MANAGER_QA_MCP_CONFIG,
  MCP_CONFIG,
  SLACK_MCP_CONFIG,
  TASKS_MCP_CONFIG,
  THREAD_MCP_CONFIG,
  INTERACTION_BRIDGE_TOOLS,
  INTERACTION_MCP_CONFIG,
  TUI_STRIP_TOOLS,
  TUI_TOOLS,
  WEB_MCP_CONFIG,
} from './defaults.js';
import { getSettings } from '@core/settings.js';
import { materializeMcpToolAllowlistConfigs } from '@core/config-generator.js';
import { MCP_INFRASTRUCTURE_TIMEOUT_MS } from '@core/mcp-timeout.js';
import type { McpComposition } from '../types.js';
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
  /** Canonical per-tool MCP allowlist. */
  mcpToolAllowlist?: string[] | null;
  /** Supplemental Claude MCP config written from portable runtime servers. */
  supplementalMcpConfigPath?: string | null;
  /** Omit all configured ambient hooks. */
  disableHooks?: boolean;
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
   *  mode, such sessions additionally get the cortex-interaction-bridge MCP tools
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
  if (wantsInteractionBridge) configs.push(INTERACTION_MCP_CONFIG);
  appendDirectMcpConfigs(configs, options, composition === 'direct');
  return materializeMcpToolAllowlistConfigs(
    configs, options.mcpToolAllowlist ?? undefined,
  );
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

function replaceInteractionTools(tools: string, includeBridge: boolean): string {
  const filtered = tools.split(',').filter(tool => tool && !TUI_STRIP_TOOLS.has(tool));
  const resolved = includeBridge ? [...filtered, ...INTERACTION_BRIDGE_TOOLS] : filtered;
  return [...new Set(resolved)].join(',');
}

function resolveEffectiveTools(
  options: ClaudeSpawnOptions,
  mode: ClaudeSpawnMode,
  isDirect: boolean,
  wantsInteractionBridge: boolean,
): string {
  const toolsDefault = mode === 'tui' && isDirect ? TUI_TOOLS : DEFAULT_TOOLS;
  const tools = options.tools || toolsDefault;
  if (wantsInteractionBridge) return replaceInteractionTools(tools, true);
  return mode === 'tui' ? replaceInteractionTools(tools, false) : tools;
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
  if (composition === 'none') args.push('--strict-mcp-config');
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

function buildClaudeSettings(
  options: ClaudeSpawnOptions,
  effectiveTools: string,
): Record<string, any> {
  const settings: Record<string, any> = {
    hooks: options.disableHooks ? {} : buildHooksSettings(effectiveTools),
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
  args.push('--settings', JSON.stringify(buildClaudeSettings(options, tools)));
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

/** Ambient Cortex context keys re-derived on every spawn, so a stale parent value can never leak
 *  in. CORTEX_EXECUTION_ID is deliberately absent: it is set from context but never reset. */
const CORTEX_CONTEXT_RESET_KEYS = [
  'CORTEX_THREAD_ID', 'CORTEX_PROFILE', 'CORTEX_PROJECT', 'CORTEX_SESSION_NAME',
  'CORTEX_THREAD_DEPTH', 'CORTEX_TASK_ID', 'CORTEX_TASK_PROJECT', 'CORTEX_TASK_GENERATION',
] as const;

function setIfPresent(env: NodeJS.ProcessEnv, key: string, value?: string | null): void {
  if (value) env[key] = value;
}

/** Startup-latency trims — kill network round-trips and first-run/IDE checks that Claude performs
 *  at launch but Cortex never benefits from (headless tmux/-p, plugin-loaded skills, no IDE). These
 *  only remove non-essential startup work; none change model behavior or disable experiment gates
 *  (we deliberately do NOT set DISABLE_TELEMETRY / NONESSENTIAL_TRAFFIC, which would). Must be set
 *  AFTER the CLAUDE_CODE* strip loop. See code.claude.com/docs/en/env-vars. */
function applyClaudeStartupEnv(env: NodeJS.ProcessEnv): void {
  env.MCP_TOOL_TIMEOUT = String(MCP_INFRASTRUCTURE_TIMEOUT_MS);
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.DISABLE_AUTOUPDATER = '1';                                  // no npm registry update check at launch
  env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = '1'; // skip first-run marketplace install
  env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = '1';                    // no IDE extension auto-install
  env.CLAUDE_CODE_AUTO_CONNECT_IDE = 'false';                     // no IDE auto-connect probe
  env.CLAUDE_CODE_DISABLE_POLICY_SKILLS = '1';                    // skip system managed-skills dir (Cortex uses pluginDirs)
  env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1';                   // no title updates; also skips the title-gen Haiku call in -p
}

/** Drops every inherited CLAUDE_CODE* control; only an ambient OAuth token is re-admitted, and
 *  never for a pinned trial environment. */
function resetClaudeCodeEnv(env: NodeJS.ProcessEnv, admitAmbientOauth: boolean): void {
  const oauthToken = admitAmbientOauth ? env.CLAUDE_CODE_OAUTH_TOKEN : undefined;
  delete env.CLAUDECODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE')) delete env[key];
  }
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  applyClaudeStartupEnv(env);
}

/** Chat-surface routing. A pinned trial keeps its exact environment and gets no host tokens. */
function applyChannelEnv(env: NodeJS.ProcessEnv, channel: string, pinned: boolean): void {
  if (pinned) return;
  env.SLACK_CHANNEL = channel;
  env.FEISHU_CHANNEL = channel;
  env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
}

/** Per-spawn env overrides: `extraEnv` sets (last-wins over everything above), then `unsetEnv`
 *  deletes. Deletion is a separate channel because a value can never mean "absent" — the empty
 *  string is a legal value elsewhere in the spawn path. */
function applyEnvOverrides(
  env: NodeJS.ProcessEnv,
  extraEnv?: Record<string, string>,
  unsetEnv?: string[],
): void {
  for (const [key, value] of Object.entries(extraEnv ?? {})) env[key] = value;
  for (const key of unsetEnv ?? []) delete env[key];
}

/** Env keys that carry a credential. Their values only ever leave this module as a digest. */
const ROUTE_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/** The three per-spawn channels that decide where a child sends its requests and with which
 *  credential: the dedicated base-URL field, the env overrides, and the env deletions. */
export interface ClaudeRouteInputs {
  anthropicBaseUrl?: string;
  extraEnv?: Record<string, string>;
  unsetEnv?: string[];
}

/** 8 hex of sha256: enough to tell two credentials apart, not enough to walk back to either. A
 *  pooled session outlives the turn that created it, so the raw value must never enter a
 *  comparison struct — that struct is exactly what ends up in a debug dump. */
function credentialFingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

/** What the child ends up with for `key`, in the order {@link buildClaudeEnv} applies: the
 *  dedicated field is the base, `extraEnv` overrides it, `unsetEnv` deletes it.
 *  `null` = deleted, `undefined` = inherited from the daemon env. */
function routeEnvValue(
  key: string,
  route: ClaudeRouteInputs,
  base?: string,
): string | null | undefined {
  if (route.unsetEnv?.includes(key)) return null;
  return route.extraEnv?.[key] ?? base;
}

/** `deleted` and `inherited` stay distinct on purpose: one pins the child to no credential at
 *  all, the other leaves it to whatever the daemon env happens to hold at spawn time. */
function routeToken(value: string | null | undefined, render: (v: string) => string): string {
  if (value === null) return 'deleted';
  if (value === undefined) return 'inherited';
  return render(value);
}

/** Identity of the route this spawn would take: the endpoint verbatim (not a secret, and worth
 *  reading when a pool mismatch is investigated) plus one digest per credential. Session pools
 *  compare it so a mode switch can never hand a caller a live process that is still pointed at
 *  the previous gateway or still holding the previous account's key (K-053). */
export function claudeRouteIdentity(route: ClaudeRouteInputs): string {
  const endpoint = routeToken(
    // setIfPresent skips a falsy field, so an empty base URL means "no base URL", not "empty".
    routeEnvValue('ANTHROPIC_BASE_URL', route, route.anthropicBaseUrl || undefined),
    (value) => `url:${value}`,
  );
  const credentials = ROUTE_CREDENTIAL_KEYS.map(
    (key) => `${key}=${routeToken(routeEnvValue(key, route), credentialFingerprint)}`,
  );
  return [endpoint, ...credentials].join(' ');
}

function cortexContextEnv(context?: CortexAgentContext): Record<string, string | undefined> {
  const depth = context?.threadDepth;
  return {
    CORTEX_THREAD_ID: context?.threadId,
    CORTEX_THREAD_DEPTH: depth == null ? undefined : String(depth),
    CORTEX_PROFILE: context?.profile,
    CORTEX_PROJECT: context?.project,
    CORTEX_SESSION_NAME: context?.sessionName,
    CORTEX_EXECUTION_ID: context?.executionId,
    CORTEX_TASK_ID: context?.taskId,
    CORTEX_TASK_PROJECT: context?.taskProject,
    CORTEX_TASK_GENERATION: context?.taskGeneration,
  };
}

/** Authoritative last word on the Cortex context keys: a child can neither inherit a stale value
 *  nor forge one through extraEnv/unsetEnv. */
function applyCortexContextEnv(env: NodeJS.ProcessEnv, context?: CortexAgentContext): void {
  for (const key of CORTEX_CONTEXT_RESET_KEYS) delete env[key];
  for (const [key, value] of Object.entries(cortexContextEnv(context))) setIfPresent(env, key, value);
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
  unsetEnv?: string[],
): NodeJS.ProcessEnv {
  // Allowlist-first for a pinned trial: the child starts from the exact trial environment and
  // inherits nothing from the host, so no denylist can leak a host credential or platform
  // surface into the trial (design §13 C5/C7).
  const env: NodeJS.ProcessEnv = pinnedEnv ? { ...pinnedEnv } : { ...process.env };
  resetClaudeCodeEnv(env, !pinnedEnv);
  applyChannelEnv(env, channel, !!pinnedEnv);
  // CORTEX_SESSION_ID is the stable Cortex tracking id (session-activity log routing + MCP context),
  // NOT the backend CLI's self-assigned session id. Falls back to the backend id when unset (threads).
  env.CORTEX_SESSION_ID = context?.trackSessionId ?? sessionId;
  setIfPresent(env, 'CORTEX_CALLBACK_SOURCE', callbackSource);
  setIfPresent(env, 'CORTEX_SCHEDULE_TASK_ID', scheduleTaskId);
  setIfPresent(env, 'ANTHROPIC_BASE_URL', anthropicBaseUrl);
  applyEnvOverrides(env, extraEnv, unsetEnv);
  applyCortexContextEnv(env, context);
  return env;
}
