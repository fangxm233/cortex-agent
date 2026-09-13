// input:  run config, resolved profiles, task events
// output: identity-bound journalled runs, accounting, and notices
// pos:    Backend-neutral agent run facade
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { engines, getRunAdapter } from '../runs/engines.js';
import type {
  AgentAdapter, AgentCompactResult, Backend, EngineSpec, NormalizedEvent,
} from '../../agent-adapter/index.js';
import type { ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import type { AwaitBackground } from '../../agent-adapter/continuation-phase.js';
import type { RunEvent } from '../../agent-adapter/run-events.js';
import type { UserMessage } from '../../agent-adapter/types.js';
import type { EngineSession, EngineRun } from '../../agent-adapter/types.js';
import type { EventObserver } from '../../agent-adapter/normalize/event-types.js';
import { filterChannelScopedPlugins, filterScopedPlugins } from './spawn-config.js';
import { buildEngineSpec } from '../runs/engine-spec.js';
import type {
  AgentConfig, EngineAttemptHandle, RunAgentOptions, RunObserver,
} from './spawn-config.js';
import {
  freezeProductionAttemptIdentity, type ProductionAttemptIdentityRecord,
} from '../runs/observers/production-attempt-identity.js';
import { createProductionAttemptJournalSink } from '../runs/observers/production-attempt-journal.js';
import { resolveProfileConfig } from './profile-manager.js';
import type { ResolvedProfileConfig } from './profile-manager.js';
import type { AgentHandle, AgentResult, ChatNoticeLevel, NoticeAction } from '@core/types/agent-types.js';
import { recordCost, type CostAttribution } from '../costs/cost-tracker.js';
import {
  isApiRateLimitError, isRetryableResult, isRetryableError, resolveModeEnv,
} from './config.js';
import type { ModeEnv } from './config.js';
import { isProviderRateLimited, isThrottled } from '../costs/rate-limit-throttle.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import {
  configIsRateLimited, rateLimitedResult, resolveRateLimitProvider,
  withAuthLifecycle, withRateLimitProvider,
} from './provider-run-lifecycle.js';
import { t } from '../../core/i18n.js';
import {
  AttemptNoticeTracker, assistantNoticeLevel, type NoticeContext,
} from '../runs/notices.js';
import { planAttempts } from '../runs/fallback.js';

export { resolveRateLimitProvider };

const log = createLogger('facade');

function withTerminalNotices<T extends AgentHandle>(handle: T, notices: AttemptNoticeTracker): T {
  let killed = false;
  return {
    ...handle,
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
  } as T;
}

// --- Types ---

// The spawn-config builder and its option types live in spawn-config.ts so a construction path
// can reach them without importing the ambient adapter registry (design §13 S6.1). Re-exported
// here so every existing importer of the facade keeps working against the single definition.
export {
  buildPiGatewaySubPath, CHANNEL_SCOPED_PLUGINS, COMMISSION_SCOPED_PLUGINS,
  filterChannelScopedPlugins, filterScopedPlugins,
} from './spawn-config.js';
export type { AgentConfig, RunAgentOptions, RunObserver } from './spawn-config.js';

// --- Adapter execution ---

function costAttribution(
  options: RunAgentOptions,
  identity: ProductionAttemptIdentityRecord | null,
): Readonly<CostAttribution> {
  return Object.freeze({
    session_id: options.trackSessionId ?? options.sessionId ?? null,
    execution_id: identity?.execution_id ?? options.executionId ?? null,
    thread_id: identity?.thread_id ?? options.threadId ?? null,
    parent_thread_id: identity?.parent_thread_id ?? options.parentThreadId ?? null,
    root_thread_id: identity?.root_thread_id ?? options.rootThreadId ?? null,
    task_id: identity?.task_id ?? options.taskId ?? null,
    task_project: identity?.task_project ?? options.taskProject ?? null,
    dispatch_generation: identity?.dispatch_generation ?? options.taskGeneration ?? null,
    attempt_id: identity?.attempt_id ?? null,
    root_attempt_id: identity?.root_attempt_id ?? null,
    trial_id: identity?.trial_id ?? null,
    root_run_id: identity?.root_run_id ?? null,
  });
}

/**
 * The facade-authored signals a run still needs from its stream. These exist nowhere else: the
 * assistant-prose classification (`assistantNoticeLevel`) plus the synthesized notices
 * (backend-session reset, compaction, model fallback) and cost accounting.
 *
 * Run events, not raw normalized ones: the stream the engine emits is the only one a run has, and
 * the fields this needs survive the translation unchanged. The benchmark journal, which really does
 * need the wire-level record, is fed from the engine's `onNormalizedEvent` tap instead.
 */
function createFacadeDispatcher(
  adapter: AgentAdapter,
  options: RunAgentOptions,
  config: AgentConfig,
  spec: EngineSpec,
  attribution: Readonly<CostAttribution>,
): (event: RunEvent) => void {
  // The foreground turn is over: the adapter may keep emitting (background turns), but the facade
  // must not re-announce them.
  let active = true;
  return (event: RunEvent): void => {
    if (!active) return;
    switch (event.type) {
      case 'foreground_result':
        active = false;
        return;
      case 'cost_record':
        recordRunAccounting(event, adapter, options, config, attribution);
        return;
      case 'engine_started':
        if (!options.channel?.startsWith('web:')) return;
        if (!spec.resume.resume || !spec.resume.backendSessionId) return;
        if (event.backendSessionId === spec.resume.backendSessionId) return;
        options.onAssistantMessage?.(t('notify.backendSessionReset'), undefined, 'warning');
        return;
      case 'assistant_text':
        options.onAssistantMessage?.(
          event.text, event.blockId, assistantNoticeLevel(event.text), undefined, event.subagent,
        );
        return;
      case 'context_compacted':
        if (!options.onAssistantMessage) return;
        if (!getSettings().notifyCompaction) return;
        options.onAssistantMessage(t('notify.contextCompacted'), undefined, 'info');
        return;
      case 'model_fallback':
        options.onAssistantMessage?.(t('notify.agentFallback', {
          from: event.originalModel,
          to: event.fallbackModel,
        }), undefined, 'warning');
        return;
      default:
        return;
    }
  };
}

/** Record one backend cost event. The foreground loop gates on the turn being active; the
 *  continuation path records unconditionally (its events carry `phase: 'background'`). */
function recordRunAccounting(
  event: Extract<RunEvent, { type: 'cost_record' }>,
  adapter: AgentAdapter,
  options: RunAgentOptions,
  config: AgentConfig,
  attribution: Readonly<CostAttribution>,
): void {
  if (options.recordCost === false) return;
  void recordCost({
    ...attribution,
    project: options.project || 'general', trigger: options.trigger || 'unknown',
    cost_usd: event.cost_usd, backend: adapter.backend,
    mode: config.mode || 'api', source: 'estimate',
    input_tokens: event.input_tokens, output_tokens: event.output_tokens,
    prompt_tokens: event.prompt_tokens === undefined
      ? event.tokens_in : event.prompt_tokens,
    cache_read_tokens: event.cache_read_tokens,
    cache_creation_tokens: event.cache_creation_tokens,
    provider_requests: event.provider_requests,
    provider: event.provider || undefined, model: event.model || undefined,
  }).catch(err => log.warn('recordCost failed:', (err as Error)?.message ?? err));
}

type AttemptJournalSink = ReturnType<typeof createProductionAttemptJournalSink>;

function productionJournalSink(
  identity: ProductionAttemptIdentityRecord | null,
  spec: EngineSpec,
  options: RunAgentOptions,
  message: string,
): AttemptJournalSink | null {
  if (!identity) return null;
  return createProductionAttemptJournalSink({
    identity, spec,
    canonicalInstruction: options.identityDirective ?? '', message,
  });
}

function prepareAttemptEvidence(
  adapter: AgentAdapter, message: string, options: RunAgentOptions,
  config: AgentConfig, route: ModeEnv | undefined,
) {
  const spec = options.preparedSpec
    ?? buildEngineSpec(options, config, route);
  const attemptIdentity = freezeProductionAttemptIdentity({
    adapterBackend: adapter.backend, spec, options,
    resolvedProfile: options.resolvedProfileConfig,
  });
  return {
    spec, attemptIdentity,
    attemptJournal: productionJournalSink(attemptIdentity, spec, options, message),
  };
}

/** How long the engine should keep a run open for its background work. */
function awaitBackgroundFor(options: RunAgentOptions): AwaitBackground {
  if (options.awaitBackground !== true) return 'hold';
  return options.backgroundWaitPolicy === 'completion-only' ? 'completion-only' : 'inline';
}

function attachmentsOf(options: RunAgentOptions): UserMessage['attachments'] {
  return (options.files || []).map((file: any) => ({
    mimeType: file.mimetype ?? file.mimeType, path: file.localPath ?? file.path,
  }));
}

/**
 * The wire-level tap for this attempt: the production attempt journal plus any caller-supplied
 * required sinks. They observe `NormalizedEvent`s, which only exist where the backend produces
 * them, so the engine forwards them here rather than the run trying to reconstruct them.
 */
function normalizedTaps(
  options: RunAgentOptions, journal: AttemptJournalSink | null,
): ((event: NormalizedEvent) => void) | undefined {
  const sinks: EventObserver[] = [...(journal ? [journal] : []), ...(options.requiredSinks ?? [])];
  if (sinks.length === 0) return undefined;
  return (event: NormalizedEvent): void => {
    for (const sink of sinks) {
      try { void sink.onEvent(event); }
      catch (error) { log.warn('required sink failed:', (error as Error)?.message ?? error); }
    }
  };
}

/**
 * One attempt through its engine session: acquire the pooled session for the spec, open a run on
 * it, and fan the run's events out. The engine owns everything downstream of that — the background
 * phase, the watchdog, when the run ends — so this function is only wiring: proof of identity for
 * the benchmark journal, cost attribution, and the observers a surface registered.
 */
export function runWithAdapter(
  adapter: AgentAdapter, message: string, options: RunAgentOptions,
  config: AgentConfig, route: ModeEnv | undefined,
): EngineAttemptHandle {
  const { spec, attemptIdentity, attemptJournal } = prepareAttemptEvidence(
    adapter, message, options, config, route,
  );
  const attribution = costAttribution(options, attemptIdentity);
  const taps = normalizedTaps(options, attemptJournal);
  const engine = engines.acquire(spec);
  const engineRun = engine.run(
    { text: message, attachments: attachmentsOf(options) },
    { awaitBackground: awaitBackgroundFor(options), ...(taps ? { onNormalizedEvent: taps } : {}) },
  );
  const dispatch = createFacadeDispatcher(adapter, options, config, spec, attribution);
  const observers = options.observers ?? [];
  const eventLoop = (async (): Promise<void> => {
    try {
      for await (const event of engineRun.events) {
        dispatch(event);
        for (const observer of observers) {
          try { void observer.onEvent(event); }
          catch (error) { log.warn('run observer failed:', (error as Error)?.message ?? error); }
        }
      }
    } finally {
      await closeObservers(observers);
    }
  })();
  return {
    promise: settleEventfulRun(engineRun, eventLoop, 'result'),
    settled: settleEventfulRun(engineRun, eventLoop, 'settled'),
    kill: () => engine.kill(),
    get sessionId(): string | null { return engine.backendSessionId; },
    engine,
    engineRun,
  };
}

/** Close every observer exactly once, after the run's stream has ended. A failing observer is
 *  logged, never allowed to turn a finished run into a failed one. */
async function closeObservers(observers: RunObserver[]): Promise<void> {
  for (const observer of observers) {
    try { await observer.onClose?.(); }
    catch (error) { log.warn('run observer close failed:', (error as Error)?.message ?? error); }
  }
}

/**
 * Await the run and its event stream together: a rejection from either must still let the stream
 * drain (a surface may be mid-render), and a failing observer must not swallow the real error.
 */
async function settleEventfulRun(
  engineRun: EngineRun, eventLoop: Promise<void>, which: 'result' | 'settled',
): Promise<AgentResult> {
  let result: AgentResult | null = null;
  let failure: unknown;
  try {
    [result] = await Promise.all([engineRun[which], eventLoop]);
  } catch (error) {
    failure = error;
    try { await eventLoop; } catch (eventError) { failure = eventError; }
  }
  if (failure !== undefined) throw failure;
  return result as AgentResult;
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
  /** The pooled session for the spec. Compaction runs on it and leaves it pooled — it is the same
   *  session the channel's next turn will resume into, not a throwaway process. */
  acquireEngine: (spec: EngineSpec) => EngineSession;
  configureMode: (mode: string, metadata?: Record<string, string>) => ModeEnv;
  recordCost: (entry: CompactCostEntry) => Promise<void>;
}

const compactAgentDeps: CompactAgentDeps = {
  resolveProfile: resolveProfileConfig,
  acquireEngine: (spec) => engines.acquire(spec),
  configureMode: resolveModeEnv,
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
  const route = deps.configureMode(profile.mode || 'api', {
    project: request.projectId,
    trigger: 'manual-compact',
  });
  const engine = deps.acquireEngine(buildEngineSpec({
    sessionId: request.backendSessionId,
    trackSessionId: request.sessionId,
    sessionKey: request.channel,
    channel: request.channel,
    profileName: request.profileName,
    project: request.projectId,
    trigger: 'manual-compact',
    sessionName: request.sessionName,
    isUserInitiated: true,
  }, config, route));
  const result = await engine.compact();
  const cost = compactCostEntry(request, profile, result);
  if (cost) await deps.recordCost(cost);
  return result;
}

/** Resolves the Anthropic route one connection must use. The returned value is the only thing
 *  that carries the mode: it reaches this spawn's child environment and nothing else, so two
 *  connections on different modes can no longer overwrite each other's routing (K-053). */
function configureRunRoute(options: RunAgentOptions, config: AgentConfig): ModeEnv {
  const metadata: Record<string, string> = {};
  if (options.project) metadata.project = options.project;
  if (options.trigger) metadata.trigger = options.trigger;
  return resolveModeEnv(
    config.mode || 'api', Object.keys(metadata).length > 0 ? metadata : undefined,
  );
}

export function runAgentOnce(message: string, options: RunAgentOptions, config: AgentConfig): EngineAttemptHandle {
  const route = configureRunRoute(options, config);
  const adapter = getRunAdapter(config.backend as Backend);
  const handle = runWithAdapter(adapter, message, options, config, route);
  const attributed = withRateLimitProvider(handle, resolveRateLimitProvider(config));
  return withAuthLifecycle(attributed, options, config);
}

export function runAgent(message: string, options: RunAgentOptions = {}): EngineAttemptHandle {
  // A `resolvedProfileConfig` carrying a real model is authoritative: the run layer passes the
  // fully-resolved request profile, and a subagent child passes a synthesized profile for its
  // role/task model. A synthetic "unknown name" profile (empty model) still falls through to the
  // named lookup so the facade rejects the unknown name exactly as before.
  const resolved = options.resolvedProfileConfig;
  const profileConfig: ResolvedProfileConfig = resolved && resolved.model
    ? resolved
    : resolveProfileConfig(options.profileName);
  const configs: AgentConfig[] = planAttempts(profileConfig);
  const noticeContext: NoticeContext = {
    channel: options.channel, isUserInitiated: options.isUserInitiated, trigger: options.trigger,
  };
  const notices = new AttemptNoticeTracker(noticeContext, options.onAssistantMessage ?? null);
  // Every assistant line is routed through the tracker so a rate-limit card can be held until the
  // outcome is known; a run with no prose surface keeps its (absent) callback untouched.
  const trackedOptions: RunAgentOptions = {
    ...options,
    resolvedProfileConfig: profileConfig,
    ...(options.onAssistantMessage
      ? {
        onAssistantMessage: (text, blockId, level, action, subagent) =>
          notices.observe(text, blockId, level, action, subagent),
      }
      : {}),
  };

  // Single config — only terminal notice wrapping is needed.
  if (configs.length <= 1) {
    const effectiveMode = configs[0].mode || 'api';
    if (configIsRateLimited(configs[0]) && !options.isUserInitiated) {
      const result = rateLimitedResult(effectiveMode, resolveRateLimitProvider(configs[0]));
      notices.emitTerminalRateLimit(result);
      return {
        promise: Promise.resolve(result),
        settled: Promise.resolve(result),
        kill: () => false,
        sessionId: null,
      };
    }
    return withTerminalNotices(runAgentOnce(message, trackedOptions, configs[0]), notices);
  }

  // Multiple configs — wrap with fallback chain
  let currentHandle: EngineAttemptHandle | null = null;
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
        await options.onFallback?.(config, configs[i + 1], null);
        notices.transitionToFallback(config, configs[i + 1]);
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
        await options.onFallback?.(config, configs[i + 1], result);
        notices.transitionToFallback(config, configs[i + 1]);
      } catch (error) {
        if (killed) throw error;
        if (!isRetryableError(error as Error) || isLast) {
          notices.emitTerminalError(error);
          throw error;
        }
        const modeLabel = config.mode || 'api';
        log.info(`${config.model}/${modeLabel} retryable error, trying fallback[${i}]`);
        await options.onFallback?.(config, configs[i + 1], null, error as Error);
        notices.transitionToFallback(config, configs[i + 1]);
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
    get engine() { return currentHandle?.engine; },
    get engineRun() { return currentHandle?.engineRun; },
    settled: promise,
  };
}

// Exposed for tests/run-with-adapter.test.ts; not intended as a public API.
export const _test = {
  runWithAdapter,
  configureRunRoute,
  withTerminalNotices,
  resolveRateLimitProvider,
  withRateLimitProvider,
  filterChannelScopedPlugins,
  filterScopedPlugins,
};
