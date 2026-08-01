// input:  run configuration, adapters, profiles, sinks
// output: attributed runs, observer streams, spawn policy
// pos:    Backend-neutral agent run facade
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { getAdapter, resolveMcpComposition } from '../../agent-adapter/index.js';
import type {
  AgentAdapter, AgentCompactResult, AgentProcess, AgentProcessSpawner, AgentSpawnConfig, Backend,
  McpComposition, NormalizedEvent,
} from '../../agent-adapter/index.js';
import {
  canAwaitBgContinuation, shouldAwaitBgInline, waitForBgContinuation,
} from '../../agent-adapter/bg-wait.js';
import {
  consumeEventStream, createProcessCloser, createRunEventTee, settleEventfulRun,
} from '../../agent-adapter/event-tee.js';
import { resolveProfileConfig } from './profile-manager.js';
import type { ResolvedProfileConfig } from './profile-manager.js';
import type { AgentHandle, AgentResult, ChatNoticeLevel, ContextUsage } from '@core/types/agent-types.js';
import { recordCost } from '../costs/cost-tracker.js';
import { configureEnvForMode, isApiRateLimitError, isRetryableResult, isRetryableError } from './config.js';
import { isProviderModeRateLimited, isProviderRateLimited, isThrottled } from '../costs/rate-limit-throttle.js';
import { GATEWAY_URL } from '../costs/gateway-manager.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { loadCortexRules } from '../memory/rules-loader.js';
import { t } from '../../core/i18n.js';

const log = createLogger('facade');

function assistantNoticeLevel(text: string): ChatNoticeLevel | undefined {
  return text.startsWith('API Error:') ? 'error' : undefined;
}

function configLabel(config: AgentConfig): string {
  return `${config.model}/${config.mode || 'default'}`;
}

function terminalErrorText(message: string): string {
  return message.startsWith('API Error:') ? message : t('status.errorBody', { message });
}

/** Track error notices within one provider attempt so terminal handling is durable but not noisy.
 *  runWithAdapter drains its event loop before rejecting, so any API Error from that attempt has
 *  already reached this tracker. A fallback starts a new dedupe window because its terminal
 *  failure must not be hidden by the previous provider's notice. */
class AttemptNoticeTracker {
  readonly options: RunAgentOptions;
  private readonly forward: RunAgentOptions['onAssistantMessage'];
  private readonly generateNotices: boolean;
  private attemptHasErrorNotice = false;

  constructor(private readonly original: RunAgentOptions) {
    this.forward = original.onAssistantMessage ?? null;
    this.generateNotices = original.channel?.startsWith('web:') === true;
    this.options = this.forward
      ? { ...original, onAssistantMessage: (text, blockId, level) => this.observe(text, blockId, level) }
      : original;
  }

  private observe(text: string, blockId?: string, level?: ChatNoticeLevel): void {
    if (level === 'error') this.attemptHasErrorNotice = true;
    this.forward?.(text, blockId, level);
  }

  private emitTerminal(message: string, displayText = terminalErrorText(message)): void {
    if (!this.generateNotices || !this.forward || this.attemptHasErrorNotice) return;
    this.attemptHasErrorNotice = true;
    this.forward(displayText, undefined, 'error');
  }

  private emitAutoResume(provider: string | undefined): boolean {
    if (!this.original.isUserInitiated || !isProviderRateLimited(provider)) return false;
    if (this.generateNotices && this.forward && !this.attemptHasErrorNotice) {
      this.attemptHasErrorNotice = true;
      this.forward(t('notify.rateLimitAutoResume'), undefined, 'warning');
    }
    return true;
  }

  async transitionToFallback(
    current: AgentConfig,
    next: AgentConfig,
    result: AgentResult | null,
    error?: Error,
  ): Promise<void> {
    await this.original.onFallback?.(current, next, result, error);
    if (this.generateNotices) {
      this.observe(t('notify.agentFallback', {
        from: configLabel(current), to: configLabel(next),
      }), undefined, 'warning');
    }
    this.attemptHasErrorNotice = false;
  }

  emitTerminalError(error: unknown): void {
    const value = error as {
      message?: unknown;
      cancelled?: boolean;
      rateLimitProvider?: string;
    } | null | undefined;
    if (value?.cancelled) return;
    const message = typeof value?.message === 'string' && value.message.length > 0
      ? value.message
      : String(error);
    const resumableDirectError = this.original.trigger !== 'edit-retry'
      && isApiRateLimitError(message)
      && this.emitAutoResume(value?.rateLimitProvider);
    if (!resumableDirectError) this.emitTerminal(message);
  }

  emitTerminalRateLimit(result: AgentResult): void {
    if (this.emitAutoResume(result.rateLimitProvider)) return;
    const detail = result.rateLimitMessage;
    if (typeof detail === 'string' && detail.startsWith('API Error:')) this.emitTerminal(detail);
    else this.emitTerminal(t('status.rateLimitedExhausted'), t('status.rateLimitedExhausted'));
  }
}

const DEFAULT_PROVIDER_BY_BACKEND: Partial<Record<Backend, string>> = {
  claude: 'anthropic',
};

export function resolveRateLimitProvider(config: Pick<AgentConfig, 'backend' | 'provider'>): string {
  return config.provider || DEFAULT_PROVIDER_BY_BACKEND[config.backend] || config.backend;
}

function withRateLimitProvider(handle: AgentHandle, provider: string): AgentHandle {
  return {
    promise: handle.promise.then(
      (result) => ({ ...result, rateLimitProvider: result.rateLimitProvider || provider }),
      (error) => {
        if (isRetryableError(error as Error)) {
          (error as Error & { rateLimitProvider?: string }).rateLimitProvider ??= provider;
        }
        throw error;
      },
    ),
    kill: () => handle.kill(),
    get sessionId(): string | null { return handle.sessionId ?? null; },
    get agentProcess() { return handle.agentProcess; },
  };
}

function configIsRateLimited(config: AgentConfig): boolean {
  return isProviderModeRateLimited(resolveRateLimitProvider(config), config.mode || 'api');
}

function rateLimitedResult(mode: string, provider: string): AgentResult {
  return {
    sessionId: null, total_cost_usd: null, num_turns: null,
    rateLimited: true, rateLimitMessage: `Mode ${mode} is rate-limited`, rateLimitProvider: provider,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false, finalOutput: null,
  };
}

function withTerminalNotices(handle: AgentHandle, notices: AttemptNoticeTracker): AgentHandle {
  let killed = false;
  return {
    promise: handle.promise.then(
      (result) => {
        if (result.rateLimited) notices.emitTerminalRateLimit(result);
        return result;
      },
      (error) => {
        if (!killed) notices.emitTerminalError(error);
        throw error;
      },
    ),
    kill: () => {
      killed = true;
      return handle.kill();
    },
    get sessionId(): string | null { return handle.sessionId; },
    get agentProcess() { return handle.agentProcess; },
  };
}

// --- Types ---

export interface AgentConfig {
  model: string;
  backend: Backend;
  mode: string | null;
  /** Opaque rate-limit provider identity; for PI it also selects the request protocol. */
  provider?: string | null;
  extraEnv?: Record<string, string>;
  extraOption?: Record<string, string>;
  /** DR-0012: Claude adapter mode (print/tui). Only meaningful for backend='claude'. */
  claudeBackend?: 'print' | 'tui';
  /** Thinking level from the profile (backend-native value: claude → --effort, pi → --thinking).
   *  null/undefined → nothing is passed. */
  thinking?: string | null;
}

export interface RunObserver {
  onEvent(event: NormalizedEvent): void;
  onClose?(): void | Promise<void>;
}

export interface RunAgentOptions {
  profileName?: string | null;
  /** Backend resume target (Claude `--resume` / PI `--session`). null → fresh (backend self-assigns
   *  its own id). Decoupled from {@link trackSessionId}. */
  sessionId?: string | null;
  /** Stable Cortex tracking id (UI-facing identity) — surfaced as CORTEX_SESSION_ID only; does NOT
   *  drive backend resume. Defaults to `sessionId` when unset (threads / legacy callers). */
  trackSessionId?: string | null;
  sessionKey?: string | null;
  channel?: string;
  files?: unknown[];
  /** Best-effort synchronous event observers; failures are logged and ignored. */
  observers?: RunObserver[];
  /** Synchronous event sinks whose write or close failure aborts the run. */
  requiredSinks?: RunObserver[];
  /** Explicit background policy. Undefined preserves the legacy thread-keyed decision. */
  awaitBackground?: boolean;
  /** Absolute working directory resolved by the caller for the backend process. */
  cwd?: string;
  /** Optional containment-aware process boundary for daemon-free runs. */
  processSpawner?: AgentProcessSpawner;
  /** Pre-resolved spawn input used when identity must hash the exact object before launch. */
  preparedSpawnConfig?: AgentSpawnConfig;
  /** Concrete MCP config paths frozen by a one-shot run config. */
  mcpConfigPaths?: string[];
  /** Suppress hooks for an isolated one-shot role. */
  disableHooks?: boolean;
  /** Explicit streaming policy for runs that must not load watched daemon settings. */
  streamDeltas?: boolean;
  /** Suppress legacy transcript logs when a required journal is configured. */
  captureTranscriptLogs?: boolean;
  /** Disable ambient global rules for a frozen role prompt. */
  loadCortexRules?: boolean;
  /** Disable daemon cost-store writes while preserving streamed cost records. */
  recordCost?: boolean;
  callbackSource?: string | null;
  scheduleTaskId?: string | null;
  isUserInitiated?: boolean;
  project?: string;
  trigger?: string;
  /** Cortex execution context surfaced to the MCP server child as CORTEX_THREAD_ID/PROFILE/PROJECT/SESSION_NAME env vars.
   *  Read by the cortex_context / cortex_schedule_* MCP tools so LLMs can self-discover their thread and target schedules
   *  at the current thread / session without guessing IDs. */
  threadId?: string | null;
  sessionName?: string | null;
  /** Cortex execution record id, surfaced as CORTEX_EXECUTION_ID to subprocess env. */
  executionId?: string | null;
  /** Explicit MCP privilege surface for the spawned backend. */
  mcpComposition?: McpComposition;
  /** Legacy thread-surface selector. Accepted for existing callers and resolved when the explicit
   *  composition is absent. */
  useCoreMcp?: boolean;
  /** Recursion depth of the owning thread, surfaced to the spawned agent as CORTEX_THREAD_DEPTH
   *  so the thread_start MCP tool can forward it for the depth guard. */
  threadDepth?: number | null;
  /** Owning dispatch task id/project, surfaced as CORTEX_TASK_ID / CORTEX_TASK_PROJECT so
   *  `cortex-task spawn` can infer the current task as the parent of a child task. */
  taskId?: string | null;
  taskProject?: string | null;
  onProgress?: ((progress: any) => void) | null;
  onContextUsage?: ((usage: ContextUsage) => void | Promise<void>) | null;
  /** A complete assistant text block. `blockId` ties it to prior deltas; `noticeLevel` turns
   *  system-authored text into semantic chat chrome without changing plain platform output. */
  onAssistantMessage?: ((msg: string, blockId?: string, noticeLevel?: ChatNoticeLevel) => void) | null;
  /** An incremental text chunk of a block still being generated (never the accumulated total).
   *  Opt-in: callers that leave it unset receive complete messages only, exactly as before. */
  onAssistantDelta?: ((text: string, blockId: string) => void) | null;
  onToolUse?: ((name: string, input: any, toolUseId: string) => void) | null;
  onToolResult?: ((toolUseId: string, content: string, isError: boolean) => void) | null;
  onFallback?: (current: AgentConfig, next: AgentConfig, result: AgentResult | null, error?: Error) => Promise<void>;
  [key: string]: any;
}

// --- PI gateway routing ---

/**
 * Build the gateway sub-path for a PI provider's models.json override, following the gateway's URL
 * convention `/m/<mode>/<endpoint>`. The `mode` selects the gateway route (gateway.yaml owns the
 * upstream + keys); the `provider` is both the PI `--provider` and the gateway endpoint segment.
 *
 * `provider` is required for pi profiles (validated at load time — no default, no fallback). Returns
 * undefined when `mode` is absent — the PI adapter then falls back to the default `/<provider>` path
 * (direct per-provider routing, no `/m/` mode indirection).
 *
 * Keeping this derivation in code (not in the profile) means profiles only carry the logical
 * `mode` name; no gateway path string leaks into profiles.json.
 */
export function buildPiGatewaySubPath(mode: string | null, provider: string): string | undefined {
  if (!mode) return undefined;
  return `/m/${mode}/${provider}`;
}

// --- Channel-scoped plugin gating ---

/** Plugins that load only for sessions originating from a specific platform channel.
 *  Mirrors the channel-gated MCP loading (loadFeishuMcp = channel.startsWith('feishu:')):
 *  the cortex-feishu skill bundle is only relevant when the user is working inside Feishu,
 *  so it is stripped from non-Feishu sessions even when listed in an agent's pluginDirs. */
export const CHANNEL_SCOPED_PLUGINS: ReadonlyArray<{ plugin: string; channelPrefix: string }> = [
  { plugin: 'cortex-feishu', channelPrefix: 'feishu:' },
];

/** Drop channel-scoped plugin dirs whose channel prefix the current session does not match.
 *  Non-scoped plugins always pass through. Matched by the plugin dir's final path segment
 *  (basename) so substrings like `cortex-feishu-x` are not affected. */
export function filterChannelScopedPlugins(
  dirs: string[] | undefined,
  channel: string | undefined,
): string[] | undefined {
  if (!dirs) return dirs;
  return dirs.filter((dir) => {
    const base = dir.split('/').filter(Boolean).pop();
    const rule = CHANNEL_SCOPED_PLUGINS.find((r) => r.plugin === base);
    if (!rule) return true;
    return !!channel && channel.startsWith(rule.channelPrefix);
  });
}

// --- Adapter execution ---

export function buildAgentSpawnConfig(
  options: RunAgentOptions,
  config: AgentConfig,
  anthropicBaseUrl: string | undefined,
): AgentSpawnConfig {
  // Pack the Cortex execution context only if at least one field is set, so adapters can
  // skip writing CORTEX_* env vars / route-context fields when there's nothing to report.
  const ctx = {
    threadId: options.threadId ?? null,
    profile: options.profileName ?? null,
    project: options.project ?? null,
    sessionName: options.sessionName ?? null,
    // Stable Cortex tracking id for CORTEX_SESSION_ID; falls back to the backend id (threads/legacy).
    trackSessionId: options.trackSessionId ?? options.sessionId ?? null,
    executionId: options.executionId ?? null,
    useCoreMcp: options.useCoreMcp ?? undefined,
    threadDepth: options.threadDepth ?? null,
    taskId: options.taskId ?? null,
    taskProject: options.taskProject ?? null,
  };
  const hasContext = !!(ctx.threadId || ctx.profile || ctx.project || ctx.sessionName || ctx.trackSessionId || ctx.executionId || ctx.useCoreMcp || ctx.threadDepth != null || ctx.taskId || ctx.taskProject);

  // Load global rules (no paths frontmatter) and inject as appendSystemPrompt.
  // Scoped rules (with paths) are handled by the Read/Grep PostToolUse hook.
  const rules = options.loadCortexRules === false ? [] : loadCortexRules().global;
  const appendSystemPrompt = rules.length > 0
    ? rules.map(rule => rule.body).join('\n\n---\n\n')
    : undefined;

  return {
    sessionId: options.sessionId ?? null,
    sessionKey: options.sessionKey || options.channel || 'default',
    resume: !!options.sessionId,
    model: config.model,
    systemPrompt: typeof options.systemPrompt === 'string' ? options.systemPrompt : undefined,
    outputStyle: typeof options.outputStyle === 'string' ? options.outputStyle : undefined,
    cwd: options.cwd,
    mcpComposition: resolveMcpComposition(options.mcpComposition, options.useCoreMcp),
    mcpConfigPaths: options.mcpConfigPaths,
    disableHooks: options.disableHooks,
    streamDeltas: options.streamDeltas,
    captureTranscriptLogs: options.captureTranscriptLogs,
    processSpawner: options.processSpawner,
    pluginDirs: filterChannelScopedPlugins(
      Array.isArray(options.pluginDirs) ? options.pluginDirs : undefined,
      options.channel,
    ),
    env: config.extraEnv && Object.keys(config.extraEnv).length > 0 ? config.extraEnv : undefined,
    extraOption: config.extraOption && Object.keys(config.extraOption).length > 0 ? config.extraOption : undefined,
    claudeBackend: config.claudeBackend,
    thinking: config.thinking || undefined,
    channel: options.channel,
    claudeAgent: options.claudeAgent ?? undefined,
    callbackSource: options.callbackSource ?? undefined,
    scheduleTaskId: options.scheduleTaskId ?? undefined,
    isUserInitiated: !!options.isUserInitiated,
    rawTools: typeof options.tools === 'string' ? options.tools : undefined,
    anthropicBaseUrl,
    // PI-specific routing: provider name (= profile mode) + gateway base URL. PI adapter writes
    // a multi-provider models.json (writeProvidersConfig) so every PI provider lands on the
    // gateway. Claude ignores these fields.
    // PI routing: `provider` is the --provider (protocol; required for pi, validated at load — no
    // default). The gateway sub-path `/m/<mode>/<provider>` is derived from the profile's logical
    // `mode` (gateway.yaml owns the route).
    piProvider: config.backend === 'pi' && config.provider ? config.provider : undefined,
    piGatewayPath: config.backend === 'pi' && config.provider ? buildPiGatewaySubPath(config.mode, config.provider) : undefined,
    piGatewayBaseUrl: config.backend === 'pi' ? GATEWAY_URL : undefined,
    cortexContext: hasContext ? ctx : undefined,
    appendSystemPrompt,
  };
}

type LegacyEventHandler = (event: any) => void | Promise<void>;

class LegacyEventDispatcher {
  private active = true;
  private readonly handlers: Partial<Record<NormalizedEvent['type'], LegacyEventHandler>>;

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly options: RunAgentOptions,
    private readonly config: AgentConfig,
    private readonly spawnConfig: AgentSpawnConfig,
  ) {
    this.handlers = {
      session_started: (event) => this.sessionStarted(event),
      assistant_text: (event) => this.assistantText(event),
      assistant_delta: (event) => this.assistantDelta(event),
      tool_use: (event) => this.toolUse(event),
      tool_result: (event) => this.toolResult(event),
      turn_progress: (event) => this.turnProgress(event),
      context_usage: (event) => this.contextUsage(event),
      turn_complete: (event) => this.turnComplete(event),
      cost_record: (event) => this.costRecord(event),
      context_compacted: () => this.contextCompacted(),
      plan_written: (event) => this.planWritten(event),
      ask_user_question: (event) => this.askUserQuestion(event),
    };
  }

  async dispatch(event: NormalizedEvent): Promise<void> {
    if (!this.active) return;
    await this.handlers[event.type]?.(event);
  }

  private sessionStarted(event: Extract<NormalizedEvent, { type: 'session_started' }>): void {
    if (!this.options.channel?.startsWith('web:')) return;
    if (!this.spawnConfig.resume || !this.spawnConfig.sessionId) return;
    if (event.sessionId === this.spawnConfig.sessionId) return;
    this.options.onAssistantMessage?.(t('notify.backendSessionReset'), undefined, 'warning');
  }

  private assistantText(event: Extract<NormalizedEvent, { type: 'assistant_text' }>): void {
    this.options.onAssistantMessage?.(event.text, event.blockId, assistantNoticeLevel(event.text));
  }

  private assistantDelta(event: Extract<NormalizedEvent, { type: 'assistant_delta' }>): void {
    this.options.onAssistantDelta?.(event.text, event.blockId);
  }

  private toolUse(event: Extract<NormalizedEvent, { type: 'tool_use' }>): void {
    this.options.onToolUse?.(event.name, event.input, event.toolUseId);
  }

  private toolResult(event: Extract<NormalizedEvent, { type: 'tool_result' }>): void {
    this.options.onToolResult?.(event.toolUseId, event.content, !event.ok);
  }

  private progress(numTurns: number, totalCostUsd: number | null): void {
    this.options.onProgress?.({ num_turns: numTurns, total_cost_usd: totalCostUsd, duration_ms: null });
  }

  private turnProgress(event: Extract<NormalizedEvent, { type: 'turn_progress' }>): void {
    this.progress(event.numTurns, null);
  }

  private async contextUsage(event: Extract<NormalizedEvent, { type: 'context_usage' }>): Promise<void> {
    await this.options.onContextUsage?.({
      usedTokens: event.usedTokens,
      contextWindow: event.contextWindow,
      percent: event.percent,
      accuracy: event.accuracy,
    });
  }

  private turnComplete(event: Extract<NormalizedEvent, { type: 'turn_complete' }>): void {
    this.progress(event.numTurns, event.totalCostUsd);
    this.active = false;
  }

  private costRecord(event: Extract<NormalizedEvent, { type: 'cost_record' }>): void {
    if (this.options.recordCost === false) return;
    void recordCost({
      project: this.options.project || 'general',
      trigger: this.options.trigger || 'unknown',
      cost_usd: event.cost_usd,
      backend: this.adapter.backend,
      mode: this.config.mode || 'api',
      source: 'estimate',
      input_tokens: event.tokens_in,
      output_tokens: event.tokens_out,
      provider: event.provider || undefined,
      model: event.model || undefined,
    }).catch(err => log.warn('recordCost failed:', (err as Error)?.message ?? err));
  }

  private contextCompacted(): void {
    if (!getSettings().notifyCompaction) return;
    this.options.onAssistantMessage?.(t('notify.contextCompacted'), undefined, 'info');
  }

  private planWritten(event: Extract<NormalizedEvent, { type: 'plan_written' }>): void {
    this.options.onPlanWritten?.({ path: event.path, content: event.content, toolUseId: event.toolUseId });
  }

  private askUserQuestion(event: Extract<NormalizedEvent, { type: 'ask_user_question' }>): void {
    this.options.onAskUserQuestion?.({ toolUseId: event.toolUseId, questions: event.questions });
  }
}
function shouldAwaitRunBackground(
  adapter: AgentAdapter,
  options: RunAgentOptions,
  result: AgentResult,
  proc: AgentProcess,
): boolean {
  const canRegisterSink = typeof proc.setContinuationSink === 'function';
  if (options.awaitBackground === false) return false;
  if (options.awaitBackground === true) {
    return canAwaitBgContinuation(adapter.backend, result, canRegisterSink);
  }
  return shouldAwaitBgInline(adapter.backend, options.threadId, result, canRegisterSink);
}

async function resolveRunResult(
  turnPromise: Promise<AgentResult>,
  adapter: AgentAdapter,
  options: RunAgentOptions,
  proc: AgentProcess,
  onContinuationEvent: (event: NormalizedEvent) => void,
): Promise<AgentResult> {
  const result = await turnPromise;
  if (!shouldAwaitRunBackground(adapter, options, result, proc)) return result;
  log.info(`agent turn ${options.threadId ?? proc.sessionId ?? 'direct'} has background work remaining — waiting inline`);
  return waitForBgContinuation({
    proc,
    baseResult: result,
    onAssistantText: options.onAssistantMessage ?? null,
    onToolUse: options.onToolUse ?? null,
    onToolResult: options.onToolResult ?? null,
    onContextUsage: options.onContextUsage ?? null,
    onEvent: onContinuationEvent,
  });
}

export function runWithAdapter(
  adapter: AgentAdapter,
  message: string,
  options: RunAgentOptions,
  config: AgentConfig,
  anthropicBaseUrl: string | undefined,
): AgentHandle {
  const spawnConfig = options.preparedSpawnConfig
    ?? buildAgentSpawnConfig(options, config, anthropicBaseUrl);
  const proc = adapter.spawn(spawnConfig);
  const attachments = (options.files || []).map((file: any) => ({
    mimeType: file.mimetype ?? file.mimeType,
    path: file.localPath ?? file.path,
  }));
  const turnPromise = proc.send({ text: message, attachments });
  const closeProcess = createProcessCloser(proc);
  const legacy = new LegacyEventDispatcher(adapter, options, config, spawnConfig);
  const tee = createRunEventTee(proc, options.observers ?? [], options.requiredSinks ?? []);
  const eventLoop = consumeEventStream({
    proc, tee, onEvent: (event) => legacy.dispatch(event),
  });
  const resultPromise = resolveRunResult(turnPromise, adapter, options, proc, (event) => {
    tee.dispatch(event);
  });

  return {
    promise: settleEventfulRun(resultPromise, eventLoop, () => tee.close(), closeProcess),
    kill: (): boolean => proc.kill(),
    get sessionId(): string | null { return proc.sessionId; },
    agentProcess: proc,
  };
}

export interface CompactAgentRequest {
  sessionId: string;
  backend: Backend;
  backendSessionId: string;
  channel: string;
  profileName: string | null;
  projectId: string;
  sessionName: string;
}

interface CompactCostEntry {
  project: string;
  trigger: string;
  cost_usd: number | null;
  backend: string;
  mode: string;
  source: string;
  input_tokens: number;
  output_tokens: number;
  provider?: string;
  model?: string;
}

export interface CompactAgentDeps {
  resolveProfile: (profileName: string | null) => ResolvedProfileConfig;
  getAdapter: (backend: Backend) => AgentAdapter;
  configureMode: (mode: string, metadata?: Record<string, string>) => string | undefined;
  recordCost: (entry: CompactCostEntry) => Promise<void>;
}

const compactAgentDeps: CompactAgentDeps = {
  resolveProfile: resolveProfileConfig,
  getAdapter,
  configureMode: configureEnvForMode,
  recordCost,
};

function supportsCompactProfile(backend: string, profile: ResolvedProfileConfig): boolean {
  if (profile.backend !== backend) return false;
  if (backend === 'pi') return true;
  return backend === 'claude' && profile.claudeBackend !== 'tui';
}

export function isSessionCompactionSupported(
  session: { backend: string; profileName: string | null },
  resolve: CompactAgentDeps['resolveProfile'] = resolveProfileConfig,
): boolean {
  try {
    return supportsCompactProfile(session.backend, resolve(session.profileName));
  } catch {
    return false;
  }
}

function compactAgentConfig(profile: ResolvedProfileConfig): AgentConfig {
  return {
    model: profile.model,
    backend: profile.backend,
    mode: profile.mode,
    provider: profile.provider,
    extraEnv: profile.extraEnv,
    extraOption: profile.extraOption,
    claudeBackend: profile.claudeBackend,
    thinking: profile.thinking,
  };
}

function compactCostEntry(
  request: CompactAgentRequest,
  profile: ResolvedProfileConfig,
  result: AgentCompactResult,
): CompactCostEntry | null {
  if (!result.usage) return null;
  return {
    project: request.projectId,
    trigger: 'manual-compact',
    cost_usd: result.usage.costUsd,
    backend: request.backend,
    mode: profile.mode || 'api',
    source: 'estimate',
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    ...(profile.provider ? { provider: profile.provider } : {}),
    ...(profile.model ? { model: profile.model } : {}),
  };
}

export async function compactAgentContext(
  request: CompactAgentRequest,
  deps: CompactAgentDeps = compactAgentDeps,
): Promise<AgentCompactResult> {
  const profile = deps.resolveProfile(request.profileName);
  if (!supportsCompactProfile(request.backend, profile)) {
    throw new Error(`${request.backend} profile does not support manual context compaction`);
  }
  const config = compactAgentConfig(profile);
  const baseUrl = deps.configureMode(profile.mode || 'api', {
    project: request.projectId,
    trigger: 'manual-compact',
  });
  const proc = deps.getAdapter(request.backend).spawn(buildAgentSpawnConfig({
    sessionId: request.backendSessionId,
    trackSessionId: request.sessionId,
    sessionKey: request.channel,
    channel: request.channel,
    profileName: request.profileName,
    project: request.projectId,
    trigger: 'manual-compact',
    sessionName: request.sessionName,
    isUserInitiated: true,
  }, config, baseUrl));
  try {
    if (!proc.compact) throw new Error(`${request.backend} process does not support manual context compaction`);
    const result = await proc.compact();
    const cost = compactCostEntry(request, profile, result);
    if (cost) await deps.recordCost(cost);
    return result;
  } finally {
    await proc.close().catch(() => {});
  }
}

export function runAgentOnce(message: string, options: RunAgentOptions, config: AgentConfig): AgentHandle {
  const effectiveMode = config.mode || 'api';
  const metadata: Record<string, string> = {};
  if (options.project) metadata.project = options.project;
  if (options.trigger) metadata.trigger = options.trigger;
  const anthropicBaseUrl = configureEnvForMode(
    effectiveMode,
    Object.keys(metadata).length > 0 ? metadata : undefined,
  );
  const adapter = getAdapter(config.backend as Backend);
  const handle = runWithAdapter(adapter, message, options, config, anthropicBaseUrl);
  return withRateLimitProvider(handle, resolveRateLimitProvider(config));
}

export function runAgent(message: string, options: RunAgentOptions = {}): AgentHandle {
  const profileConfig: ResolvedProfileConfig = resolveProfileConfig(options.profileName);
  const configs: AgentConfig[] = [
    { model: profileConfig.model, backend: profileConfig.backend, mode: profileConfig.mode, provider: profileConfig.provider, extraEnv: profileConfig.extraEnv, extraOption: profileConfig.extraOption, claudeBackend: profileConfig.claudeBackend, thinking: profileConfig.thinking },
    ...(profileConfig.fallback || []),
  ];
  const notices = new AttemptNoticeTracker(options);
  const trackedOptions = notices.options;

  // Single config — only terminal notice wrapping is needed.
  if (configs.length <= 1) {
    const effectiveMode = configs[0].mode || 'api';
    if (configIsRateLimited(configs[0]) && !options.isUserInitiated) {
      const result = rateLimitedResult(effectiveMode, resolveRateLimitProvider(configs[0]));
      notices.emitTerminalRateLimit(result);
      return {
        promise: Promise.resolve(result),
        kill: () => false,
        sessionId: null,
      };
    }
    return withTerminalNotices(runAgentOnce(message, trackedOptions, configs[0]), notices);
  }

  // Multiple configs — wrap with fallback chain
  let currentHandle: AgentHandle | null = null;
  let killed = false;

  const promise: Promise<AgentResult> = (async () => {
    for (let i = 0; i < configs.length; i++) {
      const config = configs[i];
      const isLast = i === configs.length - 1;

      const attemptOptions: RunAgentOptions = i === 0
        ? trackedOptions
        : { ...trackedOptions, sessionId: null };

      // Pre-flight: skip modes already known rate-limited without spawning CLI
      const effectiveMode = config.mode || 'api';
      if (configIsRateLimited(config) && !options.isUserInitiated) {
        if (isLast) {
          const result = rateLimitedResult(effectiveMode, resolveRateLimitProvider(config));
          notices.emitTerminalRateLimit(result);
          return result;
        }
        log.info(`${config.model}/${effectiveMode} rate-limited, skipping to fallback[${i}]`);
        await notices.transitionToFallback(config, configs[i + 1], null);
        continue;
      }

      currentHandle = runAgentOnce(message, attemptOptions, config);

      try {
        const result: AgentResult = await currentHandle.promise;
        if (!isRetryableResult(result) || isLast) {
          if (result.rateLimited) notices.emitTerminalRateLimit(result);
          return result;
        }
        const modeLabel = config.mode || 'api';
        log.info(`${config.model}/${modeLabel} rate limited, trying fallback[${i}]`);
        await notices.transitionToFallback(config, configs[i + 1], result);
      } catch (error) {
        if (killed) throw error;
        if (!isRetryableError(error as Error) || isLast) {
          notices.emitTerminalError(error);
          throw error;
        }
        const modeLabel = config.mode || 'api';
        log.info(`${config.model}/${modeLabel} retryable error, trying fallback[${i}]`);
        await notices.transitionToFallback(config, configs[i + 1], null, error as Error);
      }
    }
    const error = new Error('All fallback configs exhausted without result');
    notices.emitTerminalError(error);
    throw error;
  })();

  return {
    promise,
    kill(): boolean {
      killed = true;
      return currentHandle?.kill() ?? false;
    },
    get sessionId(): string | null { return currentHandle?.sessionId ?? null; },
    get agentProcess() { return currentHandle?.agentProcess; },
  };
}

/** Returns true when every mode in the profile's fallback chain is currently rate-limited.
 *  Enables job runners to skip claiming/running when all paths are blocked. */
export function allConfigsRateLimited(profileName: string | null): boolean {
  if (!isThrottled()) return false;
  try {
    const config = resolveProfileConfig(profileName);
    const configs: AgentConfig[] = [config, ...config.fallback];
    return configs.every((candidate) => configIsRateLimited(candidate));
  } catch {
    return false;
  }
}

// Exposed for tests/run-with-adapter.test.ts; not intended as a public API.
export const _test = {
  runWithAdapter,
  resolveRateLimitProvider,
  withRateLimitProvider,
  buildSpawnConfig: buildAgentSpawnConfig,
  filterChannelScopedPlugins,
};

// --- Claude bridge helper re-exports ---

export {
  closeSession,
  killSession,
  closeSessionsByPrefix,
  closeAllSessions,
  _test as claudeTest,
} from '../../agent-adapter/claude/adapter.js';
export { getCurrentPlanFilePath } from '../../agent-adapter/claude/event-parser.js';
