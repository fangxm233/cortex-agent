// input:  run config, adapters, profiles, task/cost events
// output: attributed runs with exact continuation accounting
// pos:    Backend-neutral agent run facade
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { getAdapter } from '../../agent-adapter/index.js';
import type {
  AgentAdapter, AgentCompactResult, AgentProcess, AgentSpawnConfig, Backend, NormalizedEvent,
} from '../../agent-adapter/index.js';
import {
  canAwaitBgContinuation, shouldAwaitBgInline, waitForBgContinuation,
} from '../../agent-adapter/bg-wait.js';
import {
  consumeEventStream, createProcessCloser, createRunEventTee, settleEventfulRun,
} from '../../agent-adapter/event-tee.js';
import { buildAgentSpawnConfig, filterChannelScopedPlugins } from './spawn-config.js';
import type { AgentConfig, RunAgentOptions, RunObserver } from './spawn-config.js';
import { resolveProfileConfig } from './profile-manager.js';
import type { ResolvedProfileConfig } from './profile-manager.js';
import type { AgentHandle, AgentResult, ChatNoticeLevel, NoticeAction } from '@core/types/agent-types.js';
import { recordCost } from '../costs/cost-tracker.js';
import { configureEnvForMode, isApiRateLimitError, isRetryableResult, isRetryableError } from './config.js';
import { isProviderRateLimited, isThrottled } from '../costs/rate-limit-throttle.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import {
  configIsRateLimited, rateLimitedResult, resolveRateLimitProvider,
  withAuthLifecycle, withRateLimitProvider,
} from './provider-run-lifecycle.js';
import { t } from '../../core/i18n.js';

export { resolveRateLimitProvider };

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
 *  failure must not be hidden by the previous provider's notice.
 *
 *  Rate-limit API errors are HELD rather than forwarded on arrival: the backend surfaces a 429 as
 *  an assistant message before the turn settles, and only the settle tells us whether it was a
 *  failure (card) or a pause the resume registry already owns (auto-resume warning instead). */
class AttemptNoticeTracker {
  readonly options: RunAgentOptions;
  private readonly forward: RunAgentOptions['onAssistantMessage'];
  private readonly generateNotices: boolean;
  private attemptHasErrorNotice = false;
  private heldError: { text: string; blockId?: string } | null = null;

  constructor(private readonly original: RunAgentOptions) {
    this.forward = original.onAssistantMessage ?? null;
    this.generateNotices = original.channel?.startsWith('web:') === true;
    this.options = this.forward
      ? { ...original, onAssistantMessage: (text, blockId, level, action) => this.observe(text, blockId, level, action) }
      : original;
  }

  private observe(text: string, blockId?: string, level?: ChatNoticeLevel, action?: NoticeAction): void {
    if (level === 'error' && this.generateNotices && isApiRateLimitError(text)) {
      this.heldError = { text, ...(blockId ? { blockId } : {}) };
      return;
    }
    if (level === 'error') this.attemptHasErrorNotice = true;
    this.forward?.(text, blockId, level, action);
  }

  /** Release a held rate-limit card. Every settle path calls this except the resumable one,
   *  which drops the card in favour of the auto-resume warning. */
  private flushHeldError(): void {
    const held = this.heldError;
    this.heldError = null;
    if (!held || !this.forward) return;
    this.attemptHasErrorNotice = true;
    this.forward(held.text, held.blockId, 'error');
  }

  /** The attempt produced a result: a turn that recovered from a mid-flight API error still
   *  reports it, just once the outcome is known. */
  settleSuccess(): void {
    this.flushHeldError();
  }

  private emitTerminal(message: string, displayText = terminalErrorText(message)): void {
    this.flushHeldError();
    if (!this.generateNotices || !this.forward || this.attemptHasErrorNotice) return;
    this.attemptHasErrorNotice = true;
    this.forward(displayText, undefined, 'error');
  }

  private emitAutoResume(provider: string | undefined): boolean {
    if (!this.original.isUserInitiated || !isProviderRateLimited(provider)) return false;
    // Paused, not failed — the held card would misreport the outcome.
    this.heldError = null;
    if (this.generateNotices && this.forward && !this.attemptHasErrorNotice) {
      this.attemptHasErrorNotice = true;
      this.forward(t('notify.rateLimitAutoResume'), undefined, 'warning', { kind: 'cancel-resume' });
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
    // This attempt is over: its held card is now terminal for that provider.
    this.flushHeldError();
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

function withTerminalNotices(handle: AgentHandle, notices: AttemptNoticeTracker): AgentHandle {
  let killed = false;
  return {
    promise: handle.promise.then(
      (result) => {
        if (result.rateLimited) notices.emitTerminalRateLimit(result);
        else notices.settleSuccess();
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

// The spawn-config builder and its option types live in spawn-config.ts so a construction path
// can reach them without importing the ambient adapter registry (design §13 S6.1). Re-exported
// here so every existing importer of the facade keeps working against the single definition.
export {
  buildAgentSpawnConfig, buildPiGatewaySubPath, CHANNEL_SCOPED_PLUGINS, filterChannelScopedPlugins,
} from './spawn-config.js';
export type { AgentConfig, RunAgentOptions, RunObserver } from './spawn-config.js';

// --- Adapter execution ---

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

  private progress(numTurns: number | null, totalCostUsd: number | null): void {
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
      input_tokens: event.tokens_in ?? 0,
      output_tokens: event.tokens_out ?? 0,
      provider: event.provider || undefined,
      model: event.model || undefined,
    }).catch(err => log.warn('recordCost failed:', (err as Error)?.message ?? err));
  }

  private contextCompacted(): void {
    if (!this.options.onAssistantMessage) return;
    if (!getSettings().notifyCompaction) return;
    this.options.onAssistantMessage(t('notify.contextCompacted'), undefined, 'info');
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
  foregroundEventsDrained: Promise<void>,
  adapter: AgentAdapter,
  options: RunAgentOptions,
  proc: AgentProcess,
  onContinuationEvent: (event: NormalizedEvent) => void,
): Promise<AgentResult> {
  const result = await turnPromise;
  if (!shouldAwaitRunBackground(adapter, options, result, proc)) return result;
  await foregroundEventsDrained;
  log.info(`agent turn ${options.threadId ?? proc.sessionId ?? 'direct'} has background work remaining — waiting inline`);
  const completionOnly = options.backgroundWaitPolicy === 'completion-only';
  return waitForBgContinuation({
    proc,
    baseResult: result,
    onAssistantText: options.onAssistantMessage ?? null,
    onToolUse: options.onToolUse ?? null,
    onToolResult: options.onToolResult ?? null,
    onContextUsage: options.onContextUsage ?? null,
    onEvent: onContinuationEvent,
    completionOnly,
    stopPromise: completionOnly ? proc.supervision?.closed : undefined,
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
  const resultPromise = resolveRunResult(turnPromise, eventLoop, adapter, options, proc, (event) => {
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
  const attributed = withRateLimitProvider(handle, resolveRateLimitProvider(config));
  return withAuthLifecycle(attributed, options, config);
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
          else notices.settleSuccess();
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
  AttemptNoticeTracker,
  withTerminalNotices,
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
