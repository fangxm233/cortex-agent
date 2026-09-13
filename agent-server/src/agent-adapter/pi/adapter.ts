// input:  Spawn config, provider caches, MCP policy, a PI runtime factory
// output: PI engine sessions (open), identity, usage, interaction eligibility, events
// pos:    PI backend's stateless EngineAdapter; SessionEngines owns pooling and lifetime
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { existsSync, mkdirSync } from 'fs';
import { resolveSpawnCwd } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../capabilities.js';
import type {
  EngineAdapter, EngineSpec, AgentUsageScope, Backend,
} from '../types.js';
import {
  writeProvidersConfig,
  buildProviderOverrides,
  withCustomEntries,
  type ProviderOverride,
} from './providers-config.js';
import { readCustomProviderEntries } from './custom-catalog.js';
import { findPISessionFilePath } from './session-files.js';
import { reportCodexQuota, resolveQuotaSource, type CodexQuotaSinkDeps } from './quota-sink.js';
import type { PiSubagentBridge } from './subagent-bridge.js';
import type { OpenBundledMcpServer } from './mcp-bridge.js';

type SubmitRateLimit = CodexQuotaSinkDeps['submit'];
import { CODEX_PROVIDER, type CodexQuotaReading } from '@core/codex-quota.js';
import type { ProviderUsage, UsageStore } from '@domain/costs/usage-store.js';
import type { PIProviderDiscovery } from './discovery.js';
import { PISession } from './pi-session.js';
import { PIEngineSession, type PIEngineOpenHooks } from './engine.js';
import { createPiRuntime, type PiRuntimeFactory } from './runtime.js';
import {
  buildSessionRequest, sessionIdentity, unsupportedExtraOptions, type PiSessionRequest,
} from './session-options.js';
import type { SwitchResult } from './session-support.js';
import { DEFAULT_SESSION_DIR, PI_AGENT_DIR, piModelsPath } from './defaults.js';
export type { PIAgentProcess } from './session-support.js';

/** The pool SessionEngines registers on the adapter so `switchSession` can reach the live
 *  engine without the adapter importing domain. */
export interface PIEnginePoolLookup {
  get(key: string): PIEngineSession | undefined;
}

const log = createLogger('pi-adapter');

/** Discovery that reports nothing when the daemon does not inject its cached scanner. */
const NO_PROVIDER_DISCOVERY: PIProviderDiscovery = {
  getProviders: () => [],
  getModels: () => [],
  peekModels: () => [],
  refresh: () => {},
};

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
  /** Host throttle entry point for Codex quota windows read off provider responses. Injected
   *  rather than defaulted (D10): the throttle is domain state, and an omitted sink means this
   *  instance reports nothing rather than writing the daemon's. */
  submitRateLimit?: SubmitRateLimit;
  /** The daemon's subagent machinery, reached by PI's in-process `agent` tool. Injected because
   *  it lives in the run registry and the delivery route (D10); unset ⇒ a session delegates to
   *  nested `pi` children only. */
  subagent?: PiSubagentBridge;
  /** Builds the in-process Cortex bundle server every session of this instance hosts (D10).
   *  Unset ⇒ sessions run with plugin MCP servers only and no Cortex tools. */
  openBundledMcpServer?: OpenBundledMcpServer;
}

export class PIAdapter implements EngineAdapter {
  readonly backend: Backend = 'pi';
  readonly capabilities: Set<Capability> = CAPABILITIES_BY_BACKEND.pi;
  private poolLookup: PIEnginePoolLookup | null = null;
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
  private readonly submitRateLimit: SubmitRateLimit | undefined;
  private readonly subagent: PiSubagentBridge | undefined;
  private readonly openBundledMcpServer: OpenBundledMcpServer | undefined;
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
    this.submitRateLimit = hooks.submitRateLimit;
    this.subagent = hooks.subagent;
    this.openBundledMcpServer = hooks.openBundledMcpServer;
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

  /** The one construction of a `PiSessionRequest`; `specIdentity` and `prepareRequest` both come
   *  through here so the identity the pool compares can never drift from the request `open` builds. */
  private buildRequest(spec: EngineSpec, sessionPath: string | null): PiSessionRequest {
    return buildSessionRequest(spec, {
      agentDir: this.agentDir,
      sessionDir: this.sessionDir,
      sessionPath,
      cwd: resolveSpawnCwd(spec.cwd),
      streamDeltas: spec.flags.streamDeltas ?? getSettings().streamDeltas,
    });
  }

  /** The comparable identity of the session this spec *would* open. Read-only: no mkdir, no
   *  models.json write, no warnings, no PISession (whose constructor starts a runtime). */
  specIdentity(spec: EngineSpec): string {
    // sessionPath is excluded from the identity, so resolving it here would only add effects.
    return sessionIdentity(this.buildRequest(spec, null));
  }

  private prepareRequest(spec: EngineSpec): PiSessionRequest {
    const agentDir = this.agentDir;
    mkdirSync(this.sessionDir, { recursive: true });
    const sessionPath = this.resolveSpawnSessionPath(spec, this.sessionDir);
    this.syncGatewayConfig(spec, agentDir);
    for (const key of unsupportedExtraOptions(spec)) {
      log.warn(`PI extraOption ${key} was a CLI flag; the in-process backend ignores it`);
    }
    return this.buildRequest(spec, sessionPath);
  }

  /** Undefined unless this instance was given somewhere to put a reading: no gateway route means
   *  no plan-backed quota to read, and no injected store/throttle means nothing may be written
   *  (D10 — the sink used to fall back to the daemon's singletons, so an unhooked instance wrote
   *  the real throttle). `extensions.ts` skips the probe entirely when this returns undefined. */
  private quotaReporter(spec: EngineSpec): ((reading: CodexQuotaReading) => void) | undefined {
    if (!spec.route.gatewayBaseUrl) return undefined;
    const usageStore = this.usageStore;
    const submit = this.submitRateLimit;
    if (!usageStore || !submit) return undefined;
    return (reading) => {
      void reportCodexQuota(reading, resolveQuotaSource({
        provider: spec.model.provider, gatewayPath: spec.route.gatewayPath,
      }), { usageStore, submit })
        .catch((error) => log.error('reportCodexQuota error:', error));
    };
  }

  /**
   * Construct a session without pooling: per plan §3.3 `open()` is pure construction and
   * `SessionEngines` owns the lifetime/reuse decision. `prepareRequest` and the
   * `PISession` options are exactly what the old pooled `startSession` used; the pool passes the
   * self-close and eviction hooks through `hooks`.
   */
  open(spec: EngineSpec, hooks: PIEngineOpenHooks = {}): PIEngineSession {
    const request = this.prepareRequest(spec);
    const identity = sessionIdentity(request);
    const session = new PISession({
      request,
      runtimeFactory: this.runtimeFactory,
      identity,
      registry: this.sessionPathRegistry,
      onClose: hooks.onSelfClose,
      onProviderQuota: this.quotaReporter(spec),
      subagent: this.subagent,
      openBundledMcpServer: this.openBundledMcpServer,
    });
    return new PIEngineSession(session, request, {
      onEvict: hooks.onEvict,
      resolveSessionPath: (sessionId) => this.resolveSessionPath(sessionId),
    });
  }

  /** SessionEngines registers itself so `switchSession` can find the live engine. */
  setEnginePool(pool: PIEnginePoolLookup): void {
    this.poolLookup = pool;
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
   * Switch the pooled session under `onSessionKey` to serve a different PI transcript, via the
   * pool registered by SessionEngines. Returns {ok:false, cancelled:false} if the session
   * key or target session ID is unknown.
   */
  async switchSession(sessionId: string, onSessionKey: string): Promise<SwitchResult> {
    const engine = this.poolLookup?.get(onSessionKey);
    if (!engine) return { ok: false, cancelled: false };
    const targetPath = this.resolveSessionPath(sessionId);
    if (targetPath === null) return { ok: false, cancelled: false };
    return engine.switchSession(sessionId, targetPath);
  }
}
