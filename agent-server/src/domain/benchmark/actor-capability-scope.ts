// input:  capabilities the coordinator minted, and the channel or scope a broker call arrived on
// output: the live token table and the ambient resolution seam, fail-closed outside a scope
// pos:    §18 (18.2) G5-W4 — the capability is ambient and is never an argument
// >>> If I am updated, update my header and folder CORTEX.md <<<
//
// The rule this module implements has one sentence (§18, `design:8977-8978`): the capability is
// ambient to the execution context and is never an argument; the broker resolves it from the
// channel a call arrived on, and a caller can only USE a capability, never NAME one.
//
// It rides the identical mechanism as the ports it authorises — §7.1 I2's async-local scope
// (`local-runtime-scope.ts:19,15`) — so no call signature has to carry it. THE COORDINATOR ITSELF
// IS GATE 6'S: this module is the coordinator-side table and the resolution seam, not the
// coordinator.
//
// Import discipline: only modules that reach no §7.3 target may be imported. `resolved-policy.js`
// is one of them; `local-runtime-deps.js` is not (it reaches `@platform/index.js` through
// `core/types/thread-types.ts:476`, and a reachability rule cannot exempt type-only edges,
// §18 G5-R2).

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { ActorCapabilityMintError, type ActorCapability } from './capabilities.js';
import { PolicyCompilationError } from './resolved-policy.js';

/** One store per process, the shape `local-runtime-scope.ts` already uses. The capability itself is
 *  the store, so a nested scope replaces rather than merges — an actor never runs inside another
 *  actor's authority. */
const capabilityScope = new AsyncLocalStorage<ActorCapability>();

export interface CurrentAttempt {
  readonly dispatch_generation: string;
  readonly attempt_id: string;
}

export interface ActorCapabilityRegistry {
  /** G5-W4.1/W4.2 mint-and-hold, bind-at-registration. Returns the opaque CHANNEL HANDLE the
   *  sidecar receives; the capability itself is never serialised and never leaves this table. Also
   *  records the registered attempt as the task's current attempt — the record §8.4 R1's
   *  "cap.attempt_id is not the task's current attempt" compares against. */
  register(capability: ActorCapability): string;
  /** Leg 2: resolve the binding a frame arrived on. `null` for an unregistered, closed or
   *  invalidated channel, which §18 G5-W6.7 makes `sidecar_unauthenticated` (code 27). */
  resolveChannel(handle: string): ActorCapability | null;
  isLive(tokenId: string): boolean;
  liveCount(): number;
  /** The current attempt of a task, as last registered — `null` for a task that never had one. */
  currentAttempt(taskId: string): CurrentAttempt | null;
  /** §8.2's token-lifetime rule: invalidation is immediate, never deferred to the next call. */
  invalidateToken(tokenId: string): void;
  invalidateAttempt(attemptId: string): void;
  invalidateSupersededGeneration(taskId: string, currentGeneration: string): void;
  /** §4.5 F1: the trial entering finalisation invalidates every outstanding token. */
  invalidateTrial(): void;
  /** Leg 1: run an in-coordinator actor thread under its own capability. */
  runInScope<T>(capability: ActorCapability, action: () => Promise<T>): Promise<T>;
  currentCapability(): ActorCapability | null;
}

export function createActorCapabilityRegistry(trialId: string): ActorCapabilityRegistry {
  const byToken = new Map<string, ActorCapability>();
  const byChannel = new Map<string, string>();
  const currentAttempts = new Map<string, CurrentAttempt>();

  function dropToken(tokenId: string): void {
    byToken.delete(tokenId);
    for (const [handle, bound] of byChannel) {
      if (bound === tokenId) byChannel.delete(handle);
    }
  }

  return {
    register(capability) {
      if (capability.trial_id !== trialId) {
        throw new ActorCapabilityMintError(
          `a coordinator serves exactly one trial (§1.4): ${capability.trial_id} ≠ ${trialId}`,
        );
      }
      const handle = randomUUID();
      byToken.set(capability.token_id, capability);
      byChannel.set(handle, capability.token_id);
      currentAttempts.set(capability.task_id, {
        dispatch_generation: capability.dispatch_generation,
        attempt_id: capability.attempt_id,
      });
      return handle;
    },

    resolveChannel(handle) {
      const tokenId = byChannel.get(handle);
      if (tokenId === undefined) return null;
      return byToken.get(tokenId) ?? null;
    },

    isLive: tokenId => byToken.has(tokenId),
    liveCount: () => byToken.size,
    currentAttempt: taskId => currentAttempts.get(taskId) ?? null,
    invalidateToken: dropToken,

    invalidateAttempt(attemptId) {
      for (const capability of [...byToken.values()]) {
        if (capability.attempt_id === attemptId) dropToken(capability.token_id);
      }
    },

    invalidateSupersededGeneration(taskId, currentGeneration) {
      for (const capability of [...byToken.values()]) {
        if (capability.task_id === taskId && capability.dispatch_generation !== currentGeneration) {
          dropToken(capability.token_id);
        }
      }
    },

    invalidateTrial() {
      byToken.clear();
      byChannel.clear();
      currentAttempts.clear();
    },

    async runInScope(capability, action) {
      if (!byToken.has(capability.token_id)) {
        throw new PolicyCompilationError(
          'sidecar_unauthenticated', 'capability is not in the live token set (§8.2)',
          { trial_id: trialId, task_id: capability.task_id },
        );
      }
      return capabilityScope.run(capability, action);
    },

    currentCapability: () => capabilityScope.getStore() ?? null,
  };
}

/**
 * §7.1 I3, applied to the capability exactly as it applies to the ports: a broker call made with no
 * capability in scope must throw `port_scope_escaped` (§7.4 code 32) and must NEVER fall back to an
 * ambient default. A fallback here would be the singleton escape hatch the whole fence exists to
 * remove — and, worse, it would be one that grants authority.
 */
export function requireAmbientCapability(registry: ActorCapabilityRegistry): ActorCapability {
  const capability = registry.currentCapability();
  if (capability === null) {
    throw new PolicyCompilationError(
      'port_scope_escaped', 'no ActorCapability in scope for a broker call (§18 G5-W4.3)',
    );
  }
  return capability;
}
