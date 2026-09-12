// input:  Spawn config, provider caches, MCP policy, a PI runtime factory
// output: Pooled in-process PI sessions, interaction eligibility, usage, events
// pos:    Coordinates PI session lifecycles for the Cortex agent-adapter contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { existsSync, mkdirSync } from 'fs';
import { resolveSpawnCwd } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../capabilities.js';
import type {
  AgentAdapter, EngineAdapter, EngineSession, EngineSpec, AgentUsageScope, Backend, UserMessage,
} from '../types.js';
import type { AgentResult } from '@core/types/agent-types.js';
import {
  writeProvidersConfig,
  buildProviderOverrides,
  withCustomEntries,
  type ProviderOverride,
} from './providers-config.js';
import { readCustomProviderEntries } from './custom-catalog.js';
import { findPISessionFilePath } from './session-files.js';
import { reportCodexQuota, resolveQuotaSource } from './quota-sink.js';
import { CODEX_PROVIDER, type CodexQuotaReading } from '@domain/costs/codex-quota.js';
import type { ProviderUsage, UsageStore } from '@domain/costs/usage-store.js';
import type { PIProviderDiscovery } from './discovery.js';
import { PISession, turnStreamIterable } from './pi-session.js';
import { PIEngineSession } from './engine.js';
import { createPiRuntime, type PiRuntimeFactory } from './runtime.js';
import {
  buildSessionRequest, sessionIdentity, unsupportedExtraOptions, type PiSessionRequest,
} from './session-options.js';
import type { EventQueue, PIAgentProcess, SwitchResult } from './session-support.js';
import { DEFAULT_SESSION_DIR, PI_AGENT_DIR, piModelsPath } from './defaults.js';
export type { PIAgentProcess } from './session-support.js';

const log = createLogger('pi-adapter');

/** Discovery that reports nothing when the daemon does not inject its cached scanner. */
const NO_PROVIDER_DISCOVERY: PIProviderDiscovery = {
  getProviders: () => [],
  getModels: () => [],
  peekModels: () => [],
  refresh: () => {},
};

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function neverCodexUsage(mode: string): ProviderUsage {
  return {
    provider: CODEX_PROVIDER,
    displayName: 'OpenAI Codex',
    modes: [mode],
    windows: [],
    observedAt: null,
    freshness: 'never',
  };
}

function staleCodexUsage(record: ProviderUsage): ProviderUsage {
  return {
    ...record,
    modes: [...record.modes],
    windows: record.windows.map((window) => ({ ...window })),
    ...(record.spend ? { spend: { ...record.spend } } : {}),
    freshness: 'stale',
  };
}

/** A fully-populated EngineSpec with every optional field absent. Only the fields a caller sets
 *  before handing it to a reader are consumed; the rest exist to satisfy the required shape. */
function minimalEngineSpec(): EngineSpec {
  return {
    engineKey: 'default',
    resume: { backendSessionId: null, resume: false },
    model: {},
    prompt: {},
    tools: {},
    plugins: {},
    mcp: {},
    env: {},
    route: {},
    flags: { isUserInitiated: false },
    context: {},
    backend: { kind: 'pi' },
    process: {},
  };
}

/** Collaborators the daemon owns and a trial replaces. Both are injected rather than defaulted so
 *  the host PI home and its auth mirroring are not reachable from this module. */
export interface PIAdapterHooks {
  /** PI agent dir (auth.json, models.json) for every session this instance creates. */
  agentDir?: string;
  /** Run before a session is created with the resolved agent dir: the daemon mirrors the host
   *  credential here, a trial writes its dummy token. Never a module default. */
  prepareAgentDir?: (agentDir: string) => void;
  /** The user's PI catalog (`~/.pi/agent/models.json`), source of user-defined provider
   *  definitions. Injected, never defaulted: reading the host PI home is exactly the ambient reach
   *  a trial must not have. Left unset, no custom provider is mirrored. */
  userModelsPath?: string;
  /** Daemon-owned push usage cache. Trials omit it and observe only a cold state. */
  usageStore?: Pick<UsageStore, 'get' | 'update'>;
}

export class PIAdapter implements AgentAdapter, EngineAdapter {
  readonly backend: Backend = 'pi';
  readonly capabilities: Set<Capability> = CAPABILITIES_BY_BACKEND.pi;
  private readonly sessions = new Map<string, PISession>();
  private readonly runtimeFactory: PiRuntimeFactory;
  private readonly providerDiscovery: PIProviderDiscovery;
  private readonly configuredProviderOverrides = new Map<string, ProviderOverride>();
  private readonly sessionPathRegistry = new Map<string, string>();
  /** Injected PI home, or undefined when the caller left it to the daemon default. */
  private readonly configuredAgentDir: string | undefined;
  private readonly prepareAgentDir: ((agentDir: string) => void) | undefined;
  /** Injected user catalog path, or undefined when this instance mirrors no custom provider. */
  private readonly userModelsPath: string | undefined;
  private readonly usageStore: Pick<UsageStore, 'get' | 'update'> | undefined;
  /** sessionDir for the <sessionId>.jsonl path convention. Exposed for tests. */
  readonly sessionDir: string;

  constructor(
    runtimeFactory: PiRuntimeFactory = createPiRuntime,
    sessionDir: string = DEFAULT_SESSION_DIR,
    providerDiscovery: PIProviderDiscovery = NO_PROVIDER_DISCOVERY,
    hooks: PIAdapterHooks = {},
  ) {
    this.runtimeFactory = runtimeFactory;
    this.sessionDir = sessionDir;
    this.providerDiscovery = providerDiscovery;
    this.configuredAgentDir = hooks.agentDir;
    this.prepareAgentDir = hooks.prepareAgentDir;
    this.userModelsPath = hooks.userModelsPath;
    this.usageStore = hooks.usageStore;
  }

  async getUsage(scope: AgentUsageScope): Promise<ProviderUsage[] | null> {
    if (scope.provider !== CODEX_PROVIDER || !scope.mode) return null;
    const cached = await this.usageStore?.get(CODEX_PROVIDER) ?? null;
    return [cached ? staleCodexUsage(cached) : neverCodexUsage(scope.mode)];
  }

  private gatewayOverrides(
    discovered: string[], currentProvider: string | null,
    gatewayPath: string | null, model: string | undefined, maxTokens?: number,
  ): ProviderOverride[] {
    if (currentProvider) {
      const [current] = buildProviderOverrides([], currentProvider, gatewayPath);
      const modelOverrides = model && maxTokens !== undefined
        ? { [model]: { maxTokens } } : undefined;
      this.configuredProviderOverrides.set(currentProvider, {
        ...current, ...(modelOverrides ? { modelOverrides } : {}),
      });
    }
    const byName = new Map(
      buildProviderOverrides(discovered, null, null).map((override) => [override.name, override]),
    );
    for (const override of this.configuredProviderOverrides.values()) byName.set(override.name, override);
    return Array.from(byName.values());
  }

  private resolveSpawnSessionPath(spec: EngineSpec, sessionDir: string): string | null {
    if (!spec.resume.resume || !spec.resume.backendSessionId) return null;
    const sessionPath = this.resolveSessionPath(spec.resume.backendSessionId);
    if (sessionPath === null) {
      log.info(`PI resume target '${spec.resume.backendSessionId}' not found (no live session or file in ${sessionDir}); starting fresh`);
    }
    return sessionPath;
  }

  private prepareGatewayAgentDir(agentDir: string): void {
    try {
      this.prepareAgentDir?.(agentDir);
    } catch (error) {
      log.warn(`Failed to prepare the PI agent dir: ${(error as Error).message}`);
    }
  }

  private writeGatewayProviders(
    spec: EngineSpec,
    agentDir: string,
    gatewayBaseUrl: string,
  ): void {
    try {
      this.writeGatewayProvidersUnchecked(spec, agentDir, gatewayBaseUrl);
    } catch (error) {
      log.warn(`Failed to write PI models.json: ${(error as Error).message}`);
    }
  }

  private writeGatewayProvidersUnchecked(
    spec: EngineSpec,
    agentDir: string,
    gatewayBaseUrl: string,
  ): void {
    const overrides = withCustomEntries(
      this.gatewayOverrides(
        this.providerDiscovery.getProviders(),
        spec.model.provider ?? null,
        spec.route.gatewayPath ?? null,
        spec.model.id,
        spec.model.maxOutputTokens,
      ),
      this.userModelsPath ? readCustomProviderEntries(this.userModelsPath) : {},
    );
    if (overrides.length === 0) {
      log.warn('No PI providers to route (empty discovery and no profile provider); the PI session may fail to authenticate');
      return;
    }
    writeProvidersConfig(overrides, gatewayBaseUrl, { modelsPath: piModelsPath(agentDir) });
  }

  private syncGatewayConfig(spec: EngineSpec, agentDir: string): void {
    const gatewayBaseUrl = spec.route.gatewayBaseUrl;
    if (!gatewayBaseUrl) return;
    this.prepareGatewayAgentDir(agentDir);
    this.writeGatewayProviders(spec, agentDir, gatewayBaseUrl);
  }

  /** The PI agent dir this adapter routes and authenticates through. */
  get agentDir(): string {
    return this.configuredAgentDir ?? PI_AGENT_DIR;
  }

  /**
   * Write a routed `models.json` for one provider without spawning a PI session.
   *
   * A nested subagent session reads the catalog off disk, but the catalog is normally written as a
   * side effect of {@link prepareRequest} — so a `pi` child delegated from a `claude` parent would
   * find nothing routed for its provider in this daemon's lifetime (plan §3.2). The per-provider
   * routes this remembers are the same map a later PI spawn merges into, so calling it never
   * narrows the catalog a live session is already using.
   */
  ensureProviderRouting(opts: {
    provider: string;
    gatewayPath?: string | null;
    gatewayBaseUrl: string;
    model?: string;
    maxTokens?: number;
  }): void {
    const spec = minimalEngineSpec();
    spec.model.provider = opts.provider;
    spec.model.id = opts.model;
    spec.model.maxOutputTokens = opts.maxTokens;
    spec.route.gatewayPath = opts.gatewayPath ?? undefined;
    spec.route.gatewayBaseUrl = opts.gatewayBaseUrl;
    this.syncGatewayConfig(spec, this.agentDir);
  }

  private prepareRequest(spec: EngineSpec): PiSessionRequest {
    const agentDir = this.agentDir;
    mkdirSync(this.sessionDir, { recursive: true });
    const sessionPath = this.resolveSpawnSessionPath(spec, this.sessionDir);
    this.syncGatewayConfig(spec, agentDir);
    for (const key of unsupportedExtraOptions(spec)) {
      log.warn(`PI extraOption ${key} was a CLI flag; the in-process backend ignores it`);
    }
    return buildSessionRequest(spec, {
      agentDir,
      sessionDir: this.sessionDir,
      sessionPath,
      cwd: resolveSpawnCwd(spec.cwd),
      streamDeltas: spec.flags.streamDeltas ?? getSettings().streamDeltas,
    });
  }

  private quotaReporter(spec: EngineSpec): ((reading: CodexQuotaReading) => void) | undefined {
    if (!spec.route.gatewayBaseUrl) return undefined;
    return (reading) => {
      void reportCodexQuota(reading, resolveQuotaSource({
        provider: spec.model.provider, gatewayPath: spec.route.gatewayPath,
      }), { usageStore: this.usageStore })
        .catch((error) => log.error('reportCodexQuota error:', error));
    };
  }

  /** Drop a pooled entry only while it is still the one this key points at: a self-closing session
   *  (idle timeout) can finish long after the pool moved on to its replacement. */
  private evictSession(sessionKey: string, session: unknown): void {
    if (this.sessions.get(sessionKey) === session) this.sessions.delete(sessionKey);
  }

  private sendSpawnedTurn(session: PISession, msg: UserMessage): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve, reject) => {
      session.beginTurn(resolve, reject);
      const targetId = session.sessionId;
      const targetPath = targetId === null ? null : this.resolveSessionPath(targetId);
      session.sendTurn(targetId, targetPath, msg)
        .catch((error) => session.beginTurnReject(errorValue(error)));
    });
  }

  private async closeSpawnedSession(sessionKey: string, session: PISession): Promise<void> {
    await session.close();
    this.evictSession(sessionKey, session);
  }

  private killSpawnedSession(sessionKey: string, session: PISession): boolean {
    const killed = session.kill();
    if (killed) this.evictSession(sessionKey, session);
    return killed;
  }

  private createAgentProcess(
    sessionKey: string, session: PISession, turnStream: EventQueue,
  ): PIAgentProcess {
    return {
      sessionKey,
      get sessionId(): string | null { return session.sessionId; },
      send: (msg) => this.sendSpawnedTurn(session, msg),
      compact: () => session.compact(),
      sendExtensionUiResponse: (id, payload) => session.sendExtensionUiResponse(id, payload),
      injectUserMessage: (msg) => session.injectUserMessage(msg),
      setInjectionAckSink: (sink) => session.setInjectionAckSink(sink),
      events: turnStreamIterable(turnStream),
      // Out-of-band attribution (see AgentProcess.pushTurnEvent). Bound to THIS run's queue, so a
      // late push from an abandoned run cannot leak into the turn that replaced it.
      pushTurnEvent: (event) => {
        if (turnStream.isClosed) return false;
        turnStream.push(event);
        return true;
      },
      // Ends this run, not the session: the session is pooled per sessionKey and serves the
      // next turn. Session teardown goes through PIAdapter.close(key) / kill(key), which
      // is what !new, Stop, thread cleanup and rewind reach.
      close: async () => { session.closeTurnStreamFor(turnStream); },
      kill: () => this.killSpawnedSession(sessionKey, session),
    };
  }

  spawn(spec: EngineSpec): PIAgentProcess {
    const request = this.prepareRequest(spec);
    const identity = sessionIdentity(request);
    const session = this.reusableSession(spec.engineKey, identity)
      ?? this.startSession(spec, request, identity);
    return this.createAgentProcess(spec.engineKey, session, session.openTurnStream());
  }

  /**
   * Construct a session without pooling or registering it: per plan §3.3 `open()` is pure
   * construction, and `SessionEngines` (P2.2c) owns the lifetime/reuse decision. `prepareRequest`
   * and the `PISession` options mirror `spawn()`/`startSession` exactly; the only difference is the
   * absent `this.sessions` entry and pool `onClose` eviction hook.
   */
  open(spec: EngineSpec): EngineSession {
    const request = this.prepareRequest(spec);
    const identity = sessionIdentity(request);
    const session = new PISession({
      request,
      runtimeFactory: this.runtimeFactory,
      identity,
      registry: this.sessionPathRegistry,
      onProviderQuota: this.quotaReporter(spec),
    });
    return new PIEngineSession(session, request);
  }

  /** The pooled session for this key when it can serve the turn: alive, and created from the exact
   *  configuration this spawn resolved to. Anything else is retired here so the caller creates a
   *  fresh session — a live session cannot be re-pointed at a different model, tool surface or
   *  MCP set, so reusing one across such a change would silently run the wrong configuration. */
  private reusableSession(sessionKey: string, identity: string): PISession | null {
    const session = this.sessions.get(sessionKey);
    if (!session) return null;
    if (session.isAlive() && session.matchesSpawn(identity)) return session;
    log.info(
      `PI session ${sessionKey} retired (${session.isAlive() ? 'spawn config changed' : 'session gone'});`
      + ' creating a new session',
    );
    void this.closeSpawnedSession(sessionKey, session)
      .catch((error) => log.warn(`retiring PI session ${sessionKey} failed: ${errorValue(error).message}`));
    this.sessions.delete(sessionKey);
    return null;
  }

  private startSession(
    spec: EngineSpec, request: PiSessionRequest, identity: string,
  ): PISession {
    const session = new PISession({
      request,
      runtimeFactory: this.runtimeFactory,
      identity,
      registry: this.sessionPathRegistry,
      onClose: (key, closing) => this.evictSession(key, closing),
      onProviderQuota: this.quotaReporter(spec),
    });
    this.sessions.set(spec.engineKey, session);
    return session;
  }

  /** Record the exact transcript path restored by rewind before the next resume spawn. */
  registerSessionPath(sessionId: string, sessionPath: string): void {
    this.sessionPathRegistry.set(sessionId, sessionPath);
  }

  /**
   * Resolve an existing JSONL path from the live registry or filename-only disk discovery.
   * Stale and synthesized registry entries are evicted before discovery.
   */
  resolveSessionPath(sessionId: string): string | null {
    const registered = this.sessionPathRegistry.get(sessionId);
    if (registered && existsSync(registered)) return registered;
    if (registered) this.sessionPathRegistry.delete(sessionId);
    const discovered = findPISessionFilePath(this.sessionDir, sessionId);
    if (discovered) this.sessionPathRegistry.set(sessionId, discovered);
    return discovered;
  }

  /**
   * Switch the pooled session under `onSessionKey` to serve a different PI transcript.
   * Returns {ok:false, cancelled:false} if the session key or target session ID is unknown.
   */
  async switchSession(sessionId: string, onSessionKey: string): Promise<SwitchResult> {
    const session = this.sessions.get(onSessionKey);
    if (!session) return { ok: false, cancelled: false };
    const targetPath = this.resolveSessionPath(sessionId);
    if (targetPath === null) return { ok: false, cancelled: false };
    const result = await session.sendSwitchSession(targetPath);
    if (result.ok) session.currentSessionId = sessionId;
    return result;
  }

  async close(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    await session.close();
    this.evictSession(sessionKey, session);
  }

  kill(sessionKey: string): boolean {
    const session = this.sessions.get(sessionKey);
    if (!session) return false;
    return this.killSpawnedSession(sessionKey, session);
  }

  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
}
