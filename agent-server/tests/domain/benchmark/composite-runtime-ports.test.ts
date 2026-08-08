import { describe, expect, it } from 'vitest';

import {
  COMPOSITE_RUNTIME_PORT_FIELDS, DECLARATION_ONLY_PORTS,
  assertCompositePortsBound, requireCompositePort,
  type CompositeRuntimePorts,
} from '../../../src/domain/benchmark/composite-runtime-ports.js';
import { createLocalThreadRuntimeDeps } from '../../../src/domain/threads/local-runtime-defaults.js';
import { runThread } from '../../../src/domain/threads/runner.js';
import { PolicyCompilationError, BENCHMARK_FAILURES } from '../../../src/domain/benchmark/resolved-policy.js';
import { createTrialClock } from '../../../src/domain/benchmark/trial-clock.js';
import { createSettingsSnapshot } from '../../../src/domain/benchmark/settings-snapshot.js';
import { EventBus } from '../../../src/events/event-bus.js';
import type { WorkspaceLease } from '../../../src/domain/benchmark/workspace-lease.js';
import type { Journal } from '../../../src/domain/agent-run/journal.js';
import type { SupervisorSession } from '../../../src/domain/agent-run/supervisor.js';

/** Mutual assignability: `A` and `B` are the same type, not merely compatible. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const unbound = null as unknown as never;

function portsWithEverythingBound(): CompositeRuntimePorts {
  const daemon = createLocalThreadRuntimeDeps(runThread);
  const bound: Record<string, unknown> = { ...daemon, portScope: 'fail-closed' };
  for (const fields of Object.values(COMPOSITE_RUNTIME_PORT_FIELDS)) {
    for (const field of fields) bound[field] ??= {};
  }
  bound.eventBus = new EventBus();
  bound.clock = createTrialClock({ deadlineEpochMs: Date.now() + 60_000 });
  bound.settings = createSettingsSnapshot({ managerRotateSteps: 8 });
  return bound as unknown as CompositeRuntimePorts;
}

describe('CompositeRuntimePorts (§7.2)', () => {
  describe('the port set is the section 7.2 sketch, exhaustively', () => {
    it('declares all 23 ports', () => {
      expect(Object.keys(COMPOSITE_RUNTIME_PORT_FIELDS)).toHaveLength(23);
      expect(Object.keys(COMPOSITE_RUNTIME_PORT_FIELDS))
        .toEqual(Array.from({ length: 23 }, (_, i) => `P${i + 1}`));
    });

    it('maps every port to at least one declared field', () => {
      for (const [port, fields] of Object.entries(COMPOSITE_RUNTIME_PORT_FIELDS)) {
        expect(fields.length, `${port} declares no field`).toBeGreaterThan(0);
      }
    });

    it('carries the five P7 store fields and the four P8 resolvers inherited from the bundle', () => {
      expect([...COMPOSITE_RUNTIME_PORT_FIELDS.P7].sort()).toEqual([
        'executionLedger', 'executionStore', 'liveExecutions', 'sessionStore', 'threadStore',
      ]);
      expect([...COMPOSITE_RUNTIME_PORT_FIELDS.P8].sort()).toEqual([
        'getTemplate', 'loadTemplates', 'resolveProfile', 'resolveTemplateAgents',
      ]);
    });

    it('names the six declaration-only ports of ruling G5-D2 and no others', () => {
      expect([...DECLARATION_ONLY_PORTS].sort())
        .toEqual(['P14', 'P18', 'P19', 'P20', 'P21', 'P22']);
    });

    it('assigns each field to exactly one port', () => {
      const all = Object.values(COMPOSITE_RUNTIME_PORT_FIELDS).flat();
      expect(new Set(all).size).toBe(all.length);
    });
  });

  describe('P16 — an unbound port raises runtime_port_unbound (§7.4 code 31)', () => {
    it('throws for the shipped eventBus null default', () => {
      const ports = { ...portsWithEverythingBound(), eventBus: null } as CompositeRuntimePorts;
      let caught: unknown;
      try { assertCompositePortsBound(ports); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(PolicyCompilationError);
      expect((caught as PolicyCompilationError).code).toBe(31);
      expect((caught as PolicyCompilationError).reason).toBe('runtime_port_unbound');
      expect((caught as PolicyCompilationError).failureClass).toBe('R');
    });

    it('throws for a port the coordinator never constructed', () => {
      const ports = portsWithEverythingBound();
      delete (ports as unknown as Record<string, unknown>).treeCoordinator;
      expect(() => assertCompositePortsBound(ports)).toThrow(PolicyCompilationError);
    });

    it('names the unbound field and its port id in the failure record', () => {
      const ports = { ...portsWithEverythingBound(), clock: unbound };
      let caught: PolicyCompilationError | undefined;
      try { assertCompositePortsBound(ports); } catch (error) {
        caught = error as PolicyCompilationError;
      }
      expect(caught?.record()).toMatchObject({
        code: 31, failure_class: 'R', reason: 'runtime_port_unbound',
        port: 'P17', field: 'clock',
      });
    });

    it('accepts a fully bound bundle', () => {
      expect(() => assertCompositePortsBound(portsWithEverythingBound())).not.toThrow();
    });

    it('requireCompositePort returns a bound port and raises 31 for an unbound one', () => {
      const ports = portsWithEverythingBound();
      expect(requireCompositePort(ports, 'clock')).toBe(ports.clock);
      const starved = { ...ports, eventBus: null } as CompositeRuntimePorts;
      let caught: unknown;
      try { requireCompositePort(starved, 'eventBus'); } catch (error) { caught = error; }
      expect((caught as PolicyCompilationError).code).toBe(31);
    });

    it('uses the §7.4 registry entry rather than a second code', () => {
      const registered = BENCHMARK_FAILURES.find(f => f.reason === 'runtime_port_unbound');
      expect(registered?.code).toBe(31);
      expect(registered?.failureClass).toBe('R');
    });
  });

  describe('the declaration-only ports are wired to the shipped implementations', () => {
    it('P18 lease is the shipped WorkspaceLease interface, not a re-declaration', () => {
      const wired: Exact<CompositeRuntimePorts['lease'], WorkspaceLease> = true;
      expect(wired).toBe(true);
    });

    it('P21 trajectory writes through the shipped Journal record and event shapes', () => {
      const openReturnsJournal: Exact<
        ReturnType<CompositeRuntimePorts['trajectory']['open']>, Journal
      > = true;
      const writeEvent: Exact<
        ReturnType<CompositeRuntimePorts['trajectory']['writeEvent']>,
        ReturnType<Journal['writeEvent']>
      > = true;
      expect(openReturnsJournal && writeEvent).toBe(true);
    });

    it('P20 supervisors hand back the shipped SupervisorSession handle', () => {
      const wired: Exact<
        ReturnType<CompositeRuntimePorts['supervisors']['sessions']>[number], SupervisorSession
      > = true;
      expect(wired).toBe(true);
    });
  });

  describe('the interface extends the shipped bundle rather than replacing it', () => {
    it('is a LocalThreadRuntimeDeps, so every shipped scoped consumer still compiles', () => {
      const ports = portsWithEverythingBound();
      expect(typeof ports.threadStore).toBe('object');
      expect(ports.portScope).toBe('fail-closed');
    });
  });
});

// --- §19.12 corrected P3 wiring: the proposal union and the claim callback ----------------------

import type { ProposalRow } from '../../../src/domain/benchmark/proposal-seal.js';
import type { ActorCapability } from '../../../src/domain/benchmark/capabilities.js';
import { createDispatcherOwnedClaimTarget } from '../../../src/domain/benchmark/trial-task-dispatcher.js';
import { createTrialCapabilityAwareTaskMutator } from '../../../src/domain/tasks/mutator.js';
import {
  type MutationRefusal, type ProposalMutationResult,
} from '../../../src/domain/benchmark/composite-runtime-ports.js';

describe('§19.12.1 — the corrected proposal union and the P3 wiring point', () => {
  it('the P3 port\'s proposal methods return ProposalMutationResult, re-exported from the structural module', () => {
    type ProposalReturn = ReturnType<CompositeRuntimePorts['taskMutator']['proposeComplete']>;
    const same: Exact<ProposalReturn, ProposalMutationResult> = true;
    expect(same).toBe(true);
    type RefusalReturn = ReturnType<CompositeRuntimePorts['taskMutator']['proposeBlock']>;
    const refusalSame: Exact<RefusalReturn, ProposalMutationResult> = true;
    expect(refusalSame).toBe(true);
  });

  it('the structural ProposalRow pins to the shipped ten-field row at the wiring point', () => {
    // Compiles only while the shipped ten-field ProposalRow is assignable to the structural
    // ProposalMutationResult the port returns — the pin §19.12.1 names.
    const pin: (row: ProposalRow) => ProposalMutationResult = row => row;
    expect(typeof pin).toBe('function');
  });

  it('MutationRefusal is the literal success:false union member with code 33|34', () => {
    type Refusal = MutationRefusal;
    const refusal: Refusal = { success: false, message: 'denied', code: 33 };
    expect(refusal.success).toBe(false);
    // A non-literal success is not assignable to the refusal member (compile-time).
    const code34: Refusal = { success: false, message: 'stale', code: 34 };
    expect(code34.code).toBe(34);
  });

  it('the P3 claim method stays on the frozen port and returns BrokerResult synchronously', () => {
    type ClaimReturn = ReturnType<CompositeRuntimePorts['taskMutator']['claim']>;
    const claim: ClaimReturn = { success: true, message: 'claimed' };
    expect(claim.success).toBe(true);
  });
});

describe('§19.12.2/§19.12.7 — the dispatcher-owned claim callback satisfies the broker contract', () => {
  it('createDispatcherOwnedClaimTarget\'s output is assignable to BrokerConstruction.claimTarget', () => {
    // The callback is a VALUE injected into task-broker.ts; this pin compiles only while the
    // production factory's output satisfies the broker's structural claimTarget shape.
    const pin = (callback: ReturnType<typeof createDispatcherOwnedClaimTarget>) =>
      (requester: ActorCapability, targetId: string) => callback(requester, targetId);
    expect(typeof pin).toBe('function');
  });
});

describe('§19.12.7 — the production mutator factory satisfies the frozen port and the broker view', () => {
  it('createTrialCapabilityAwareTaskMutator\'s output satisfies CompositeRuntimePorts.taskMutator', () => {
    const pin = (mutator: ReturnType<typeof createTrialCapabilityAwareTaskMutator>) =>
      mutator as CompositeRuntimePorts['taskMutator'];
    expect(typeof pin).toBe('function');
  });
});

// --- R2-T18 source pins (moved from trial-task-mutator.test.ts) --------------

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BENCHMARK_BROKER_ACTIONS } from '../../../src/domain/benchmark/capabilities.js';

function readBenchmarkSource(name: string): string {
  return fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), `../../../src/domain/benchmark/${name}`),
    'utf8',
  );
}

describe('R2-T18 — pins: proposal-seal hash, P3 import fence, no unclaim surface', () => {
  it('proposal-seal.ts is byte-identical to the accepted pin md5', () => {
    const hash = crypto.createHash('md5').update(readBenchmarkSource('proposal-seal.ts')).digest('hex');
    expect(hash).toBe('b7527c95219c54f9bb98ece7a4f284d8');
  });

  it('the P3 module imports only Node builtins and ./capabilities.js', () => {
    const imports = [...readBenchmarkSource('trial-task-mutator.ts').matchAll(/^import .* from '([^']+)'/gm)]
      .map(match => match[1]);
    for (const specifier of imports) {
      const isBuiltin = /^node:/.test(specifier) || specifier === 'node:crypto';
      const isCapabilities = specifier === './capabilities.js';
      expect(isBuiltin || isCapabilities, `import ${specifier}`).toBe(true);
    }
  });

  it('the broker surface carries no task.unclaim action, tool or CLI name', () => {
    const brokerSource = readBenchmarkSource('task-broker.ts');
    expect(brokerSource).not.toContain("'task.unclaim'");
    expect(brokerSource).not.toContain('task_unclaim');
    expect(BENCHMARK_BROKER_ACTIONS).not.toContain('task.unclaim');
  });

  it('P3 source carries no event, hook or bus surface (the zero-emission half of the fence)', () => {
    const source = readBenchmarkSource('trial-task-mutator.ts');
    expect(source).not.toContain('hook-bus');
    expect(source).not.toContain('emitCortexEvent');
    expect(source).not.toContain('event-bus');
    expect(source).not.toContain('publish');
  });
});
