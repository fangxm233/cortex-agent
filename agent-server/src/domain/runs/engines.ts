// input:  EngineSpec, the PI EngineAdapter, the Claude pooled adapter
// output: SessionEngines (the one owner of pooled engine sessions) + the module singleton
// pos:    domain/runs — pool ownership (D4): PI lives here, Claude delegates to its adapter map
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createLogger } from '@core/log.js';
import { getAdapter, getEngineAdapter } from '../../agent-adapter/index.js';
import type {
  AgentAdapter, AgentCompactResult, AgentProcess, Backend, EngineSpec,
} from '../../agent-adapter/types.js';
import type { PIAdapter } from '../../agent-adapter/pi/adapter.js';
import type { PIEngineSession } from '../../agent-adapter/pi/engine.js';

const log = createLogger('agent-adapter');
// The retirement line used to come from PIAdapter's own logger; keep its channel identical too.
const piLog = createLogger('pi-adapter');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The adapters SessionEngines drives. PI is an EngineAdapter (one open session per acquire);
 *  Claude still pools inside its own adapter, so only its control surface is needed here. */
export interface SessionEnginesAdapters {
  pi?: PIAdapter;
  claude?: Pick<AgentAdapter, 'close' | 'kill' | 'listSessions'>;
}

/**
 * The single owner of pooled engine sessions (plan §3.3 D4). Every lifecycle control point —
 * `!new`, Stop, thread cleanup, rewind, shutdown and hook-injected sessions — reaches the pool
 * through this object. `acquire` is the old `PIAdapter.reusableSession` + `startSession` moved
 * verbatim: alive-and-matching reuses, anything else retires (same log line) and opens fresh.
 */
export class SessionEngines {
  private readonly pi: PIAdapter | undefined;
  private readonly claude: Pick<AgentAdapter, 'close' | 'kill' | 'listSessions'> | undefined;
  private readonly sessions = new Map<string, PIEngineSession>();

  constructor(adapters: SessionEnginesAdapters = {}) {
    this.pi = adapters.pi;
    this.claude = adapters.claude;
    // Transitional: lets PIAdapter.switchSession reach the live engine without importing domain.
    this.pi?.setEnginePool(this);
  }

  /** Reuse the pooled PI session when it is alive and was opened from the exact same
   *  configuration; otherwise retire it (fire-and-forget close, same log line) and open a new one.
   *  A live session cannot be re-pointed at a different model, tool surface or MCP set. */
  acquire(spec: EngineSpec): PIEngineSession {
    const pi = this.pi;
    if (!pi) throw new Error('SessionEngines has no PI engine adapter configured');
    const key = spec.engineKey;
    const identity = pi.specIdentity(spec);
    const existing = this.sessions.get(key);
    if (existing && existing.isAlive() && existing.identity === identity) return existing;
    if (existing) {
      piLog.info(
        `PI session ${key} retired (${existing.isAlive() ? 'spawn config changed' : 'session gone'});`
        + ' creating a new session',
      );
      void existing.close()
        .catch((error) => piLog.warn(`retiring PI session ${key} failed: ${errorMessage(error)}`));
      this.sessions.delete(key);
    }
    // The eviction guard keeps the old "only if it is still the session this key points at"
    // semantics: a self-closing session (idle timeout) can finish after the pool moved on.
    let engine!: PIEngineSession;
    engine = pi.open(spec, {
      onSelfClose: (sessionKey) => {
        if (this.sessions.get(sessionKey) === engine) this.sessions.delete(sessionKey);
      },
      onEvict: (session) => {
        if (this.sessions.get(key) === session) this.sessions.delete(key);
      },
    });
    this.sessions.set(key, engine);
    return engine;
  }

  get(key: string): PIEngineSession | undefined {
    return this.sessions.get(key);
  }

  /** Graceful close of the pooled session for a key on either backend. The pool entry is dropped
   *  synchronously, so the next `acquire` opens a fresh session even while this one winds down.
   *  Never rejects — a close failure is logged, exactly as the pre-P2.2c wrappers did. Command
   *  handlers that must not block on a subprocess grace period use {@link closeSession} instead. */
  async close(key: string): Promise<void> {
    const engine = this.sessions.get(key);
    if (engine) {
      this.sessions.delete(key);
      await engine.close()
        .catch((error) => log.warn(`close pi session ${key} failed: ${errorMessage(error)}`));
    }
    if (this.claude?.listSessions().includes(key)) {
      await this.claude.close(key)
        .catch((error) => log.warn(`close claude session ${key} failed: ${errorMessage(error)}`));
    }
  }

  /** Hard-stop the pooled session for a key. Returns true when a backend killed one. */
  kill(key: string): boolean {
    let killed = false;
    const engine = this.sessions.get(key);
    if (engine) killed = engine.kill() || killed;
    if (this.claude?.listSessions().includes(key)) killed = this.claude.kill(key) || killed;
    return killed;
  }

  /** Close every pooled session whose key starts with the prefix (thread cleanup). */
  closeByPrefix(prefix: string): void {
    for (const key of [...this.sessions.keys()]) {
      if (key.startsWith(prefix)) void this.close(key);
    }
    for (const key of this.claude?.listSessions() ?? []) {
      if (!key.startsWith(prefix)) continue;
      void this.claude!.close(key)
        .catch((error) => log.warn(`close claude session ${key} failed: ${errorMessage(error)}`));
    }
  }

  /** Close every pooled session on every backend (shutdown). */
  closeAll(): void {
    for (const key of [...this.sessions.keys()]) void this.close(key);
    for (const key of this.claude?.listSessions() ?? []) {
      void this.claude!.close(key)
        .catch((error) => log.warn(`close claude session ${key} failed: ${errorMessage(error)}`));
    }
  }

  listKeys(): string[] {
    return [...this.sessions.keys(), ...(this.claude?.listSessions() ?? [])];
  }

  async compact(key: string): Promise<AgentCompactResult> {
    const engine = this.sessions.get(key);
    if (!engine) throw new Error(`No engine session for ${key}`);
    return engine.compact();
  }

  /** Record the exact transcript path restored by rewind before the next resume spawn.
   *  Bound: rewind and edit-retry pass it around as a bare function value. */
  registerSessionPath = (sessionId: string, sessionPath: string): void => {
    if (!this.pi) throw new Error('SessionEngines has no PI engine adapter configured');
    this.pi.registerSessionPath(sessionId, sessionPath);
  };
}

const PI_ENGINE_ADAPTER = getEngineAdapter('pi');
const CLAUDE_POOL_ADAPTER = getAdapter('claude');

/** The daemon's pool. Tests build their own `new SessionEngines({ pi })` around a fake runtime. */
export const engines = new SessionEngines({
  pi: PI_ENGINE_ADAPTER,
  claude: CLAUDE_POOL_ADAPTER,
});

/**
 * Transitional (deleted with the pool seam in P2.4): the AgentAdapter-shaped view of the PI pool
 * the facade still calls `spawn()` on. `spawn` is exactly `engines.acquire(spec).openLegacyProcess`.
 */
export const piRunAdapter: AgentAdapter = {
  backend: 'pi',
  capabilities: PI_ENGINE_ADAPTER.capabilities,
  spawn: (spec: EngineSpec): AgentProcess => engines.acquire(spec).openLegacyProcess(spec.engineKey),
  close: (key: string): Promise<void> => engines.close(key),
  kill: (key: string): boolean => engines.kill(key),
  listSessions: (): string[] => engines.listKeys(),
  getUsage: (scope) => PI_ENGINE_ADAPTER.getUsage(scope),
};

/** The run/compact adapter for a backend: Claude's own pooled adapter, or the PI pool facade. */
export function getRunAdapter(backend: Backend): AgentAdapter {
  return backend === 'pi' ? piRunAdapter : CLAUDE_POOL_ADAPTER;
}

// --- Backend-neutral control points (plan D4) ---
//
// !new, Stop, thread cleanup, session rewind and shutdown all reach the pool through these; the
// channel/sessionKey signature and fire-and-forget close are the pre-P2.2c public contract.

/** Graceful close of the pooled session for a channel (or explicit sessionKey). Fire-and-forget. */
export function closeSession(channel: string, sessionKey?: string): void {
  void engines.close(sessionKey || channel);
}

/** Hard-stop the pooled session for a channel. Returns true when a backend killed one. */
export function killSession(channel: string, sessionKey?: string): boolean {
  return engines.kill(sessionKey || channel);
}

/** Close every pooled session whose key starts with the prefix (thread cleanup). */
export function closeSessionsByPrefix(prefix: string): void {
  engines.closeByPrefix(prefix);
}

/** Close every pooled session on every backend (shutdown). */
export function closeAllSessions(): void {
  engines.closeAll();
}
