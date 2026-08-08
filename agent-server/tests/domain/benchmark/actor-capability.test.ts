// input:  §8.2's token, its mint and the ambient registry/scope seam
// output: token-shape, mint-invariant, registry-lifetime and I3 fail-closed contract tests
// pos:    §8.2 + §18 G5-W4 — the capability is minted by the coordinator and is never an argument
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { describe, expect, it } from 'vitest';

import {
  ACTOR_CAPABILITY_FIELDS, BENCHMARK_BROKER_ACTIONS,
  ActorCapabilityMintError, ROLE_SLOTS, capabilityWhitelistForArm, mintActorCapability,
  type ActorCapability, type ActorCapabilityMintRequest, type BenchmarkBrokerCapability,
} from '../../../src/domain/benchmark/capabilities.js';
import {
  createActorCapabilityRegistry, requireAmbientCapability,
  type ActorCapabilityRegistry,
} from '../../../src/domain/benchmark/actor-capability-scope.js';
import { PolicyCompilationError } from '../../../src/domain/benchmark/resolved-policy.js';
import type { ArmDefinition } from '../../../src/domain/benchmark/arm-schema.js';

const TRIAL_ID = 'trial-1';
const WHITELIST = capabilityWhitelistForArm({
  kind: 'cortex',
  orchestration: { mode: 'manager', ask_manager: true },
} as unknown as ArmDefinition);

function mintRequest(
  overrides: Partial<ActorCapabilityMintRequest> = {},
): ActorCapabilityMintRequest {
  return {
    trial_id: TRIAL_ID,
    task_id: 'aaaa',
    dispatch_generation: 'gen-1',
    attempt_id: 'attempt-1',
    role: 'manager',
    ancestry: ['root', 'bbbb'],
    capability_whitelist: WHITELIST,
    issued_at_epoch_ms: 1_000,
    ...overrides,
  };
}

describe('§8.2 the ActorCapability token, in the shipped capabilities.ts', () => {
  it('is the ONLY capability token: the shipped ten-action union is reused, not re-derived', () => {
    // The union and the runtime array must name exactly the same ten actions, in the matrix's own
    // order (§8.3, design:2412-2423). A member added to one and not the other fails to compile
    // (`BrokerActionsAreExhaustive`), and this test pins the two lists against each other.
    const actions = BENCHMARK_BROKER_ACTIONS;
    expect(actions).toEqual([
      'task.read', 'task.create', 'task.decompose', 'task.claim', 'task.propose_complete',
      'task.propose_block', 'artifact.write', 'dependency.declare', 'qa.ask', 'qa.answer',
    ]);
    const unionMembers: BenchmarkBrokerCapability[] = [
      'task.read', 'task.create', 'task.decompose', 'task.claim', 'task.propose_complete',
      'task.propose_block', 'artifact.write', 'dependency.declare', 'qa.ask', 'qa.answer',
    ];
    expect(actions).toEqual(unionMembers);
    expect(actions).toHaveLength(10);
    // The closed list deliberately carries no task.complete, task.block or task.uncomplete: sealing
    // is the coordinator's act (§8.6, design:2425-2428).
    expect(actions).not.toContain('task.complete');
    expect(actions).not.toContain('task.block');
    expect(actions).not.toContain('task.uncomplete');
  });

  it('defines RoleSlot as §8.2\'s own five members', () => {
    expect(ROLE_SLOTS).toEqual(['parent', 'manager', 'coder', 'reviewer', 'verifier']);
  });

  it('carries exactly §8.2\'s nine fields, exhaustively', () => {
    expect(ACTOR_CAPABILITY_FIELDS).toEqual([
      'token_id', 'trial_id', 'task_id', 'dispatch_generation', 'attempt_id',
      'role', 'ancestry', 'allowed_actions', 'issued_at_epoch_ms',
    ]);
    const token = mintActorCapability(mintRequest());
    expect(Object.keys(token).sort()).toEqual([...ACTOR_CAPABILITY_FIELDS].sort());
  });

  it('mints a token with an unforgeable random token_id, frozen', () => {
    const a = mintActorCapability(mintRequest());
    const b = mintActorCapability(mintRequest());
    expect(a.token_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.token_id).not.toBe(b.token_id);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.ancestry)).toBe(true);
  });

  it('enforces allowed_actions ⊆ capability_whitelist at mint (§8.2)', () => {
    expect(() => mintActorCapability(mintRequest({
      allowed_actions: ['qa.answer'],
    }))).not.toThrow();
    expect(() => mintActorCapability(mintRequest({
      allowed_actions: ['task.complete' as BenchmarkBrokerCapability],
    }))).toThrow(ActorCapabilityMintError);
  });

  it('omitting allowed_actions grants exactly the whitelist', () => {
    const token = mintActorCapability(mintRequest());
    expect([...token.allowed_actions]).toEqual([...WHITELIST]);
  });

  it('rejects a non-slot role and a self-inclusive ancestry at mint', () => {
    expect(() => mintActorCapability(mintRequest({ role: 'janitor' as never })))
      .toThrow(ActorCapabilityMintError);
    expect(() => mintActorCapability(mintRequest({ ancestry: ['root', 'aaaa'] })))
      .toThrow(ActorCapabilityMintError);
  });

  it('seals allowed_actions: no holder can widen or narrow the set in place', () => {
    const token = mintActorCapability(mintRequest());
    const set = token.allowed_actions as ReadonlySet<BenchmarkBrokerCapability> & {
      add(value: BenchmarkBrokerCapability): unknown;
      delete(value: BenchmarkBrokerCapability): unknown;
      clear(): unknown;
    };
    expect(() => set.add('qa.ask')).toThrow();
    expect(() => set.delete('qa.ask')).toThrow();
    expect(() => set.clear()).toThrow();
    expect(() => Set.prototype.add.call(set, 'task.complete')).toThrow(TypeError);
    expect([...set]).not.toContain('task.complete');
  });
});

describe('§18 G5-W4 the ambient resolution seam', () => {
  function registry(): ActorCapabilityRegistry {
    return createActorCapabilityRegistry(TRIAL_ID);
  }

  it('register binds exactly one channel handle to a coordinator-minted capability', () => {
    const table = registry();
    const capability = mintActorCapability(mintRequest());
    const handle = table.register(capability);
    expect(handle).toMatch(/^[0-9a-f-]{36}$/);
    expect(table.resolveChannel(handle)).toBe(capability);
    expect(table.isLive(capability.token_id)).toBe(true);
    expect(() => table.register(capability)).toThrow(ActorCapabilityMintError);
  });

  it('register refuses a structurally forged token that did not come from the production mint', () => {
    const table = registry();
    const minted = mintActorCapability(mintRequest());
    const forged = Object.freeze({ ...minted, token_id: 'forged-token' });
    expect(() => table.register(forged)).toThrow(ActorCapabilityMintError);
    expect(table.liveCount()).toBe(0);
  });

  it('a coordinator serves exactly one trial: registering a wrong-trial token is a mint error', () => {
    const table = registry();
    const capability = mintActorCapability(mintRequest({ trial_id: 'other-trial' }));
    expect(() => table.register(capability)).toThrow(ActorCapabilityMintError);
  });

  it('resolveChannel returns null for an unregistered, closed or invalidated channel (G5-W6.7)', () => {
    const table = registry();
    const capability = mintActorCapability(mintRequest());
    const handle = table.register(capability);
    expect(table.resolveChannel('no-such-channel')).toBeNull();
    table.invalidateToken(capability.token_id);
    expect(table.resolveChannel(handle)).toBeNull();
    expect(table.isLive(capability.token_id)).toBe(false);
  });

  it('invalidateAttempt drops every token of an attempt; invalidateTrial drops all (§8.2 lifetime)', () => {
    const table = registry();
    const firstCap = mintActorCapability(mintRequest({ attempt_id: 'attempt-1' }));
    const secondCap = mintActorCapability(mintRequest({ attempt_id: 'attempt-2' }));
    table.register(firstCap);
    table.register(secondCap);
    table.invalidateAttempt('attempt-1');
    expect(table.isLive(firstCap.token_id)).toBe(false);
    expect(table.isLive(secondCap.token_id)).toBe(true);
    table.invalidateTrial();
    expect(table.isLive(secondCap.token_id)).toBe(false);
    expect(table.liveCount()).toBe(0);
  });

  it('invalidateSupersededGeneration drops tokens of superseded generations, keeps the current one', () => {
    const table = registry();
    const oldCap = mintActorCapability(mintRequest({ dispatch_generation: 'gen-0' }));
    const currentCap = mintActorCapability(mintRequest({ dispatch_generation: 'gen-1' }));
    table.register(oldCap);
    table.register(currentCap);
    table.invalidateSupersededGeneration('aaaa', 'gen-1');
    expect(table.isLive(oldCap.token_id)).toBe(false);
    expect(table.isLive(currentCap.token_id)).toBe(true);
  });

  it('records the current attempt per task at register — the "task\'s current attempt" R1 compares', () => {
    const table = registry();
    expect(table.currentAttempt('aaaa')).toBeNull();
    const firstCap = mintActorCapability(mintRequest({ attempt_id: 'attempt-1' }));
    table.register(firstCap);
    expect(table.currentAttempt('aaaa')).toEqual({ dispatch_generation: 'gen-1', attempt_id: 'attempt-1' });
    const secondCap = mintActorCapability(mintRequest({ attempt_id: 'attempt-2' }));
    table.register(secondCap);
    expect(table.currentAttempt('aaaa')).toEqual({ dispatch_generation: 'gen-1', attempt_id: 'attempt-2' });
    expect(table.isLive(firstCap.token_id)).toBe(true);
    expect(table.isLive(secondCap.token_id)).toBe(true);
  });

  it('runInScope makes the capability ambient; currentCapability reads it back', async () => {
    const table = registry();
    const capability = mintActorCapability(mintRequest());
    table.register(capability);
    expect(table.currentCapability()).toBeNull();
    let seen: ActorCapability | null = null;
    await table.runInScope(capability, async () => {
      seen = table.currentCapability();
      expect(table.currentCapability()).toBe(capability);
    });
    expect(seen).toBe(capability);
    expect(table.currentCapability()).toBeNull();
  });

  it('runInScope refuses a token that is not in the live set (sidecar_unauthenticated, code 27)', async () => {
    const table = registry();
    const capability = mintActorCapability(mintRequest());
    // Never registered: not live.
    await expect(table.runInScope(capability, async () => 1)).rejects.toThrow(
      PolicyCompilationError,
    );
  });

  it('runInScope resolves the registered token object, never a forged clone with the same token_id', async () => {
    const table = registry();
    const capability = mintActorCapability(mintRequest({ allowed_actions: ['task.read'] }));
    table.register(capability);
    const widenedClone = Object.freeze({
      ...capability,
      allowed_actions: new Set<BenchmarkBrokerCapability>(['task.read', 'task.create']),
    });
    await expect(table.runInScope(widenedClone, async () => 1)).rejects.toThrow(
      PolicyCompilationError,
    );
    expect(table.currentCapability()).toBeNull();
  });

  it('I3 fail-closed: requireAmbientCapability outside any scope throws port_scope_escaped (32)', () => {
    const table = registry();
    let thrown: PolicyCompilationError | null = null;
    try {
      requireAmbientCapability(table);
    } catch (error) {
      thrown = error as PolicyCompilationError;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.reason).toBe('port_scope_escaped');
    expect(thrown!.code).toBe(32);
  });

  it('requireAmbientCapability inside a scope returns the ambient capability', async () => {
    const table = registry();
    const capability = mintActorCapability(mintRequest());
    table.register(capability);
    await table.runInScope(capability, async () => {
      expect(requireAmbientCapability(table)).toBe(capability);
    });
  });
});
