// input:  config, agent-adapter, profile-manager, agent-types
// output: runAgent / runAgentOnce / runWithAdapter + fallback chain + bridge helper re-exports
// pos:    domain/agents — sole agent execution path [S11]

import { getAdapter } from '../../agent-adapter/index.js';
import type { AgentAdapter, AgentSpawnConfig, Backend } from '../../agent-adapter/index.js';
import { shouldAwaitBgInline, waitForBgContinuation } from '../../agent-adapter/bg-wait.js';
import { resolveProfileConfig } from './profile-manager.js';
import type { ResolvedProfileConfig } from './profile-manager.js';
import type { AgentHandle, AgentResult } from '@core/types/agent-types.js';
import { recordCost } from '../costs/cost-tracker.js';
import { configureEnvForMode, isRetryableResult, isRetryableError } from './config.js';
import { isModeRateLimited, isThrottled } from '../costs/rate-limit-throttle.js';
import { GATEWAY_URL } from '../costs/gateway-manager.js';
import { createLogger } from '@core/log.js';
import { loadCortexRules } from '../memory/rules-loader.js';
import { t } from '../../core/i18n.js';

const log = createLogger('facade');

// --- Types ---

export interface AgentConfig {
  model: string;
  backend: string;
  mode: string | null;
  /** PI `--provider` (protocol). null → defaults to "anthropic". Only used for backend='pi'. */
  provider?: string | null;
  extraEnv?: Record<string, string>;
  extraOption?: Record<string, string>;
  /** DR-0012: Claude adapter mode (print/tui). Only meaningful for backend='claude'. */
  claudeBackend?: 'print' | 'tui';
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
  /** When true, load only core MCP server (remote_* tools). Used by template thread sessions.
   *  Default (undefined/false) loads full MCP config with cortex-ext tools. */
  useCoreMcp?: boolean;
  /** Recursion depth of the owning thread, surfaced to the spawned agent as CORTEX_THREAD_DEPTH
   *  so the thread_start MCP tool can forward it for the depth guard. */
  threadDepth?: number | null;
  /** Owning dispatch task id/project, surfaced as CORTEX_TASK_ID / CORTEX_TASK_PROJECT so
   *  `cortex-task spawn` can infer the current task as the parent of a child task. */
  taskId?: string | null;
  taskProject?: string | null;
  onProgress?: ((progress: any) => void) | null;
  onAssistantMessage?: ((msg: string) => void) | null;
  onToolUse?: ((name: string, input: any) => void) | null;
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

function buildSpawnConfig(
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
  const rules = loadCortexRules();
  const appendSystemPrompt = rules.global.length > 0
    ? rules.global.map(r => r.body).join('\n\n---\n\n')
    : undefined;

  return {
    sessionId: options.sessionId ?? null,
    sessionKey: options.sessionKey || options.channel || 'default',
    resume: !!options.sessionId,
    model: config.model,
    systemPrompt: typeof options.systemPrompt === 'string' ? options.systemPrompt : undefined,
    outputStyle: typeof options.outputStyle === 'string' ? options.outputStyle : undefined,
    pluginDirs: filterChannelScopedPlugins(
      Array.isArray(options.pluginDirs) ? options.pluginDirs : undefined,
      options.channel,
    ),
    env: config.extraEnv && Object.keys(config.extraEnv).length > 0 ? config.extraEnv : undefined,
    extraOption: config.extraOption && Object.keys(config.extraOption).length > 0 ? config.extraOption : undefined,
    claudeBackend: config.claudeBackend,
    channel: options.channel,
    claudeAgent: options.claudeAgent ?? undefined,
    callbackSource: options.callbackSource ?? undefined,
    scheduleTaskId: options.scheduleTaskId ?? undefined,
    isUserInitiated: !!options.isUserInitiated,
    rawTools: typeof options.tools === 'string' ? options.tools : undefined,
    anthropicBaseUrl,
    // PI-specific routing: provider name (= profile mode) + gateway base URL. PI adapter writes
    // a multi-provider models.json (writeProvidersConfig) so every PI provider lands on the
    // gateway. Claude / codex adapters ignore these fields.
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

export function runWithAdapter(
  adapter: AgentAdapter,
  message: string,
  options: RunAgentOptions,
  config: AgentConfig,
  anthropicBaseUrl: string | undefined,
): AgentHandle {
  const spawnConfig = buildSpawnConfig(options, config, anthropicBaseUrl);
  const proc = adapter.spawn(spawnConfig);

  const attachments = (options.files || []).map((f: any) => ({
    mimeType: f.mimetype ?? f.mimeType,
    path: f.localPath ?? f.path,
  }));
  const turnPromise = proc.send({ text: message, attachments });

  // Drive legacy callbacks from the normalized event stream
  const eventLoop = (async (): Promise<void> => {
    try {
      for await (const event of proc.events) {
        switch (event.type) {
          case 'assistant_text':
            options.onAssistantMessage?.(event.text);
            break;
          case 'tool_use':
            options.onToolUse?.(event.name, event.input);
            break;
          case 'turn_progress':
            options.onProgress?.({
              num_turns: event.numTurns,
              total_cost_usd: null,
              duration_ms: null,
            });
            break;
          case 'turn_complete':
            options.onProgress?.({
              num_turns: event.numTurns,
              total_cost_usd: event.totalCostUsd,
              duration_ms: null,
            });
            return;
          case 'cost_record':
            // All three backends emit cost_record via their event parser/adapter.
            // This is the single recording point for all LLM costs.
            recordCost({
              project: options.project || 'general',
              trigger: options.trigger || 'unknown',
              cost_usd: event.cost_usd,
              backend: adapter.backend,
              mode: config.mode || 'api',
              source: 'estimate',
              input_tokens: event.tokens_in,
              output_tokens: event.tokens_out,
              provider: event.provider || undefined,
              model: event.model || undefined,
            }).catch(err => log.warn('recordCost failed:', (err as Error)?.message ?? err));
            break;
          case 'context_compacted':
            // Notify the user that the context was compacted. Off by default; opt in via
            // CORTEX_NOTIFY_COMPACTION=1. Reuses onAssistantMessage so the notice reaches the
            // user through the same channel as normal assistant output.
            if (process.env.CORTEX_NOTIFY_COMPACTION === '1') {
              const tokens = event.preTokens
                ? t('notify.contextCompactedTokens', { preTokens: event.preTokens })
                : '';
              options.onAssistantMessage?.(`🗜️ ${t('notify.contextCompacted', { trigger: event.trigger, tokens })}`);
            }
            break;
          case 'plan_written':
            options.onPlanWritten?.({ path: event.path, content: event.content, toolUseId: event.toolUseId });
            break;
          case 'ask_user_question':
            options.onAskUserQuestion?.({ toolUseId: event.toolUseId, questions: event.questions });
            break;
          default:
            break;
        }
      }
    } catch (e: any) {
      log.warn('runWithAdapter event loop error:', e?.message ?? e);
    }
  })();

  const promise: Promise<AgentResult> = (async () => {
    try {
      const [result] = await Promise.all([turnPromise, eventLoop]);
      // Thread/dispatch turns (threadId set) wait INLINE for background-task continuations:
      // a thread step's deliverable is its result, so the step must not complete while a
      // run_in_background task is still running — the continuation output belongs to it.
      // (Interactive turns return immediately; orchestration/lifecycle holds their status
      // asynchronously.) Registration is race-free here: the sink lands within the same
      // microtask drain as the result line, before the CLI's next stdout line is processed.
      if (shouldAwaitBgInline(adapter.backend, options.threadId, result, typeof proc.setContinuationSink === 'function')) {
        log.info(`thread turn ${options.threadId} has background work remaining — waiting inline for the continuation`);
        return await waitForBgContinuation({
          proc,
          baseResult: result,
          onAssistantText: options.onAssistantMessage ?? null,
          onToolUse: options.onToolUse ?? null,
        });
      }
      return result;
    } catch (err) {
      await eventLoop.catch(() => {});
      throw err;
    } finally {
      await proc.close().catch(() => {});
    }
  })();

  return {
    promise,
    kill: (): boolean => proc.kill(),
    get sessionId(): string | null { return proc.sessionId; },
    agentProcess: proc,
  };
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
  return runWithAdapter(adapter, message, options, config, anthropicBaseUrl);
}

export function runAgent(message: string, options: RunAgentOptions = {}): AgentHandle {
  const profileConfig: ResolvedProfileConfig = resolveProfileConfig(options.profileName);
  const configs: AgentConfig[] = [
    { model: profileConfig.model, backend: profileConfig.backend, mode: profileConfig.mode, provider: profileConfig.provider, extraEnv: profileConfig.extraEnv, extraOption: profileConfig.extraOption, claudeBackend: profileConfig.claudeBackend },
    ...(profileConfig.fallback || []),
  ];

  // Single config — no fallback wrapper needed
  if (configs.length <= 1) {
    const effectiveMode = configs[0].mode || 'api';
    if (isModeRateLimited(effectiveMode) && !options.isUserInitiated) {
      return {
        promise: Promise.resolve({
          sessionId: null,
          total_cost_usd: null,
          num_turns: null,
          rateLimited: true,
          rateLimitMessage: `Mode ${effectiveMode} is rate-limited`,
          planFilePath: null,
          enteredPlanMode: false,
          exitedPlanMode: false,
          finalOutput: null,
        }),
        kill: () => false,
        sessionId: null,
      };
    }
    return runAgentOnce(message, options, configs[0]);
  }

  // Multiple configs — wrap with fallback chain
  let currentHandle: AgentHandle | null = null;
  let killed = false;

  const promise: Promise<AgentResult> = (async () => {
    for (let i = 0; i < configs.length; i++) {
      const config = configs[i];
      const isLast = i === configs.length - 1;

      const attemptOptions: RunAgentOptions = i === 0 ? options : { ...options, sessionId: null };

      // Pre-flight: skip modes already known rate-limited without spawning CLI
      const effectiveMode = config.mode || 'api';
      if (isModeRateLimited(effectiveMode) && !options.isUserInitiated) {
        if (isLast) {
          return {
            sessionId: null,
            total_cost_usd: null,
            num_turns: null,
            rateLimited: true,
            rateLimitMessage: `Mode ${effectiveMode} is rate-limited`,
            planFilePath: null,
            enteredPlanMode: false,
            exitedPlanMode: false,
            finalOutput: null,
          };
        }
        log.info(`${config.model}/${effectiveMode} rate-limited, skipping to fallback[${i}]`);
        if (options.onFallback) await options.onFallback(config, configs[i + 1], null);
        continue;
      }

      currentHandle = runAgentOnce(message, attemptOptions, config);

      try {
        const result: AgentResult = await currentHandle.promise;
        if (!isRetryableResult(result) || isLast) {
          return result;
        }
        const modeLabel = config.mode || 'api';
        log.info(`${config.model}/${modeLabel} rate limited, trying fallback[${i}]`);
        if (options.onFallback) {
          await options.onFallback(config, configs[i + 1], result);
        }
      } catch (error) {
        if (killed) throw error;
        if (!isRetryableError(error as Error) || isLast) throw error;
        const modeLabel = config.mode || 'api';
        log.info(`${config.model}/${modeLabel} retryable error, trying fallback[${i}]`);
        if (options.onFallback) {
          await options.onFallback(config, configs[i + 1], null, error as Error);
        }
      }
    }
    throw new Error('All fallback configs exhausted without result');
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
    const primaryMode = config.mode || 'api';
    const allModes = [primaryMode, ...config.fallback.map(f => f.mode || primaryMode)];
    return allModes.every(m => isModeRateLimited(m));
  } catch {
    return false;
  }
}

// Exposed for tests/run-with-adapter.test.ts; not intended as a public API.
export const _test = {
  runWithAdapter,
  buildSpawnConfig,
  filterChannelScopedPlugins,
};

// --- Bridge helper re-exports (replacing claude-bridge.ts / codex-bridge.ts) ---

export {
  closeSession,
  closeSessionsByPrefix,
  closeAllSessions,
  _test as claudeTest,
} from '../../agent-adapter/claude/adapter.js';
export { shutdownCodex, buildMcpBlock } from '../../agent-adapter/codex/adapter.js';
export { getCurrentPlanFilePath } from '../../agent-adapter/claude/event-parser.js';
