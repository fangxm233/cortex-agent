// input:  a PIAdapter over a fake runtime
// output: a per-instance SessionEngines over it — the pool a test drives engine sessions from
// pos:    Test seam for the PI pool: `open(spec)` is `SessionEngines.acquire(spec)`
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { SessionEngines } from '../../src/domain/runs/engines.js';
import type { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import type { PIEngineSession } from '../../src/agent-adapter/pi/engine.js';
import type { EngineSpec } from '../../src/agent-adapter/types.js';

export interface PIPool {
  engines: SessionEngines;
  /** The pooled PI engine session for a spec. This is the only surface a test should drive —
   *  `run()` is one turn, `steer()` is an injection, `close()` ends the pool entry. */
  open(spec: EngineSpec): PIEngineSession;
  close(key: string): void;
  kill(key: string): boolean;
  listSessions(): string[];
}

const pools = new WeakMap<PIAdapter, PIPool>();

/**
 * A `SessionEngines` over one adapter, cached per adapter so a test that opens twice on one key
 * still exercises pooling.
 *
 * It used to expose the pre-P2.2c `PIAdapter.spawn/close/kill/listSessions` surface through a
 * legacy `AgentProcess`. That surface is gone: `open()` hands back the engine, and a turn is
 * `engine.run(prompt, { awaitBackground })`.
 */
export function piPool(adapter: PIAdapter): PIPool {
  const existing = pools.get(adapter);
  if (existing) return existing;
  const engines = new SessionEngines({ pi: adapter });
  const pool: PIPool = {
    engines,
    // The pool dispatches on `spec.backend.kind`; this fixture is PI-only and the shared
    // `engineSpecFixture` defaults to Claude, so pin the discriminant before acquiring.
    open: (spec) => engines.acquire({ ...spec, backend: { kind: 'pi' } }) as PIEngineSession,
    close: (key) => void engines.close(key),
    kill: (key) => engines.kill(key),
    listSessions: () => engines.listKeys(),
  };
  pools.set(adapter, pool);
  return pool;
}
