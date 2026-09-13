// input:  a ClaudeAdapter
// output: a per-instance SessionEngines over it — the pool a test drives engine sessions from
// pos:    Test seam for the Claude pool: `open(spec)` is `SessionEngines.acquire(spec)`
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { SessionEngines } from '../../src/domain/runs/engines.js';
import type { ClaudeAdapter } from '../../src/agent-adapter/claude/adapter.js';
import type { ClaudeEngineSession } from '../../src/agent-adapter/claude/engine.js';
import type { EngineSpec } from '../../src/agent-adapter/types.js';

export interface ClaudePool {
  engines: SessionEngines;
  /** The pooled engine session for a spec: reuse when it is alive and identical, else open fresh.
   *  This is the only surface a test should drive — `run()` is one turn, `close()` ends the pool
   *  entry, and the events/policy questions belong to the engine, not to a process handle. */
  open(spec: EngineSpec): ClaudeEngineSession;
  close(key: string): Promise<void>;
  kill(key: string): boolean;
  listSessions(): string[];
  /** The pooled `ClaudeSession` inside the pooled engine. */
  getPooledSession(key: string): unknown;
}

const pools = new WeakMap<ClaudeAdapter, ClaudePool>();

/**
 * A `SessionEngines` over one adapter, cached per adapter so a test that opens twice on one key
 * still exercises pooling (the second call reuses the first session).
 *
 * It used to expose the pre-P2.3c `ClaudeAdapter.spawn/close/kill/listSessions` surface through a
 * legacy `AgentProcess`. That surface is gone: `open()` hands back the engine, and a turn is
 * `engine.run(prompt, { awaitBackground })`.
 */
export function claudePool(adapter: ClaudeAdapter): ClaudePool {
  const existing = pools.get(adapter);
  if (existing) return existing;
  const engines = new SessionEngines({ claude: adapter });
  const pool: ClaudePool = {
    engines,
    open: (spec) => engines.acquire(spec) as ClaudeEngineSession,
    close: (key) => engines.close(key),
    kill: (key) => engines.kill(key),
    listSessions: () => engines.listKeys(),
    // The pool stores the engine; `_test.getPooledPrintSession` handed back the ClaudeSession
    // inside it. Reach through the engine so tests keep comparing the objects they used to.
    getPooledSession: (key) => (engines.get(key) as any)?.session,
  };
  pools.set(adapter, pool);
  return pool;
}
