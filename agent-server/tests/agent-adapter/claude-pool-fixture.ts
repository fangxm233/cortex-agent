// input:  a ClaudeAdapter
// output: a per-instance SessionEngines with the pre-P2.3c Claude pool ergonomics for tests
// pos:    P2.3c test seam: the pool moved out of ClaudeAdapter into SessionEngines
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { SessionEngines } from '../../src/domain/runs/engines.js';
import type { ClaudeAdapter } from '../../src/agent-adapter/claude/adapter.js';
import type { AgentAdapter, AgentProcess, EngineSpec } from '../../src/agent-adapter/types.js';

export interface ClaudePool {
  engines: SessionEngines;
  spawn(spec: EngineSpec): AgentProcess;
  close(key: string): Promise<void>;
  kill(key: string): boolean;
  listSessions(): string[];
  /** The pooled `ClaudeSession` — exactly what `_test.getPooledPrintSession` used to answer. */
  getPooledSession(key: string): unknown;
  /** The facade still calls `spawn()` on an AgentAdapter; this is the pool in that shape. */
  asAdapter(): AgentAdapter;
}

const pools = new WeakMap<ClaudeAdapter, ClaudePool>();

/**
 * The pre-P2.3c `ClaudeAdapter.spawn/close/kill/listSessions` surface, now backed by the pool the
 * slice moved into `SessionEngines`. Cached per adapter so a test that spawns twice on one key
 * still exercises pooling. Tests keep their assertions; only the object under test moves.
 */
export function claudePool(adapter: ClaudeAdapter): ClaudePool {
  const existing = pools.get(adapter);
  if (existing) return existing;
  const engines = new SessionEngines({ claude: adapter });
  const pool: ClaudePool = {
    engines,
    spawn: (spec) => engines.acquire(spec).openLegacyProcess(spec.engineKey),
    close: (key) => engines.close(key),
    kill: (key) => engines.kill(key),
    listSessions: () => engines.listKeys(),
    // The pool stores the engine; `_test.getPooledPrintSession` handed back the ClaudeSession
    // inside it. Reach through the engine so tests keep comparing the objects they used to.
    getPooledSession: (key) => (engines.get(key) as any)?.session,
    asAdapter: () => ({
      backend: 'claude',
      capabilities: adapter.capabilities,
      spawn: (spec: EngineSpec): AgentProcess => engines.acquire(spec).openLegacyProcess(spec.engineKey),
      close: (key: string): Promise<void> => engines.close(key),
      kill: (key: string): boolean => engines.kill(key),
      listSessions: (): string[] => engines.listKeys(),
    }),
  };
  pools.set(adapter, pool);
  return pool;
}
