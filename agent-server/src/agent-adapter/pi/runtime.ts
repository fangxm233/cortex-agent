// input:  PiSessionRequest, the PI SDK, Cortex extension factories
// output: One in-process PI AgentSession runtime per Cortex session, its events and UI answers
// pos:    Creates and owns the PI SDK session behind a PISession
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'node:path';
import type {
  AgentSession,
  CreateAgentSessionRuntimeFactory,
  InlineExtension,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { createLogger } from '@core/log.js';
import { loadPiSdk, type PiSdkModule } from '@core/pi-sdk.js';
import type { CodexQuotaReading } from '@domain/costs/codex-quota.js';
import type { PiSessionRequest } from './session-options.js';
import { createPiUiContext } from './ui-context.js';
import { createCortexExtensions } from './extensions.js';

const log = createLogger('pi-runtime');

/** One record off the PI session's event stream (or a UI request the host raised on its behalf). */
export type PiRawEvent = Record<string, unknown> & { type: string };

/** The slice of PI's AgentSession a PISession drives. Narrow so tests can fake it. */
export type PiAgentSessionLike = Pick<
  AgentSession, 'sessionId' | 'sessionFile' | 'isStreaming' | 'prompt' | 'steer' | 'abort' | 'compact' | 'getSessionStats'
>;

export interface PiRuntimeHandle {
  readonly session: PiAgentSessionLike;
  /** Answer a blocking extension dialog by request id. False when nothing waits on that id. */
  respondToUi(id: string, payload: Record<string, unknown>): boolean;
  /** Re-point the live runtime at another transcript. */
  switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
  /** Run shutdown handlers and release the session. Idempotent. */
  dispose(): Promise<void>;
}

export interface PiRuntimeCallbacks {
  onEvent(event: PiRawEvent): void;
  /** Provider quota read off response headers; set only for gateway-routed runs. */
  onProviderQuota?(reading: CodexQuotaReading): void;
}

/** Builds the runtime for one session. The adapter's injection seam: tests substitute a fake. */
export type PiRuntimeFactory = (
  request: PiSessionRequest,
  callbacks: PiRuntimeCallbacks,
) => Promise<PiRuntimeHandle>;

/** PI's thinking level union, taken from its own model resolver (the type is not re-exported). */
type ThinkingLevel = NonNullable<ReturnType<PiSdkModule['resolveCliModel']>['thinkingLevel']>;

const THINKING_LEVELS: ReadonlySet<string> = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** PI publishes its theme through a process-global that `initTheme` fills; there is no exported
 *  getter, so this mirrors the lookup the SDK's own UI contexts perform. */
const THEME_KEY = Symbol.for('@earendil-works/pi-coding-agent:theme');

function ensureTheme(sdk: PiSdkModule): Theme {
  const globals = globalThis as Record<symbol, unknown>;
  if (!globals[THEME_KEY]) sdk.initTheme('dark', false);
  return globals[THEME_KEY] as Theme;
}

function thinkingLevel(request: PiSessionRequest): ThinkingLevel | undefined {
  if (!request.thinking) return undefined;
  if (THINKING_LEVELS.has(request.thinking)) return request.thinking as ThinkingLevel;
  log.warn(`Ignoring unknown PI thinking level '${request.thinking}' for session ${request.sessionKey}`);
  return undefined;
}

function openSessionManager(sdk: PiSdkModule, request: PiSessionRequest) {
  if (request.sessionPath) return sdk.SessionManager.open(request.sessionPath, request.sessionDir);
  return sdk.SessionManager.create(request.cwd, request.sessionDir);
}

/**
 * Model selection follows PI's own CLI resolver so `provider/model[:thinking]` patterns, fuzzy
 * matches and the "no model" fallback behave exactly as `pi --provider X --model Y` did. A
 * resolver error is fatal: a session with no usable model cannot serve a turn.
 */
function resolveModel(
  sdk: PiSdkModule,
  request: PiSessionRequest,
  modelRuntime: Parameters<PiSdkModule['resolveCliModel']>[0]['modelRuntime'],
): { model: ReturnType<PiSdkModule['resolveCliModel']>['model']; thinking: ThinkingLevel | undefined } {
  const thinking = thinkingLevel(request);
  if (!request.model) return { model: undefined, thinking };
  const resolved = sdk.resolveCliModel({
    cliProvider: request.provider ?? undefined,
    cliModel: request.model,
    cliThinking: thinking,
    modelRuntime,
  });
  if (resolved.error) throw new Error(resolved.error);
  if (resolved.warning) log.warn(`PI model resolution for ${request.sessionKey}: ${resolved.warning}`);
  return { model: resolved.model, thinking: thinking ?? resolved.thinkingLevel };
}

function projectTrusted(sdk: PiSdkModule, cwd: string, agentDir: string): boolean {
  // Same default PI applies to its own non-interactive modes: a project without trust-requiring
  // resources is trusted outright; one with them needs a recorded decision.
  if (!sdk.hasTrustRequiringProjectResources(cwd)) return true;
  return new sdk.ProjectTrustStore(agentDir).get(cwd) === true;
}

function runtimeFactory(
  sdk: PiSdkModule,
  request: PiSessionRequest,
  extensions: InlineExtension[],
): CreateAgentSessionRuntimeFactory {
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const settingsManager = sdk.SettingsManager.create(cwd, agentDir, {
      projectTrusted: projectTrusted(sdk, cwd, agentDir),
    });
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      allowModelNetwork: false,
    });
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        additionalSkillPaths: request.skillPaths,
        extensionFactories: extensions,
        systemPrompt: request.systemPrompt ?? undefined,
        appendSystemPrompt: request.appendSystemPrompt,
      },
    });
    const diagnostics = [
      ...services.diagnostics,
      ...services.resourceLoader.getExtensions().errors.map(({ path: extensionPath, error }) => ({
        type: 'error' as const,
        message: `Failed to load extension "${extensionPath}": ${error}`,
      })),
    ];
    const { model, thinking } = resolveModel(sdk, request, services.modelRuntime);
    const created = await sdk.createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent, model, thinkingLevel: thinking,
    });
    return { ...created, services, diagnostics };
  };
}

/**
 * Create the PI session for one Cortex session, in this process.
 *
 * A session runtime over the transcript, Cortex's extensions loaded as inline factories,
 * extensions bound to a UI context that turns dialogs into `extension_ui_request` records, and
 * every session event forwarded to the caller. Re-binding after a transcript switch is owned
 * here too.
 */
export async function createPiRuntime(
  request: PiSessionRequest,
  callbacks: PiRuntimeCallbacks,
): Promise<PiRuntimeHandle> {
  const sdk = await loadPiSdk();
  const ui = createPiUiContext((record) => callbacks.onEvent(record), ensureTheme(sdk));
  const extensions = createCortexExtensions(request, {
    onProviderQuota: callbacks.onProviderQuota,
    // A subagent's events reach the parent's stream as one raw record per event, no codec in between.
    onSubagentEvent: (notice) => callbacks.onEvent({ type: 'cortex_subagent_event', notice }),
  });
  const sessionManager = openSessionManager(sdk, request);
  const runtime = await sdk.createAgentSessionRuntime(runtimeFactory(sdk, request, extensions), {
    cwd: sessionManager.getCwd(),
    agentDir: request.agentDir,
    sessionManager,
  });
  for (const diagnostic of runtime.diagnostics) {
    const line = `PI session ${request.sessionKey}: ${diagnostic.message}`;
    if (diagnostic.type === 'error') log.error(line);
    else if (diagnostic.type === 'warning') log.warn(line);
    else log.info(line);
  }
  if (runtime.modelFallbackMessage) log.warn(`PI session ${request.sessionKey}: ${runtime.modelFallbackMessage}`);

  let unsubscribe: (() => void) | undefined;
  const bind = async (): Promise<void> => {
    const session = runtime.session;
    await session.bindExtensions({
      uiContext: ui.ui,
      mode: 'rpc',
      onError: (error) => callbacks.onEvent({
        type: 'extension_error', extensionPath: error.extensionPath, event: error.event, error: error.error,
      }),
    });
    unsubscribe?.();
    unsubscribe = session.subscribe((event) => callbacks.onEvent(event as PiRawEvent));
  };
  runtime.setRebindSession(bind);
  await bind();

  let disposed = false;
  return {
    get session() { return runtime.session; },
    respondToUi: (id, payload) => ui.respond(id, payload),
    switchSession: (sessionPath) => runtime.switchSession(sessionPath),
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      ui.cancelAll();
      await runtime.dispose();
    },
  };
}
