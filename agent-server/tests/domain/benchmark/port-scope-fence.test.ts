import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getActiveHandle } from '../../../src/domain/threads/runner.js';
import {
  PORT_SCOPE_ESCAPED, PORT_SCOPE_ESCAPED_CODE, PortScopeEscapedError,
  failClosedRuntimeDeps, getLocalThreadRuntimeDeps, scopedLocalThreadService,
  withLocalThreadRuntimeDeps,
} from '../../../src/domain/threads/local-runtime-deps.js';
import type { LocalThreadRuntimeDeps } from '../../../src/domain/threads/local-runtime-deps.js';
import { createLocalThreadRuntimeDeps } from '../../../src/domain/threads/local-runtime-defaults.js';
import { runThread } from '../../../src/domain/threads/runner.js';
import { RunningExecutions } from '../../../src/core/running-executions.js';
import { BENCHMARK_FAILURES } from '../../../src/domain/benchmark/resolved-policy.js';

/** The daemon bundle exactly as `runBenchmarkThread` builds it
 *  (agent-run/benchmark-local-thread-orchestrator.ts:1089) — no test-supplied composition. */
function daemonBundle() {
  return createLocalThreadRuntimeDeps(runThread);
}

describe('I3 fail-closed port scope (§7.1, §7.4 code 32)', () => {
  describe('the daemon path keeps today\'s singleton fallback', () => {
    it('reads the daemon singleton through the shipped proxy with no scope installed', () => {
      expect(getActiveHandle('port-scope-fence-daemon')).toBeNull();
    });

    it('reads the daemon singleton from outside a NON fail-closed scope in flight', async () => {
      let seenOutside: unknown = 'unset';
      await withLocalThreadRuntimeDeps(daemonBundle(), async () => {
        seenOutside = await outsideScope(() => getActiveHandle('port-scope-fence-daemon'));
      });
      expect(seenOutside).toBeNull();
    });

    it('does not arm the fence for a bundle that never declares it', async () => {
      const deps = daemonBundle();
      expect(deps.portScope).toBeUndefined();
      const escaped = await escapeScope(deps);
      expect(escaped).toBeNull();
    });
  });

  /** §18 G5-D8(iii): the split of the daemon defaults out of the interface module is MECHANICAL.
   *  These pin the bundle `createLocalThreadRuntimeDeps` still returns, so a field silently lost
   *  or a default silently changed by the move fails here rather than at a benchmark trial. */
  describe('the mechanical split preserves the daemon bundle exactly', () => {
    it('returns the same fifteen fields it did before the move', () => {
      expect(Object.keys(daemonBundle()).sort()).toEqual([
        'cancelThread', 'createThread', 'emitLifecycleHooks', 'eventBus', 'executionLedger',
        'executionStore', 'getTemplate', 'liveExecutions', 'loadTemplates', 'resolveProfile',
        'resolveTemplateAgents', 'runAgent', 'runThread', 'sessionStore', 'threadStore',
      ]);
    });

    it('defaults eventBus to null, so P16 is unbound until a trial binds it (§7.2)', () => {
      expect(daemonBundle().eventBus).toBeNull();
    });

    it('lets an override win over every default', () => {
      const resolveProfile = (() => {
        throw new Error('sentinel resolveProfile');
      }) as unknown as LocalThreadRuntimeDeps['resolveProfile'];
      const emitLifecycleHooks = (async () => {
        throw new Error('sentinel emitLifecycleHooks');
      }) as LocalThreadRuntimeDeps['emitLifecycleHooks'];
      const deps = createLocalThreadRuntimeDeps(runThread, { resolveProfile, emitLifecycleHooks });
      expect(deps.resolveProfile).toBe(resolveProfile);
      expect(deps.emitLifecycleHooks).toBe(emitLifecycleHooks);
    });

    it('derives the execution ledger from an overridden store and live set', () => {
      const liveExecutions = new RunningExecutions();
      const deps = createLocalThreadRuntimeDeps(runThread, { liveExecutions });
      expect(deps.liveExecutions).toBe(liveExecutions);
      expect(typeof deps.executionLedger.teardownExecution).toBe('function');
    });
  });

  describe('a composite operation outside the scope throws port_scope_escaped', () => {
    it('throws from the shipped runner proxy, not from a test double', async () => {
      const error = await escapeScopeExpectingThrow(failClosedRuntimeDeps(daemonBundle()));
      expect(error).toBeInstanceOf(PortScopeEscapedError);
      expect((error as PortScopeEscapedError).code).toBe(32);
      expect((error as PortScopeEscapedError).reason).toBe(PORT_SCOPE_ESCAPED);
      expect((error as PortScopeEscapedError).failureClass).toBe('R');
    });

    it('names the port whose read escaped', async () => {
      const error = await escapeScopeExpectingThrow(failClosedRuntimeDeps(daemonBundle()));
      expect((error as PortScopeEscapedError).port).toBe('getByChannel');
    });

    it('throws on every escaped read, not only the first', async () => {
      const ports = failClosedRuntimeDeps(daemonBundle());
      const thrown: unknown[] = [];
      await withLocalThreadRuntimeDeps(ports, async () => {
        for (let i = 0; i < 3; i += 1) {
          thrown.push(await outsideScope(() => getActiveHandle('x')).catch(e => e));
        }
      });
      expect(thrown.every(e => e instanceof PortScopeEscapedError)).toBe(true);
    });

    it('serves the trial port to code that stayed INSIDE the scope', async () => {
      const trialLive = new RunningExecutions();
      const ports = failClosedRuntimeDeps({ ...daemonBundle(), liveExecutions: trialLive });
      let inside: unknown = 'unset';
      await withLocalThreadRuntimeDeps(ports, async () => {
        await Promise.resolve();
        inside = getActiveHandle('port-scope-fence-inside');
        expect(getLocalThreadRuntimeDeps()?.liveExecutions).toBe(trialLive);
      });
      expect(inside).toBeNull();
    });
  });

  describe('the fence is scoped to the trial, not latched for the process', () => {
    it('releases when the fail-closed scope resolves', async () => {
      await withLocalThreadRuntimeDeps(failClosedRuntimeDeps(daemonBundle()), async () => {});
      expect(getActiveHandle('port-scope-fence-after')).toBeNull();
    });

    it('releases when the fail-closed scope rejects', async () => {
      await expect(withLocalThreadRuntimeDeps(
        failClosedRuntimeDeps(daemonBundle()),
        async () => { throw new Error('trial failed'); },
      )).rejects.toThrow('trial failed');
      expect(getActiveHandle('port-scope-fence-after-reject')).toBeNull();
    });

    it('releases when the scoped action throws synchronously', async () => {
      expect(() => withLocalThreadRuntimeDeps(
        failClosedRuntimeDeps(daemonBundle()),
        (() => { throw new Error('sync boom'); }) as () => Promise<void>,
      )).toThrow('sync boom');
      expect(getActiveHandle('port-scope-fence-after-sync')).toBeNull();
    });

    it('stays armed while a second trial is still in flight', async () => {
      const outer = failClosedRuntimeDeps(daemonBundle());
      const inner = failClosedRuntimeDeps(daemonBundle());
      let stillFenced: unknown = 'unset';
      await withLocalThreadRuntimeDeps(outer, async () => {
        await withLocalThreadRuntimeDeps(inner, async () => {});
        stillFenced = await outsideScope(() => getActiveHandle('x')).catch(e => e);
      });
      expect(stillFenced).toBeInstanceOf(PortScopeEscapedError);
      expect(getActiveHandle('port-scope-fence-both-done')).toBeNull();
    });
  });

  describe('the code is the registry\'s, not a second one minted here', () => {
    it('pins PORT_SCOPE_ESCAPED_CODE to the §7.4 registry entry', () => {
      const registered = BENCHMARK_FAILURES.find(f => f.reason === PORT_SCOPE_ESCAPED);
      expect(registered).toBeDefined();
      expect(PORT_SCOPE_ESCAPED_CODE).toBe(registered!.code);
      expect(registered!.failureClass).toBe('R');
    });

    it('leaves the §2.6 range at a contiguous 1-44 with 31 and 32 both Class R', () => {
      const codes = BENCHMARK_FAILURES.map(f => f.code);
      expect(codes).toEqual(Array.from({ length: 44 }, (_, i) => i + 1));
      expect(BENCHMARK_FAILURES.find(f => f.code === 31)!.reason).toBe('runtime_port_unbound');
      expect(BENCHMARK_FAILURES.find(f => f.code === 31)!.failureClass).toBe('R');
      expect(BENCHMARK_FAILURES.find(f => f.code === 32)!.reason).toBe('port_scope_escaped');
      expect(BENCHMARK_FAILURES.find(f => f.code === 32)!.failureClass).toBe('R');
    });
  });

  describe('the interface module reaches no daemon singleton', () => {
    it('imports only the runtime scope module', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync(
        new URL('../../../src/domain/threads/local-runtime-deps.ts', import.meta.url), 'utf8',
      );
      const specifiers = [...source.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort();
      expect(specifiers).toEqual([
        '../../core/running-executions.js',
        '../../core/types/agent-types.js',
        '../../core/types/thread-types.js',
        '../agents/profile-manager.js',
        '../agents/spawn-config.js',
        './local-runtime-scope.js',
      ]);
    });
  });

  describe('a bare scopedLocalThreadService behaves the same way', () => {
    it('falls back for the daemon and throws for a fail-closed trial', async () => {
      const fallback = { tag: () => 'daemon' };
      const service = scopedLocalThreadService(fallback, () => ({ tag: () => 'trial' }));
      expect(service.tag()).toBe('daemon');
      await withLocalThreadRuntimeDeps(failClosedRuntimeDeps(daemonBundle()), async () => {
        await expect(outsideScope(() => service.tag())).rejects.toBeInstanceOf(PortScopeEscapedError);
      });
      expect(service.tag()).toBe('daemon');
    });
  });
});

/** A pump armed in the ROOT async context, before any port scope exists — the same shape as the
 *  daemon's own module-level waiting-manager sweep (`thread-callback.ts:701`). Work it runs
 *  therefore carries no async-local scope, which is exactly how a composite path reaches a host
 *  store with a perfectly clean import graph. `setTimeout` from inside a scope would NOT model an
 *  escape: AsyncLocalStorage propagates into timers created within the scope. */
interface RootJob { action: () => unknown; settle: (outcome: () => unknown) => void }
const rootQueue: RootJob[] = [];
let rootPump: ReturnType<typeof setInterval> | null = null;

beforeAll(() => {
  rootPump = setInterval(() => {
    while (rootQueue.length) {
      const job = rootQueue.shift()!;
      try {
        const value = job.action();
        job.settle(() => value);
      } catch (error) {
        job.settle(() => { throw error; });
      }
    }
  }, 1);
  rootPump.unref?.();
});

afterAll(() => { if (rootPump) clearInterval(rootPump); });

function outsideScope<T>(action: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    rootQueue.push({
      action,
      settle: outcome => { try { resolve(outcome() as T); } catch (error) { reject(error); } },
    });
  });
}

async function escapeScope(deps: Parameters<typeof withLocalThreadRuntimeDeps>[0]) {
  let seen: unknown;
  await withLocalThreadRuntimeDeps(deps, async () => {
    seen = await outsideScope(() => getActiveHandle('port-scope-fence-escape'));
  });
  return seen;
}

async function escapeScopeExpectingThrow(deps: Parameters<typeof withLocalThreadRuntimeDeps>[0]) {
  let caught: unknown;
  await withLocalThreadRuntimeDeps(deps, async () => {
    caught = await outsideScope(() => getActiveHandle('port-scope-fence-escape')).catch(e => e);
  });
  return caught;
}
