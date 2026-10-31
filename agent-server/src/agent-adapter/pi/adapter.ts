import type { SubagentModelEnvGetter } from '@core/agents/subagent/catalog.js';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import { resolveSpawnCwd } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../capabilities.js';
import type {
  EngineAdapter, EngineSpec, AgentUsageScope, Backend,
} from '../types.js';
import { writeProviderCatalog, type PiProviderCatalog } from './providers-config.js';
import { readOAuthProviders } from './chatgpt-signin.js';
import { findPISessionFilePath } from './session-files.js';
import { reportCodexQuota, resolveQuotaSource, type CodexQuotaSinkDeps } from './quota-sink.js';
import type { PiSubagentBridge } from './subagent-bridge.js';
import type { OpenBundledMcpServer } from './mcp-bridge.js';

type SubmitRateLimit = CodexQuotaSinkDeps['submit'];
import { CODEX_PROVIDER, type CodexQuotaReading } from '@core/codex-quota.js';
import type { ProviderUsage, UsageStore } from '@domain/costs/usage-store.js';
import { scanAgentDirModels, type PiDiscoveredModel } from './model-scan.js';
import { PISession } from './pi-session.js';
import { PIEngineSession, type PIEngineOpenHooks } from './engine.js';
import { createPiRuntime, type PiRuntimeFactory } from './runtime.js';
import {
  buildSessionRequest, sessionIdentity, type PiSessionRequest,
} from './session-options.js';
import type { SwitchResult } from './session-support.js';
import { PI_AGENT_DIR, PI_SESSIONS_DIR } from './defaults.js';

/** The pool SessionEngines registers on the adapter so `switchSession` can reach the live
 *  engine without the adapter importing domain. */
export interface PIEnginePoolLookup {
  get(key: string): PIEngineSession | undefined;
}

const log = createLogger('pi-adapter');

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

/** Collaborators the daemon owns and a trial replaces. Both are injected rather than defaulted so
 *  the host PI home and its auth mirroring are not reachable from this module. */
export interface PIAdapterHooks {
  /** PI agent dir (auth.json, models.json) for every session this instance creates. */
  agentDir?: string;
  /** Run before a session is created with the resolved agent dir: the daemon mirrors the host
   *  credential here, a trial writes its dummy token. Never a module default. */
  prepareAgentDir?: (agentDir: string) => void;
  /** The provider catalog sessions run with: base-URL overrides and user-defined providers, with
   *  their keys. Injected, never defaulted: the host's connections and PI home are exactly the
   *  ambient reach a trial must not have. Left unset, the agent dir's catalog is not touched. */
  catalog?: () => PiProviderCatalog;
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
  getSubagentModelEnv?: SubagentModelEnvGetter;
}

export class PIAdapter implements EngineAdapter {
  readonly backend: Backend = 'pi';
  readonly capabilities: Set<Capability> = CAPABILITIES_BY_BACKEND.pi;
  private poolLookup: PIEnginePoolLookup | null = null;
  private readonly runtimeFactory: PiRuntimeFactory;
  private readonly sessionPathRegistry = new Map<string, string>();
  /** Injected PI home, or undefined when the caller left it to the daemon default. */
  private readonly configuredAgentDir: string | undefined;
  private readonly prepareAgentDir: ((agentDir: string) => void) | undefined;
  /** Injected catalog source, or undefined when this instance writes no catalog. */
  private readonly catalog: (() => PiProviderCatalog) | undefined;
  private readonly usageStore: Pick<UsageStore, 'get' | 'update'> | undefined;
  private readonly submitRateLimit: SubmitRateLimit | undefined;
  private readonly subagent: PiSubagentBridge | undefined;
  private readonly openBundledMcpServer: OpenBundledMcpServer | undefined;
  private readonly getSubagentModelEnv: SubagentModelEnvGetter | undefined;
  /** sessionDir for the <sessionId>.jsonl path convention. Exposed for tests. */
  readonly sessionDir: string;

  constructor(
    runtimeFactory: PiRuntimeFactory = createPiRuntime,
    sessionDir: string = PI_SESSIONS_DIR,
    hooks: PIAdapterHooks = {},
  ) {
    this.runtimeFactory = runtimeFactory;
    this.sessionDir = sessionDir;
    this.configuredAgentDir = hooks.agentDir;
    this.prepareAgentDir = hooks.prepareAgentDir;
    this.catalog = hooks.catalog;
    this.usageStore = hooks.usageStore;
    this.submitRateLimit = hooks.submitRateLimit;
    this.subagent = hooks.subagent;
    this.openBundledMcpServer = hooks.openBundledMcpServer;
    this.getSubagentModelEnv = hooks.getSubagentModelEnv;
  }

  async getUsage(scope: AgentUsageScope): Promise<ProviderUsage[] | null> {
    if (scope.provider !== CODEX_PROVIDER || !scope.mode) return null;
    const cached = await this.usageStore?.get(CODEX_PROVIDER) ?? null;
    return [cached ? staleCodexUsage(cached) : neverCodexUsage(scope.mode)];
  }

  private resolveSpawnSessionPath(spec: EngineSpec, sessionDir: string): string | null {
    if (!spec.resume.resume || !spec.resume.backendSessionId) return null;
    const sessionPath = this.resolveSessionPath(spec.resume.backendSessionId);
    if (sessionPath === null) {
      log.info(`PI resume target '${spec.resume.backendSessionId}' not found (no live session or file in ${sessionDir}); starting fresh`);
    }
    return sessionPath;
  }

  private prepareAgentDirSafely(agentDir: string): void {
    try {
      this.prepareAgentDir?.(agentDir);
    } catch (error) {
      log.warn(`Failed to prepare the PI agent dir: ${(error as Error).message}`);
    }
  }

  private writeCatalog(agentDir: string): void {
    if (!this.catalog) return;
    try {
      writeProviderCatalog(this.catalog(), {
        agentDir, oauthProviders: readOAuthProviders(path.join(agentDir, 'auth.json')),
      });
    } catch (error) {
      log.warn(`Failed to write PI models.json: ${(error as Error).message}`);
    }
  }

  /** Mirror the host credential into the agent dir, then write the catalog sessions run with. */
  private syncAgentDir(agentDir: string): void {
    this.prepareAgentDirSafely(agentDir);
    this.writeCatalog(agentDir);
  }

  /** The PI agent dir this adapter routes and authenticates through. */
  get agentDir(): string {
    return this.configuredAgentDir ?? PI_AGENT_DIR;
  }

  /**
   * Bring the agent dir's catalog up to date without spawning a PI session.
   *
   * A nested subagent session reads the catalog off disk, but the catalog is normally written as a
   * side effect of {@link prepareRequest} — so a `pi` child delegated from a `claude` parent would
   * find no catalog in this daemon's lifetime.
   */
  ensureCatalog(): void {
    this.syncAgentDir(this.agentDir);
  }

  /** The models sessions of this adapter can run: the catalog brought up to date, then scanned
   *  through the same credential store, models.json and runtime keys a session uses. */
  scanModels(): Promise<PiDiscoveredModel[]> {
    this.ensureCatalog();
    return scanAgentDirModels(this.agentDir);
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
    this.syncAgentDir(agentDir);
    return this.buildRequest(spec, sessionPath);
  }

  /** Undefined unless this instance was given somewhere to put a reading: no injected
   *  store/throttle means nothing may be written (D10 — the sink used to fall back to the daemon's
   *  singletons, so an unhooked instance wrote the real throttle). `extensions.ts` skips the probe
   *  entirely when this returns undefined. */
  private quotaReporter(spec: EngineSpec): ((reading: CodexQuotaReading) => void) | undefined {
    const usageStore = this.usageStore;
    const submit = this.submitRateLimit;
    if (!usageStore || !submit) return undefined;
    return (reading) => {
      void reportCodexQuota(reading, resolveQuotaSource({
        provider: spec.model.provider, connection: spec.route.connection,
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
    const session = new PISession({
      request,
      runtimeFactory: this.runtimeFactory,
      registry: this.sessionPathRegistry,
      onClose: hooks.onSelfClose,
      onProviderQuota: this.quotaReporter(spec),
      subagent: this.subagent,
      openBundledMcpServer: this.openBundledMcpServer,
      getSubagentModelEnv: this.getSubagentModelEnv,
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
