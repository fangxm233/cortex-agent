// input:  validated benchmark arm orchestration, and a coordinator's mint request
// output: closed child-template and broker capability lists, and the §8.2 actor capability token
// pos:    Compile-time admission whitelist derivation, and S-B: the one ActorCapability definition
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { randomUUID } from 'node:crypto';

import type { ArmDefinition } from './arm-schema.js';

export type BenchmarkBrokerCapability =
  | 'task.read'
  | 'task.create'
  | 'task.decompose'
  | 'task.claim'
  | 'task.propose_complete'
  | 'task.propose_block'
  | 'artifact.write'
  | 'dependency.declare'
  | 'qa.ask'
  | 'qa.answer';

const CODER_REVIEW_CAPABILITIES: BenchmarkBrokerCapability[] = [
  'artifact.write', 'task.read',
];

const MANAGER_CAPABILITIES: BenchmarkBrokerCapability[] = [
  'artifact.write',
  'dependency.declare',
  'task.claim',
  'task.create',
  'task.decompose',
  'task.propose_block',
  'task.propose_complete',
  'task.read',
];

const CHILD_TEMPLATES_BY_MODE = {
  direct: [],
  manager: ['benchmark-coder-review', 'benchmark-manager'],
} as const;

const CODER_TEMPLATE_BY_VARIANT = {
  'audit-retry': 'benchmark-coder-review',
  'reviewer-fix': 'benchmark-coder-review-fix',
} as const;

const CAPABILITIES_BY_MODE = {
  direct: [],
  'coder-review': CODER_REVIEW_CAPABILITIES,
  manager: MANAGER_CAPABILITIES,
} as const;

function sorted<T extends string>(values: T[]): T[] {
  return [...values].sort();
}

export function childTemplateWhitelistForArm(arm: ArmDefinition): string[] {
  if (arm.kind !== 'cortex') return [];
  const orchestration = arm.orchestration!;
  if (orchestration.mode === 'coder-review') {
    return [CODER_TEMPLATE_BY_VARIANT[orchestration.coder_review_variant!]];
  }
  return [...CHILD_TEMPLATES_BY_MODE[orchestration.mode]];
}

export function capabilityWhitelistForArm(
  arm: ArmDefinition,
): BenchmarkBrokerCapability[] {
  if (arm.kind !== 'cortex') return [];
  const orchestration = arm.orchestration!;
  const capabilities: BenchmarkBrokerCapability[] = [
    ...CAPABILITIES_BY_MODE[orchestration.mode],
  ];
  if (orchestration.mode === 'manager' && orchestration.ask_manager) {
    capabilities.push('qa.ask', 'qa.answer');
  }
  return sorted(capabilities);
}

// ── §8.2 the actor capability token ─────────────────────────────────────────

/**
 * §8.3's ten actions as a runtime array, in the matrix's own order (`design:2412-2423`). The union
 * above stays the single source of truth: `BrokerActionsAreExhaustive` below fails to compile if a
 * member of one is missing from the other, so the two cannot drift apart. §8.3 says the matrix is
 * exhaustive — "an action absent from this table does not exist" (`design:2409-2410`) — and there
 * is deliberately no `task.complete`, `task.block` or `task.uncomplete`: sealing is the
 * coordinator's act (§8.6).
 */
export const BENCHMARK_BROKER_ACTIONS = Object.freeze([
  'task.read', 'task.create', 'task.decompose', 'task.claim', 'task.propose_complete',
  'task.propose_block', 'artifact.write', 'dependency.declare', 'qa.ask', 'qa.answer',
] as const satisfies readonly BenchmarkBrokerCapability[]);

type MissingBrokerAction =
  Exclude<BenchmarkBrokerCapability, typeof BENCHMARK_BROKER_ACTIONS[number]>;
export type BrokerActionsAreExhaustive = MissingBrokerAction extends never ? true : never;

/**
 * §8.2's `RoleSlot`, verbatim the five members that section's own comment gives (`design:2384`).
 * Deliberately NOT the journal's `AgentSlot` (`journal.ts:13`), a three-member union with no
 * manager slot: §7.2 P21 records widening that union as `journal.ts`'s own [NEW] work.
 */
export const ROLE_SLOTS = Object.freeze(
  ['parent', 'manager', 'coder', 'reviewer', 'verifier'] as const,
);
export type RoleSlot = typeof ROLE_SLOTS[number];

/**
 * §8.2's token (`design:2376-2388`). Minted by the coordinator, never by a model, and never
 * travelling in model-visible text. §18 G5-W4 makes it AMBIENT: it is resolved from the channel or
 * scope a call arrived on, so no broker entry point takes it as an argument and a caller can only
 * *use* a capability, never *name* one.
 *
 * This is S-B for Gate 5. The ports that take a `cap` parameter in their §7.2 signatures — P3, P5,
 * P6, P12, P13, P14 and P15's actor — all reference this one declaration; a second token type
 * anywhere is the abstraction split the gate exists to prevent.
 */
export interface ActorCapability {
  /** Opaque, single-trial, unforgeable. Minted here; a caller-supplied value is never honoured. */
  readonly token_id: string;
  readonly trial_id: string;
  readonly task_id: string;
  /** The claim fence, minted per claim as `randomUUID()` at `dispatcher.ts:399`. */
  readonly dispatch_generation: string;
  /** D-9 — this attempt of this generation. */
  readonly attempt_id: string;
  readonly role: RoleSlot;
  /** `[root_task_id, …, parent_task_id]`; the actor's own id is excluded. */
  readonly ancestry: readonly string[];
  /** ⊆ `policy.capability_whitelist` (§2.4), enforced at mint. */
  readonly allowed_actions: ReadonlySet<BenchmarkBrokerCapability>;
  readonly issued_at_epoch_ms: number;
}

/** §8.2's nine fields as data, so "the token is exactly this shape" is checkable. */
export const ACTOR_CAPABILITY_FIELDS = Object.freeze([
  'token_id', 'trial_id', 'task_id', 'dispatch_generation', 'attempt_id',
  'role', 'ancestry', 'allowed_actions', 'issued_at_epoch_ms',
] as const satisfies readonly (keyof ActorCapability)[]);

type MissingCapabilityField =
  Exclude<keyof ActorCapability, typeof ACTOR_CAPABILITY_FIELDS[number]>;
export type CapabilityFieldsAreExhaustive = MissingCapabilityField extends never ? true : never;

/** A mint or binding that would violate a §8.2 invariant. Coordinator-internal: reaching it means
 *  the coordinator asked for a token the contract does not admit, which is a defect, not a refusal
 *  an actor can provoke. */
export class ActorCapabilityMintError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ActorCapabilityMintError';
  }
}

export interface ActorCapabilityMintRequest {
  readonly trial_id: string;
  readonly task_id: string;
  readonly dispatch_generation: string;
  readonly attempt_id: string;
  readonly role: RoleSlot;
  readonly ancestry: readonly string[];
  /** §2.4's closed action set for the arm, i.e. `capabilityWhitelistForArm(arm)` as the compiler
   *  froze it into `policy.capability_whitelist`. */
  readonly capability_whitelist: readonly BenchmarkBrokerCapability[];
  /** Optional narrowing. Omitted means the whole whitelist; a member outside it is a mint error. */
  readonly allowed_actions?: readonly BenchmarkBrokerCapability[];
  /** From the deterministic clock (P17). */
  readonly issued_at_epoch_ms: number;
}

const coordinatorMintedCapabilities = new WeakSet<object>();

/** A ReadonlySet wrapper with no mutable Set internal slot. `Object.freeze(new Set())` is not
 *  sufficient: `Set.prototype.add.call(frozenSet, value)` still mutates that frozen Set. */
class SealedActionSet implements ReadonlySet<BenchmarkBrokerCapability> {
  readonly #values: Set<BenchmarkBrokerCapability>;

  constructor(values: readonly BenchmarkBrokerCapability[]) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  get [Symbol.toStringTag](): string { return 'Set'; }
  has(value: BenchmarkBrokerCapability): boolean { return this.#values.has(value); }
  entries(): SetIterator<[BenchmarkBrokerCapability, BenchmarkBrokerCapability]> {
    return this.#values.entries();
  }
  keys(): SetIterator<BenchmarkBrokerCapability> { return this.#values.keys(); }
  values(): SetIterator<BenchmarkBrokerCapability> { return this.#values.values(); }
  [Symbol.iterator](): SetIterator<BenchmarkBrokerCapability> { return this.#values.values(); }
  forEach(
    callbackfn: (
      value: BenchmarkBrokerCapability,
      value2: BenchmarkBrokerCapability,
      set: ReadonlySet<BenchmarkBrokerCapability>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }
}

/** A set no holder can widen in place: a token that could grow its own `allowed_actions` after
 *  minting would make the §8.3 membership test decorative. */
function sealedActionSet(
  values: readonly BenchmarkBrokerCapability[],
): ReadonlySet<BenchmarkBrokerCapability> {
  return new SealedActionSet(values);
}

/** Registration accepts only objects produced by the production coordinator-side mint. */
export function isCoordinatorMintedActorCapability(value: unknown): value is ActorCapability {
  return typeof value === 'object' && value !== null && coordinatorMintedCapabilities.has(value);
}

/**
 * The ONLY way an `ActorCapability` comes into existence, in production and in tests alike. §8.2:
 * minted by the coordinator, never by a model. `token_id` is minted here from `randomUUID()`, so a
 * caller cannot choose, replay or predict one.
 */
export function mintActorCapability(request: ActorCapabilityMintRequest): ActorCapability {
  if (!(ROLE_SLOTS as readonly string[]).includes(request.role)) {
    throw new ActorCapabilityMintError(`role is not a §8.2 slot: ${String(request.role)}`);
  }
  if (request.ancestry.includes(request.task_id)) {
    throw new ActorCapabilityMintError('ancestry excludes the actor\'s own task id (§8.2)');
  }
  const whitelist = new Set(request.capability_whitelist);
  const granted = request.allowed_actions ?? request.capability_whitelist;
  for (const action of granted) {
    if (!whitelist.has(action)) {
      throw new ActorCapabilityMintError(
        `allowed_actions must be a subset of capability_whitelist (§8.2): ${action}`,
      );
    }
  }
  const capability: ActorCapability = Object.freeze({
    token_id: randomUUID(),
    trial_id: request.trial_id,
    task_id: request.task_id,
    dispatch_generation: request.dispatch_generation,
    attempt_id: request.attempt_id,
    role: request.role,
    ancestry: Object.freeze([...request.ancestry]),
    allowed_actions: sealedActionSet(granted),
    issued_at_epoch_ms: request.issued_at_epoch_ms,
  });
  coordinatorMintedCapabilities.add(capability);
  return capability;
}
