// input:  a PIAdapter over a fake runtime
// output: a per-instance SessionEngines with the pre-P2.2c pool ergonomics for tests
// pos:    P2.2c test seam: the pool moved out of PIAdapter into SessionEngines
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { SessionEngines } from '../../src/domain/runs/engines.js';
import type { PIAdapter, PIAgentProcess } from '../../src/agent-adapter/pi/adapter.js';
import type { EngineSpec } from '../../src/agent-adapter/types.js';

interface PIPool {
  engines: SessionEngines;
  spawn(spec: EngineSpec): PIAgentProcess;
  close(key: string): void;
  kill(key: string): boolean;
  listSessions(): string[];
}

const pools = new WeakMap<PIAdapter, PIPool>();

/**
 * The pre-P2.2c `PIAdapter.spawn/close/kill/listSessions` surface, now backed by the pool the
 * slice moved into `SessionEngines`. Cached per adapter so a test that spawns twice on one key
 * still exercises pooling. Tests keep their assertions; only the object under test moves.
 */
export function piPool(adapter: PIAdapter): PIPool {
  const existing = pools.get(adapter);
  if (existing) return existing;
  const engines = new SessionEngines({ pi: adapter });
  const pool: PIPool = {
    engines,
    spawn: (spec) => engines.acquire(spec).openLegacyProcess(spec.engineKey),
    close: (key) => engines.close(key),
    kill: (key) => engines.kill(key),
    listSessions: () => engines.listKeys(),
  };
  pools.set(adapter, pool);
  return pool;
}
