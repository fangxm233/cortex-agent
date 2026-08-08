// input:  §8.3's ten-action matrix, §8.4's twelve rejections and §8.5's projection split
// output: closed-table, per-guard, refusal-by-code and no-tree-touch contract tests
// pos:    The §8 authorization fence, tested at the broker's own call surface
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BENCHMARK_BROKER_ACTIONS, capabilityWhitelistForArm, mintActorCapability,
  type ActorCapability, type BenchmarkBrokerCapability,
} from '../../../src/domain/benchmark/capabilities.js';
import {
  createActorCapabilityRegistry, type ActorCapabilityRegistry,
} from '../../../src/domain/benchmark/actor-capability-scope.js';
import {
  BROKER_ACTION_TABLE, BROKER_REJECTIONS, BROKER_TOOL_NAMES,
  BrokerArgumentsError, MODEL_VISIBLE_TASK_FIELDS, PROJECTION_WITHHELD_TASK_FIELDS,
  createBenchmarkTaskBroker, projectTaskForModel,
  type BrokerCallResult, type BrokerPorts, type BrokerRefusal,
} from '../../../src/domain/benchmark/task-broker.js';
import { BENCHMARK_FAILURES, type ResolvedTrialPolicy } from '../../../src/domain/benchmark/resolved-policy.js';
import type { CompositeRuntimePorts } from '../../../src/domain/benchmark/composite-runtime-ports.js';
import type { ArmDefinition } from '../../../src/domain/benchmark/arm-schema.js';
import type { Task } from '../../../src/core/task-parser.js';

/**
 * `task-broker.ts` declares its port needs STRUCTURALLY rather than importing the §7.2 bundle,
 * because `composite-runtime-ports.ts` reaches `@platform/index.js` through
 * `core/types/thread-types.ts:476` and a reachability rule cannot exempt type-only edges
 * (§18 G5-R2) — importing it would make the broker an eighth X2 seed and raise a pinned count.
 * This assertion is the link that keeps the structural declaration from drifting into a competing
 * abstraction: the frozen 23-port bundle must satisfy it. It lives in the test tree, which
 * depcruise does not cruise, so it costs no `src` edge.
 */
const PORTS_ARE_A_SUBSET_OF_THE_FROZEN_BUNDLE: (ports: CompositeRuntimePorts) => BrokerPorts =
  ports => ports;

/**
 * Discipline held throughout: every refusal is asserted by its §8.7 CODE (or, for R6/R9/R10, by
 * `reason` with the `code` KEY ABSENT, per §18 G5-N4's interim rule), never by a message substring;
 * and every refusal is additionally asserted to have touched NOTHING — the `touches` log is the
 * no-side-effect half of §8.4's "a rejection does not touch the tree" (`design:2433-2434`).
 */

const PROJECT = 'trial';
const TRIAL_ID = 'trial-1';
const GEN_1 = 'gen-1';

function armFor(mode: 'manager' | 'coder-review', askManager: boolean): ArmDefinition {
  return {
    kind: 'cortex',
    orchestration: mode === 'manager'
      ? { mode, ask_manager: askManager }
      : { mode, ask_manager: false, coder_review_variant: 'audit-retry' },
  } as unknown as ArmDefinition;
}

function taskRow(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    text: 'do', why: 'because', done_when: 'done', priority: 'medium', status: 'open',
    template: 'benchmark-coder-review', plan: '', project: PROJECT, parent: null,
    depends_on: [], gpu: null, gpu_count: 0, blocked_by: null, claimed_by: null,
    claimed_at: null, dispatch_generation: null, paused: false, approval_needed: false,
    approved_at: null, not_before: null, completed_at: null, completed_note: null,
    pending_at: null, origin_session_id: null, origin_channel: null, origin_thread_id: null,
    ...overrides,
  } as Task;
}

interface Harness {
  broker: ReturnType<typeof createBenchmarkTaskBroker>;
  capability: ActorCapability;
  capabilities: ActorCapabilityRegistry;
  touches: string[];
  tasks: Map<string, Task>;
  trialRoot: string;
  call(
    action: BenchmarkBrokerCapability, payload?: Record<string, unknown>,
  ): Promise<BrokerCallResult>;
}

interface HarnessOptions {
  allowedActions?: BenchmarkBrokerCapability[];
  askManager?: boolean;
  /** The policy's frozen whitelist may diverge from the mint whitelist only by construction error;
   *  the option exists to drive the qa_whitelisted guard's policy re-check. */
  policyAskManager?: boolean;
  policyTrialId?: string;
  lockHolder?: string | null;
  ledgerThrows?: boolean;
  artifactPathOverride?: string;
  maxTasks?: number;
  maxTaskDepth?: number;
  /** The token's generation; the task row's generation is `taskGeneration`. */
  generation?: string;
  taskGeneration?: string;
  attemptId?: string;
  ancestry?: string[];
}

function harness(options: HarnessOptions = {}): Harness {
  const touches: string[] = [];
  const trialRoot = mkdtempSync(path.join(tmpdir(), 'f228-trial-'));
  mkdirSync(path.join(trialRoot, 'manager', 'aaaa'), { recursive: true });

  // aaaa is the actor's own task; bbbb is its parent (ancestry); cccc is a sibling out of branch;
  // dddd is a child of aaaa (in branch); root is the trial root task.
  const tasks = new Map<string, Task>([
    ['root', taskRow({ id: 'root' })],
    ['bbbb', taskRow({ id: 'bbbb', parent: 'root' })],
    ['aaaa', taskRow({
      id: 'aaaa', parent: 'bbbb', dispatch_generation: options.taskGeneration ?? GEN_1,
    })],
    ['dddd', taskRow({ id: 'dddd', parent: 'aaaa' })],
    ['cccc', taskRow({ id: 'cccc', parent: 'root' })],
  ]);

  const ports = {
    taskRepository: {
      getById: (id: string) => tasks.get(id) ?? null,
      list: (filter: { parent?: string }) => [...tasks.values()].filter(
        task => (filter.parent === undefined ? true : task.parent === filter.parent),
      ),
    },
    taskMutator: {
      claim: (_capability: ActorCapability, id: string) => {
        touches.push(`mutator.claim:${id}`);
        return { success: true };
      },
      unclaim: (_capability: ActorCapability, id: string) => {
        touches.push(`mutator.unclaim:${id}`);
        return { success: true };
      },
      add: (_capability: ActorCapability) => {
        touches.push('mutator.add');
        return { success: true };
      },
      decompose: (_capability: ActorCapability) => {
        touches.push('mutator.decompose');
        return { success: true };
      },
      edit: (_capability: ActorCapability) => {
        touches.push('mutator.edit');
        return { success: true };
      },
      proposeComplete: (_capability: ActorCapability, id: string) => {
        touches.push(`mutator.proposeComplete:${id}`);
        return { state: 'proposed' };
      },
      proposeBlock: (_capability: ActorCapability, id: string) => {
        touches.push(`mutator.proposeBlock:${id}`);
        return { state: 'proposed' };
      },
    },
    taskLocks: {
      assertHeld: () => (options.lockHolder === undefined ? null : options.lockHolder),
    },
    taskArtifacts: {
      artifactPath: (_project: string, id: string) => (
        options.artifactPathOverride ?? path.join(trialRoot, 'manager', id, 'artifact.md')
      ),
      write: (_capability: ActorCapability) => {
        touches.push('artifacts.write');
      },
    },
    acceptanceLedger: {
      pending: () => {
        if (options.ledgerThrows) throw new Error('ENOENT: ledger gone');
        return [];
      },
    },
    managerQa: {
      ask: (_capability: ActorCapability) => {
        touches.push('qa.ask');
        return { questionId: 'q1' };
      },
      answer: (_capability: ActorCapability) => {
        touches.push('qa.answer');
        return { success: true };
      },
    },
  } as unknown as BrokerPorts;

  const whitelist = capabilityWhitelistForArm(armFor('manager', options.askManager ?? true));
  const policy = {
    trial_id: options.policyTrialId ?? TRIAL_ID,
    child_template_whitelist: ['benchmark-coder-review', 'benchmark-manager'],
    capability_whitelist: capabilityWhitelistForArm(
      armFor('manager', options.policyAskManager ?? options.askManager ?? true),
    ),
    limits: {
      max_tasks: options.maxTasks ?? 20,
      max_task_depth: options.maxTaskDepth ?? 4,
    },
  } as unknown as ResolvedTrialPolicy;

  const capabilities: ActorCapabilityRegistry = createActorCapabilityRegistry(TRIAL_ID);
  const capability = mintActorCapability({
    trial_id: TRIAL_ID,
    task_id: 'aaaa',
    dispatch_generation: options.generation ?? GEN_1,
    attempt_id: options.attemptId ?? 'attempt-1',
    role: 'manager',
    ancestry: options.ancestry ?? ['root', 'bbbb'],
    capability_whitelist: whitelist,
    allowed_actions: options.allowedActions,
    issued_at_epoch_ms: 1_000,
  });
  capabilities.register(capability);

  const broker = createBenchmarkTaskBroker({
    policy, ports, capabilities, project: PROJECT, trialArtifactRoot: trialRoot,
  });

  return {
    broker,
    capability,
    capabilities,
    touches,
    tasks,
    trialRoot,
    call: (action, payload = {}) => capabilities.runInScope(
      capability, () => broker.call(action, payload),
    ),
  };
}

function refusal(result: BrokerCallResult): BrokerRefusal {
  expect(result.ok).toBe(false);
  expect(result.status).toBe('rejected');
  return result as BrokerRefusal;
}

// ── (B) §8.3 the matrix ─────────────────────────────────────────────────────

describe('§8.3 the authorization matrix is a closed table of exactly ten actions', () => {
  it('consumes the frozen §7.2 ports, not a competing abstraction', () => {
    expect(PORTS_ARE_A_SUBSET_OF_THE_FROZEN_BUNDLE).toBeTypeOf('function');
  });

  it('has one row per action of BENCHMARK_BROKER_ACTIONS and no others', () => {
    expect(Object.keys(BROKER_ACTION_TABLE).sort()).toEqual([...BENCHMARK_BROKER_ACTIONS].sort());
    expect(Object.keys(BROKER_ACTION_TABLE)).toHaveLength(10);
  });

  it('carries no task.complete, task.block or task.uncomplete row (§8.6)', () => {
    expect(BROKER_ACTION_TABLE).not.toHaveProperty('task.complete');
    expect(BROKER_ACTION_TABLE).not.toHaveProperty('task.block');
    expect(BROKER_ACTION_TABLE).not.toHaveProperty('task.uncomplete');
  });

  it('an action outside the table cannot be expressed at the type level', () => {
    // The @ts-expect-error directives ARE the test: if `task.complete` or `task_block` ever
    // become members of the surface, these directives stop being errors and tsc fails on the
    // unused directives.
    // @ts-expect-error — an action absent from §8.3's table does not exist (design:2409-2410)
    const outside: BenchmarkBrokerCapability = 'task.complete';
    // @ts-expect-error — no task_block tool name either
    const blocked: keyof typeof BROKER_TOOL_NAMES = 'task_block';
    expect([outside, blocked]).toBeDefined();
  });

  it('a runtime call with an action outside the table is refused as a protocol error, not honoured', async () => {
    const h = harness();
    await expect(
      h.capabilities.runInScope(h.capability, () =>
        h.broker.call('task.complete' as BenchmarkBrokerCapability, {})),
    ).rejects.toThrow(BrokerArgumentsError);
    expect(h.touches).toEqual([]);
  });

  it('names each tool by §18 G5-W5: the action with . replaced by _, except the two qa.* names', () => {
    expect(BROKER_TOOL_NAMES).toEqual({
      'task.read': 'task_read',
      'task.create': 'task_create',
      'task.decompose': 'task_decompose',
      'task.claim': 'task_claim',
      'task.propose_complete': 'task_propose_complete',
      'task.propose_block': 'task_propose_block',
      'artifact.write': 'artifact_write',
      'dependency.declare': 'dependency_declare',
      'qa.ask': 'ask_manager',
      'qa.answer': 'answer_subtask',
    });
    expect(Object.values(BROKER_TOOL_NAMES)).not.toContain('task_complete');
    expect(Object.values(BROKER_TOOL_NAMES)).not.toContain('task_block');
    expect(Object.values(BROKER_TOOL_NAMES)).not.toContain('task_uncomplete');
  });

  it('gives every row a GUARD list, not merely membership (§8.3\'s guard column)', () => {
    for (const action of BENCHMARK_BROKER_ACTIONS) {
      expect(BROKER_ACTION_TABLE[action].guards.length, action).toBeGreaterThan(0);
    }
    expect(BROKER_ACTION_TABLE['task.create'].guards).toEqual(
      expect.arrayContaining(['lock_held', 'template_whitelisted', 'task_budget', 'depth_budget']),
    );
    expect(BROKER_ACTION_TABLE['task.decompose'].guards).toEqual(
      expect.arrayContaining(['generation_current', 'template_whitelisted', 'task_budget', 'depth_budget']),
    );
    expect(BROKER_ACTION_TABLE['task.propose_complete'].guards).toEqual(
      expect.arrayContaining(['target_self', 'generation_current', 'ledger_readable']),
    );
    expect(BROKER_ACTION_TABLE['task.claim'].guards).toEqual(['in_branch']);
    expect(BROKER_ACTION_TABLE['dependency.declare'].guards).toEqual(
      ['in_branch_endpoints', 'acyclic'],
    );
    expect(BROKER_ACTION_TABLE['artifact.write'].guards).toEqual(['trial_path']);
  });

  it('M19 DISARM PROBE — the table and every guard list are frozen', () => {
    expect(Object.isFrozen(BROKER_ACTION_TABLE)).toBe(true);
    for (const action of BENCHMARK_BROKER_ACTIONS) {
      expect(Object.isFrozen(BROKER_ACTION_TABLE[action].guards), action).toBe(true);
      expect(Object.isFrozen(BROKER_ACTION_TABLE[action].argumentKeys), action).toBe(true);
    }
  });

  it('fixes task.create\'s parent and omits it from the schema, so a cross-branch create is unexpressible', () => {
    expect(BROKER_ACTION_TABLE['task.create'].argumentKeys).not.toContain('parent');
    expect(BROKER_ACTION_TABLE['task.decompose'].argumentKeys).not.toContain('keep_parent');
    expect(BROKER_ACTION_TABLE['task.claim'].argumentKeys).not.toContain('generation');
    expect(BROKER_ACTION_TABLE['task.propose_complete'].argumentKeys).not.toContain('task_id');
    expect(BROKER_ACTION_TABLE['task.propose_block'].argumentKeys).not.toContain('task_id');
    expect(BROKER_ACTION_TABLE['artifact.write'].argumentKeys).not.toContain('path');
  });

  it('honours a well-formed call on each authorised action, so the guards are not a blanket deny', async () => {
    const h = harness({ allowedActions: [...BENCHMARK_BROKER_ACTIONS] });

    const readOk = await h.call('task.read', {});
    expect(readOk.ok).toBe(true);
    expect((readOk as { result: Record<string, unknown> }).result).toHaveProperty('tasks');

    const create = await h.call('task.create', { text: 'new task' });
    expect(create.ok).toBe(true);
    expect(h.touches).toContain('mutator.add');

    const decompose = await h.call('task.decompose', { subtasks: [{ text: 'child' }] });
    expect(decompose.ok).toBe(true);
    expect(h.touches).toContain('mutator.decompose');

    const claim = await h.call('task.claim', { task_id: 'aaaa' });
    expect(claim.ok).toBe(true);

    const propose = await h.call('task.propose_complete', { note: 'done' });
    expect(propose.ok).toBe(true);
    const proposeBlock = await h.call('task.propose_block', { reason: 'blocked' });
    expect(proposeBlock.ok).toBe(true);

    const artifact = await h.call('artifact.write', { content: 'artifact' });
    expect(artifact.ok).toBe(true);
    expect(h.touches).toContain('artifacts.write');

    const dependency = await h.call('dependency.declare', { task_id: 'aaaa', depends_on: ['dddd'] });
    expect(dependency.ok).toBe(true);
    expect(h.touches).toContain('mutator.edit');

    const ask = await h.call('qa.ask', { question: 'question?' });
    expect(ask.ok).toBe(true);
    const answer = await h.call('qa.answer', { question_id: 'q1', answer: 'yes' });
    expect(answer.ok).toBe(true);
  });
});

// ── (C) R1-R12, one describe per rejection ──────────────────────────────────

describe('§8.4 R1 stale_generation → code 34', () => {
  it('refuses when cap.dispatch_generation ≠ the task\'s, and touches nothing', async () => {
    const h = harness({ generation: 'gen-0', taskGeneration: GEN_1 }); // token gen-0, task gen-1
    const result = refusal(await h.call('task.propose_complete', { note: 'done' }));
    expect(result.code).toBe(34);
    expect(result.reason).toBe('stale_generation');
    expect(h.touches).toEqual([]);
  });

  it('M3 — also refuses when the attempt is not the task\'s current attempt (D-9)', async () => {
    const h = harness({ attemptId: 'attempt-1' });
    // A newer attempt of the SAME generation supersedes: the registry's current attempt moves to
    // attempt-2 while attempt-1's token is still live — the R1 window §8.2's lifetime rule names.
    const newer = mintActorCapability({
      trial_id: TRIAL_ID,
      task_id: 'aaaa',
      dispatch_generation: GEN_1,
      attempt_id: 'attempt-2',
      role: 'manager',
      ancestry: ['root', 'bbbb'],
      capability_whitelist: capabilityWhitelistForArm(armFor('manager', true)),
      issued_at_epoch_ms: 2_000,
    });
    h.capabilities.register(newer);
    expect(h.capabilities.currentAttempt('aaaa')).toEqual(
      { dispatch_generation: GEN_1, attempt_id: 'attempt-2' },
    );
    const result = refusal(await h.call('task.propose_complete', { note: 'done' }));
    expect(result.code).toBe(34);
    expect(result.reason).toBe('stale_generation');
    expect(h.touches).toEqual([]);
  });

  it('decompose is generation-guarded too ("ownership generation matches", §8.3)', async () => {
    const h = harness({ generation: 'gen-0', taskGeneration: GEN_1 });
    const result = refusal(await h.call('task.decompose', { subtasks: [{ text: 'child' }] }));
    expect(result.code).toBe(34);
    expect(h.touches).toEqual([]);
  });
});

describe('§8.4 R2 cross_branch_mutation → code 35', () => {
  it('refuses a mutation whose target is neither cap.task_id nor a descendant of it', async () => {
    const h = harness();
    const result = refusal(await h.call('task.claim', { task_id: 'cccc' })); // sibling
    expect(result.code).toBe(35);
    expect(result.reason).toBe('cross_branch_mutation');
    expect(h.touches).toEqual([]);
  });

  it('allows the in-branch descendant, so the rule discriminates', async () => {
    const h = harness();
    const result = await h.call('task.claim', { task_id: 'dddd' }); // child of aaaa
    expect(result.ok).toBe(true);
    expect(h.touches).toEqual(['mutator.claim:dddd']);
  });
});

describe('§8.4 R3 parent_completion_by_child → code 35', () => {
  it('refuses a claim/edit that targets a task in cap.ancestry', async () => {
    const h = harness();
    const result = refusal(await h.call('task.claim', { task_id: 'bbbb' })); // own parent
    expect(result.code).toBe(35);
    expect(result.reason).toBe('parent_completion_by_child');
    expect(h.touches).toEqual([]);
  });

  it('refuses a dependency.declare that reaches upward into ancestry', async () => {
    const h = harness();
    const result = refusal(await h.call('dependency.declare', {
      task_id: 'aaaa', depends_on: ['bbbb'],
    }));
    expect(result.code).toBe(35);
    expect(result.reason).toBe('parent_completion_by_child');
    expect(h.touches).toEqual([]);
  });
});

describe('§8.4 R4 proposal_target_not_self → code 35', () => {
  it('refuses a proposal naming a task other than cap.task_id, on the leg-1 signature', async () => {
    const h = harness();
    const result = refusal(
      await h.capabilities.runInScope(h.capability, () =>
        h.broker.proposeComplete(h.capability, 'bbbb', 'done')),
    );
    expect(result.code).toBe(35);
    expect(result.reason).toBe('proposal_target_not_self');
    expect(h.touches).toEqual([]);
  });

  it('the MCP-shaped call has no task_id argument at all, so R4 is unexpressible there', async () => {
    const h = harness();
    const result = await h.call('task.propose_complete', { note: 'done' });
    expect(result.ok).toBe(true);
    expect(h.touches).toEqual(['mutator.proposeComplete:aaaa']);
  });
});

describe('§8.4 R5 out_of_trial_path → code 36', () => {
  it('refuses an artifact path that resolves — after realpath — outside the trial root', async () => {
    const h = harness();
    // The artifact path itself is fixed; a symlinked directory inside the trial root that points
    // outside is what resolve-then-contain must catch (the confinedJournalPath discipline). The
    // symlink target must exist for realpath to resolve through it.
    const outside = path.join(h.trialRoot, '..', 'f228-outside.md');
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(outside, 'outside');
    symlinkSync(outside, path.join(h.trialRoot, 'manager', 'aaaa', 'artifact.md'));
    const result = refusal(await h.call('artifact.write', { content: 'x' }));
    expect(result.code).toBe(36);
    expect(result.reason).toBe('out_of_trial_path');
    expect(h.touches).toEqual([]);
  });

  it('admits the in-root artifact path, so the rule discriminates', async () => {
    const h = harness();
    const result = await h.call('artifact.write', { content: 'x' });
    expect(result.ok).toBe(true);
    expect(h.touches).toEqual(['artifacts.write']);
  });
});

describe('§8.4 R6 template_not_whitelisted → NO CODE (§18 G5-N4 interim rule)', () => {
  it('refuses with reason set and the code KEY absent, and mints nothing', async () => {
    const h = harness();
    const result = refusal(await h.call('task.create', {
      text: 'x', template: 'not-whitelisted',
    }));
    expect(result.reason).toBe('template_not_whitelisted');
    expect(result).not.toHaveProperty('code');
    expect(h.touches).toEqual([]);
  });

  it('does NOT reuse compile-time code 20, which is Class P and a different condition', () => {
    const code20 = BENCHMARK_FAILURES.find(failure => failure.code === 20)!;
    const spec = BROKER_REJECTIONS.R6;
    expect(code20.reason).toBe('template_not_whitelisted');
    expect(spec).not.toHaveProperty('code');
    // Class P: "nothing started". A broker refusal is Class R — reusing 20 is the §2.6 defect.
    expect(code20.failureClass).toBe('P');
  });

  it('admits a whitelisted template, so the rule discriminates', async () => {
    const h = harness();
    const result = await h.call('task.create', { text: 'x', template: 'benchmark-coder-review' });
    expect(result.ok).toBe(true);
  });

  it('checks every subtask template of a decompose, not just the top level', async () => {
    const h = harness();
    const result = refusal(await h.call('task.decompose', {
      subtasks: [{ text: 'x', template: 'not-whitelisted' }],
    }));
    expect(result.reason).toBe('template_not_whitelisted');
    expect(result).not.toHaveProperty('code');
    expect(h.touches).toEqual([]);
  });
});

describe('§8.4 R7 profile_not_whitelisted → code 23', () => {
  it('refuses any actor request that names a profile (§2.7 forbids runtime re-resolution)', async () => {
    const h = harness();
    const result = refusal(await h.call('task.create', { text: 'x', profile: 'some-profile' }));
    expect(result.code).toBe(23);
    expect(result.reason).toBe('profile_not_whitelisted');
    expect(h.touches).toEqual([]);
  });
});

describe('§8.4 R8 capability_denied → code 33', () => {
  it('refuses an action outside cap.allowed_actions and touches nothing', async () => {
    const h = harness({ allowedActions: ['task.read'] });
    const result = refusal(await h.call('task.create', { text: 'x' }));
    expect(result.code).toBe(33);
    expect(result.reason).toBe('capability_denied');
    expect(h.touches).toEqual([]);
  });

  it('every qa.* call is denied when ask_manager=false leaves them out of the whitelist', async () => {
    // The mint enforces allowed ⊆ whitelist, so the only way a token carries qa.* against a policy
    // that forbids it is a construction error — the guard re-checks the frozen policy (§2.4:
    // absent, not refused). Drive it with a policy whose whitelist dropped qa.*.
    const h = harness({ askManager: true, policyAskManager: false });
    const ask = refusal(await h.call('qa.ask', { question: 'q' }));
    expect(ask.code).toBe(33);
    expect(h.touches).toEqual([]);
    const answer = refusal(await h.call('qa.answer', { question_id: 'q1', answer: 'a' }));
    expect(answer.code).toBe(33);
    expect(h.touches).toEqual([]);
  });
});

describe('§8.4 R9 budget_exceeded → NO CODE (§18 G5-N4 interim rule)', () => {
  it('refuses a create that would push the trial past max_tasks, code KEY absent', async () => {
    const h = harness({ maxTasks: 5 }); // 5 tasks already in the table
    const result = refusal(await h.call('task.create', { text: 'x' }));
    expect(result.reason).toBe('budget_exceeded');
    expect(result).not.toHaveProperty('code');
    expect(h.touches).toEqual([]);
  });

  it('refuses a create that would push past max_task_depth, code KEY absent', async () => {
    const h = harness({ maxTaskDepth: 2 }); // cap.ancestry = [root, bbbb] → depth 2
    const result = refusal(await h.call('task.create', { text: 'x' }));
    expect(result.reason).toBe('budget_exceeded');
    expect(result).not.toHaveProperty('code');
    expect(h.touches).toEqual([]);
  });

  it('admits a create inside both bounds, so the rules discriminate', async () => {
    const h = harness({ maxTasks: 6, maxTaskDepth: 3 });
    const result = await h.call('task.create', { text: 'x' });
    expect(result.ok).toBe(true);
  });
});

describe('§8.4 R10 lock_not_held → NO CODE (§18 G5-N4 interim rule)', () => {
  it('refuses a lock-requiring mutation when the project lock is held elsewhere', async () => {
    const h = harness({ lockHolder: 'someone-else' });
    const result = refusal(await h.call('task.create', { text: 'x' }));
    expect(result.reason).toBe('lock_not_held');
    expect(result).not.toHaveProperty('code');
    expect(h.touches).toEqual([]);
  });

  it('does not gate a read on the lock, so the guard is per-action and not blanket', async () => {
    const h = harness({ lockHolder: 'someone-else' });
    const result = await h.call('task.read', {});
    expect(result.ok).toBe(true);
  });
});

describe('§8.4 R11 ledger_unreadable → code 42', () => {
  it('fails CLOSED when the acceptance ledger cannot be read (D-11 inverts the shipped fail-open)', async () => {
    const h = harness({ ledgerThrows: true });
    const result = refusal(await h.call('task.propose_complete', { note: 'done' }));
    expect(result.code).toBe(42);
    expect(result.reason).toBe('ledger_unreadable');
    expect(h.touches).toEqual([]);
  });
});

describe('§8.4 R12 token_invalid → code 27', () => {
  it('refuses a capability invalidated between registration and call (§8.2 lifetime)', async () => {
    const h = harness();
    // Invalidate INSIDE the scope: runInScope admits a live token, so a call made after the
    // invalidation must fail at the broker's own R12 — invalidation is not deferred to the next
    // call.
    const result = refusal(await h.capabilities.runInScope(h.capability, async () => {
      h.capabilities.invalidateToken(h.capability.token_id);
      return h.broker.call('task.read', {});
    }));
    expect(result.code).toBe(27);
    expect(result.reason).toBe('token_invalid');
    expect(h.touches).toEqual([]);
  });

  it('refuses a capability minted for another trial', async () => {
    // register() refuses a wrong-trial token (one trial per coordinator, §1.4), so the broker's
    // own trial check is the second line — drive it by constructing the broker against a policy
    // whose trial_id differs from the registry's, a construction error the check must contain.
    const h = harness({ policyTrialId: 'other-trial' });
    const result = refusal(await h.call('task.read', {}));
    expect(result.code).toBe(27);
    expect(result.reason).toBe('token_invalid');
    expect(h.touches).toEqual([]);
  });
});

describe('§8.4 the rejection table itself', () => {
  it('is the closed R1…R12 → code map of §18 G5-W8, with three codes deliberately absent', () => {
    expect(BROKER_REJECTIONS.R1).toEqual({ reason: 'stale_generation', code: 34 });
    expect(BROKER_REJECTIONS.R2).toEqual({ reason: 'cross_branch_mutation', code: 35 });
    expect(BROKER_REJECTIONS.R3).toEqual({ reason: 'parent_completion_by_child', code: 35 });
    expect(BROKER_REJECTIONS.R4).toEqual({ reason: 'proposal_target_not_self', code: 35 });
    expect(BROKER_REJECTIONS.R5).toEqual({ reason: 'out_of_trial_path', code: 36 });
    expect(BROKER_REJECTIONS.R6).toEqual({ reason: 'template_not_whitelisted' });
    expect(BROKER_REJECTIONS.R7).toEqual({ reason: 'profile_not_whitelisted', code: 23 });
    expect(BROKER_REJECTIONS.R8).toEqual({ reason: 'capability_denied', code: 33 });
    expect(BROKER_REJECTIONS.R9).toEqual({ reason: 'budget_exceeded' });
    expect(BROKER_REJECTIONS.R10).toEqual({ reason: 'lock_not_held' });
    expect(BROKER_REJECTIONS.R11).toEqual({ reason: 'ledger_unreadable', code: 42 });
    expect(BROKER_REJECTIONS.R12).toEqual({ reason: 'token_invalid', code: 27 });
    expect(BROKER_REJECTIONS.R6).not.toHaveProperty('code');
    expect(BROKER_REJECTIONS.R9).not.toHaveProperty('code');
    expect(BROKER_REJECTIONS.R10).not.toHaveProperty('code');
  });

  it('M18 — mints NO new failure code: every code it uses is already in the 1–44 registry', () => {
    const registryCodes = new Set(BENCHMARK_FAILURES.map(failure => failure.code));
    expect(Math.max(...registryCodes)).toBe(44);
    for (const spec of Object.values(BROKER_REJECTIONS)) {
      if ('code' in spec) expect(registryCodes.has(spec.code!), spec.reason).toBe(true);
    }
  });
});

// ── (D) §8.5 the projection split ───────────────────────────────────────────

describe('§8.5 the model-visible projection', () => {
  it('carries an EXHAUSTIVE field list that partitions keyof Task exactly', () => {
    // Compile-time exhaustiveness (`ProjectionIsExhaustive`) plus the runtime partition check.
    const union = new Set([...MODEL_VISIBLE_TASK_FIELDS, ...PROJECTION_WITHHELD_TASK_FIELDS]);
    const sample: Task = {
      id: 'aaaa', text: 't', why: 'w', done_when: 'd', priority: 'medium', status: 'open',
      template: 'benchmark-coder-review', plan: '', project: PROJECT, parent: null,
      depends_on: [], gpu: null, gpu_count: 0, blocked_by: null, claimed_by: null,
      claimed_at: null, dispatch_generation: GEN_1, paused: false, approval_needed: false,
      approved_at: null, not_before: null, completed_at: null, completed_note: null,
      pending_at: null, origin_session_id: null, origin_channel: null, origin_thread_id: null,
    };
    expect([...union].sort()).toEqual(Object.keys(sample).sort());
    expect(MODEL_VISIBLE_TASK_FIELDS).toHaveLength(21);
    expect(PROJECTION_WITHHELD_TASK_FIELDS).toHaveLength(6);
  });

  it('DROPS the claim and generation fields — §8.5\'s "not projected at all"', () => {
    const projected = projectTaskForModel({
      id: 'aaaa', text: 't', why: 'w', done_when: 'd', priority: 'medium', status: 'open',
      template: 'benchmark-coder-review', plan: '', project: PROJECT, parent: null,
      depends_on: [], gpu: null, gpu_count: 0, blocked_by: null, claimed_by: 'claimant',
      claimed_at: '2026-01-01', dispatch_generation: GEN_1, paused: false, approval_needed: false,
      approved_at: null, not_before: null, completed_at: null, completed_note: null,
      pending_at: null, origin_session_id: 's', origin_channel: 'c', origin_thread_id: 't',
    } as Task);
    expect(projected).not.toHaveProperty('dispatch_generation');
    expect(projected).not.toHaveProperty('claimed_by');
    expect(projected).not.toHaveProperty('claimed_at');
    expect(projected).not.toHaveProperty('origin_session_id');
    expect(projected).not.toHaveProperty('origin_channel');
    expect(projected).not.toHaveProperty('origin_thread_id');
    expect(projected).toHaveProperty('status', 'open');
    expect(projected).toHaveProperty('id', 'aaaa');
  });

  it('M16 — no broker response anywhere carries the token, the generation or the attempt id', async () => {
    const h = harness({ allowedActions: [...BENCHMARK_BROKER_ACTIONS] });
    const forbidden = ['dispatch_generation', 'attempt_id', 'token_id', 'trial_id',
      'role', 'ancestry', 'allowed_actions', 'issued_at_epoch_ms'];
    const responses = [
      await h.call('task.read', {}),
      await h.call('task.create', { text: 'x' }),
      await h.call('task.decompose', { subtasks: [{ text: 'x' }] }),
      await h.call('task.claim', { task_id: 'aaaa' }),
      await h.call('task.propose_complete', { note: 'n' }),
      await h.call('task.propose_block', { reason: 'r' }),
      await h.call('artifact.write', { content: 'c' }),
      await h.call('dependency.declare', { task_id: 'aaaa', depends_on: ['dddd'] }),
      await h.call('qa.ask', { question: 'q' }),
      await h.call('qa.answer', { question_id: 'q1', answer: 'a' }),
    ];
    for (const response of responses) {
      expect(response.ok).toBe(true);
      const json = JSON.stringify(response);
      for (const field of forbidden) expect(json, field).not.toContain(field);
      expect(json).not.toContain(GEN_1);
      expect(json).not.toContain('attempt-1');
    }
  });

  it('M17 — no ARGUMENT of any of the ten accepts a capability-shaped field (G5-W4.4/W4.5)', async () => {
    const h = harness({ allowedActions: [...BENCHMARK_BROKER_ACTIONS] });
    for (const action of BENCHMARK_BROKER_ACTIONS) {
      const payload: Record<string, unknown> = action === 'task.create'
        ? { text: 'x', dispatch_generation: GEN_1 }
        : action === 'task.read'
          ? { task_id: 'aaaa', attempt_id: 'attempt-1' }
          : { token_id: 'forged' };
      await expect(h.call(action, payload)).rejects.toThrow(BrokerArgumentsError);
      expect(h.touches).toEqual([]);
    }
  });

  it('a mutation attempted from projection-visible data ALONE is rejected', async () => {
    // The projection the model can see (what task_read returns) carries no generation, no attempt,
    // no token — so a mutation built from ONLY projection fields has nothing to fence itself
    // with. Outside the coordinator's scope the broker refuses before any guard: I3 fail-closed.
    const h = harness({ allowedActions: ['task.read', 'task.claim'] });
    const readOk = await h.call('task.read', {});
    expect(readOk.ok).toBe(true);
    const projected = (readOk as unknown as { result: { tasks: Record<string, unknown>[] } }).result.tasks;
    const seenTask = projected.find(row => row.id === 'dddd');
    expect(seenTask).toBeDefined();
    expect(seenTask).not.toHaveProperty('dispatch_generation');
    // The scope is empty: requireAmbientCapability must throw port_scope_escaped (32), never fall
    // back to an ambient default — the projection data grants nothing.
    await expect(
      h.broker.call('task.claim', { task_id: String(seenTask!.id) }),
    ).rejects.toThrow();
    // And echoing projection fields back AS a capability is a schema rejection, never honoured.
    await expect(h.call('task.claim', {
      task_id: String(seenTask!.id), dispatch_generation: 'echoed',
    })).rejects.toThrow(BrokerArgumentsError);
    expect(h.touches).toEqual([]);
  });
});
