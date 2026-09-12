// input:  EngineSpec, the PI EngineAdapter, the Claude EngineAdapter
// output: SessionEngines (the one owner of pooled engine sessions) + the module singleton
// pos:    domain/runs — pool ownership (D4): both backends' sessions live in one Map
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createLogger } from '@core/log.js';
import { getAdapter, getEngineAdapter } from './adapters.js';
import type {
  AgentAdapter, AgentCompactResult, AgentProcess, Backend, EngineSpec,
} from '../../agent-adapter/types.js';
import type { PIAdapter } from '../../agent-adapter/pi/adapter.js';
import type { ClaudeAdapter } from '../../agent-adapter/claude/adapter.js';
import type { PIEngineSession } from '../../agent-adapter/pi/engine.js';
import type { ClaudeEngineSession } from '../../agent-adapter/claude/engine.js';

const log = createLogger('agent-adapter');
// The retirement line used to come from PIAdapter's own logger; keep its channel identical too.
const piLog = createLogger('pi-adapter');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The stateless engine factories SessionEngines drives (P2.3c: Claude joins PI here). Both are
 *  `EngineAdapter`s — `acquire` decides reuse, the adapter only constructs. */
export interface SessionEnginesAdapters {
  pi?: PIAdapter;
  claude?: ClaudeAdapter;
}

/** One pooled backend session; the backend discriminant is the only thing distinguishing them. */
type EngineSession = PIEngineSession | ClaudeEngineSession;

/**
 * The single owner of pooled engine sessions (plan §3.3 D4). Every lifecycle control point —
 * `!new`, Stop, thread cleanup, rewind, shutdown and hook-injected sessions — reaches the pool
 * through this object. `acquire` dispatches on the spec's backend and reproduces each backend's
 * old pool read verbatim: alive-and-matching reuses, anything else retires and opens fresh.
 */
export class SessionEngines {
  private readonly pi: PIAdapter | undefined;
  private readonly claude: ClaudeAdapter | undefined;
  private readonly sessions = new Map<string, EngineSession>();

  constructor(adapters: SessionEnginesAdapters = {}) {
    this.pi = adapters.pi;
    this.claude = adapters.claude;
    // Transitional: lets PIAdapter.switchSession reach the live PI engine without importing domain.
    this.pi?.setEnginePool({ get: (key) => this.piEngine(key) });
  }

  /** Dispatch on the backend discriminant; each branch is that backend's old pool read. */
  acquire(spec: EngineSpec): EngineSession {
    return spec.backend.kind === 'pi' ? this.acquirePi(spec) : this.acquireClaude(spec);
  }

  /** Reuse the pooled PI session when it is alive and was opened from the exact same
   *  configuration; otherwise retire it (fire-and-forget close, same log line) and open a new one.
   *  A live session cannot be re-pointed at a different model, tool surface or MCP set. */
  private acquirePi(spec: EngineSpec): PIEngineSession {
    const pi = this.pi;
    if (!pi) throw new Error('SessionEngines has no PI engine adapter configured');
    const key = spec.engineKey;
    const identity = pi.specIdentity(spec);
    const existing = this.sessions.get(key) as PIEngineSession | undefined;
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

  /**
   * Claude's pool read (P2.3c): the old Claude pool predicate moved off `ClaudeSession`.
   * `specIdentity` replaces `matchesSpawn` — P2.3b proved string equality IS the structural
   * predicate; the fourth clause has no PI equivalent and compares the spec's resume target
   * against the session's **live** `sessionId`. Claude's retire path logs nothing and does not
   * check `isAlive()` before closing (`close()` itself is a no-op once dead); keep both as they are.
   */
  private acquireClaude(spec: EngineSpec): ClaudeEngineSession {
    const claude = this.claude;
    if (!claude) throw new Error('SessionEngines has no Claude engine adapter configured');
    const key = spec.engineKey;
    const identity = claude.specIdentity(spec);
    const resume = claude.claudeResumeTarget(spec);
    let session = this.sessions.get(key) as ClaudeEngineSession | undefined;
    const incompatible = session && session.identity !== identity;
    if (!session || !session.isAlive() || incompatible
        || (resume.needsResume && session.backendSessionId !== resume.sessionId)) {
      if (session) void session.close();
      this.sessions.delete(key);
      let engine!: ClaudeEngineSession;
      engine = claude.open(spec, {
        onSelfClose: (sessionKey) => {
          if (this.sessions.get(sessionKey) === engine) this.sessions.delete(sessionKey);
        },
        // Unconditional, exactly as `ClaudeSession.writeTurnStdin`'s catch was: a fatal stdin
        // write failure evicts the key even if the pool has already moved on to a replacement.
        onEvict: (sessionKey) => {
          this.sessions.delete(sessionKey);
        },
      });
      this.sessions.set(key, engine);
      session = engine;
    }
    return session;
  }

  /** PI's `switchSession` seam: the live PI engine for a key, never the Claude one. */
  private piEngine(key: string): PIEngineSession | undefined {
    const engine = this.sessions.get(key);
    return engine && engine.backend === 'pi' ? engine as PIEngineSession : undefined;
  }

  get(key: string): EngineSession | undefined {
    return this.sessions.get(key);
  }

  /** Graceful close of the pooled session for a key. The pool entry is dropped synchronously, so
   *  the next `acquire` opens a fresh session even while this one winds down. Never rejects — a
   *  close failure is logged, exactly as the pre-P2.2c wrappers did. Command handlers that must
   *  not block on a subprocess grace period call this fire-and-forget (`void engines.close(...)`). */
  async close(key: string): Promise<void> {
    const engine = this.sessions.get(key);
    if (!engine) return;
    this.sessions.delete(key);
    await engine.close()
      .catch((error) => log.warn(`close ${engine.backend} session ${key} failed: ${errorMessage(error)}`));
  }

  /** Hard-stop the pooled session for a key. Returns true when it killed one; the pool entry is
   *  dropped on a successful kill, matching each backend's old guarded `session.kill()` eviction. */
  kill(key: string): boolean {
    const engine = this.sessions.get(key);
    if (!engine) return false;
    const killed = engine.kill();
    if (killed) this.sessions.delete(key);
    return killed;
  }

  /** Close every pooled session whose key starts with the prefix (thread cleanup). */
  closeByPrefix(prefix: string): void {
    for (const key of [...this.sessions.keys()]) {
      if (key.startsWith(prefix)) void this.close(key);
    }
  }

  /** Close every pooled session on every backend (shutdown). */
  closeAll(): void {
    for (const key of [...this.sessions.keys()]) void this.close(key);
  }

  listKeys(): string[] {
    return [...this.sessions.keys()];
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
const CLAUDE_ENGINE_ADAPTER = getAdapter('claude');

/** The daemon's pool. Tests build their own `new SessionEngines({ pi })` or `{ claude }`. */
export const engines = new SessionEngines({
  pi: PI_ENGINE_ADAPTER,
  claude: CLAUDE_ENGINE_ADAPTER,
});

/**
 * Transitional (deleted with the pool seam in P4.1): the AgentAdapter-shaped view of the PI pool
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

/**
 * Transitional (deleted with the pool seam in P4.1): the AgentAdapter-shaped view of the Claude
 * pool the facade still calls `spawn()` on. `spawn` is exactly
 * `engines.acquire(spec).openLegacyProcess`.
 */
export const claudeRunAdapter: AgentAdapter = {
  backend: 'claude',
  capabilities: CLAUDE_ENGINE_ADAPTER.capabilities,
  spawn: (spec: EngineSpec): AgentProcess => engines.acquire(spec).openLegacyProcess(spec.engineKey),
  close: (key: string): Promise<void> => engines.close(key),
  kill: (key: string): boolean => engines.kill(key),
  listSessions: (): string[] => engines.listKeys(),
};

/** The run/compact adapter for a backend: the pool facade both backends now share. */
export function getRunAdapter(backend: Backend): AgentAdapter {
  return backend === 'pi' ? piRunAdapter : claudeRunAdapter;
}
