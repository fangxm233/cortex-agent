// input:  the ten-action matrix and twelve rejections
// output: per-guard, refusal and no-tree-touch tests
// pos:    the §8 authorization fence, broker surface
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BENCHMARK_BROKER_ACTIONS, capabilityWhitelistForArm, mintActorCapability, type ActorCapability, type BenchmarkBrokerCapability } from '../../../src/domain/benchmark/capabilities.js';
import { isActionable } from '../../../src/core/task-parser.js';
import { createActorCapabilityRegistry, type ActorCapabilityRegistry } from '../../../src/domain/benchmark/actor-capability-scope.js';
import { BROKER_ACTION_TABLE, BROKER_REJECTIONS, BROKER_TOOL_NAMES, BrokerArgumentsError, MODEL_VISIBLE_TASK_FIELDS, PROJECTION_WITHHELD_TASK_FIELDS, createBenchmarkTaskBroker, projectTaskForModel, type BrokerCallResult, type BrokerPorts, type BrokerRefusal } from '../../../src/domain/benchmark/task-broker.js';
import { BENCHMARK_FAILURES, type ResolvedTrialPolicy } from '../../../src/domain/benchmark/resolved-policy.js';
import type { ArmDefinition } from '../../../src/domain/benchmark/arm-schema.js';
import type { Task } from '../../../src/core/task-parser.js';

const PROJECT = 'trial';
const TRIAL_ID = 'trial-1';
const GEN_1 = 'gen-1';

const SAMPLE_TASK = {
  id: 'aaaa', text: 't', why: 'w', done_when: 'd', priority: 'medium', status: 'open',
  template: 'benchmark-coder-review', plan: '', project: PROJECT, parent: null,
  depends_on: [], gpu: null, gpu_count: 0, blocked_by: null, claimed_by: null,
  claimed_at: null, dispatch_generation: GEN_1, paused: false, approval_needed: false,
  approved_at: null, not_before: null, completed_at: null, completed_note: null,
  pending_at: null, origin_session_id: null, origin_channel: null, origin_thread_id: null,
} as Task;

function armFor(mode: 'manager' | 'coder-review', askManager: boolean): ArmDefinition {
  return {
    kind: 'cortex',
    orchestration: mode === 'manager' ? { mode, ask_manager: askManager } : { mode, ask_manager: false, coder_review_variant: 'audit-retry' },
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
  claimTargetCalls: { requester: string; targetId: string }[];
  tasks: Map<string, Task>;
  trialRoot: string;
  call(action: BenchmarkBrokerCapability, payload?: Record<string, unknown>): Promise<BrokerCallResult>;
}

interface HarnessOptions {
  allowedActions?: BenchmarkBrokerCapability[]; askManager?: boolean; policyAskManager?: boolean;
  policyTrialId?: string; lockHolder?: string | null; ledgerThrows?: boolean; artifactPathOverride?: string;
  maxTasks?: number; maxTaskDepth?: number; generation?: string; taskGeneration?: string;
  attemptId?: string; ancestry?: string[]; taskId?: string;
  mutationResult?: { success: boolean; code?: number };
  proposalRefusal?: { success: false; message: string; code: 33 | 34 };
  proposalError?: { reason: 'proposal_invalidated' | 'ledger_unreadable'; code: 37 | 42 };
  proposalThrow?: Error; qaAnswerResult?: { success: boolean };
}

function harness(options: HarnessOptions = {}): Harness {
  const touches: string[] = [];
  const claimTargetCalls: { requester: string; targetId: string }[] = [];
  const trialRoot = mkdtempSync(path.join(tmpdir(), 'f228-trial-'));
  mkdirSync(path.join(trialRoot, 'manager', 'aaaa'), { recursive: true });
  const tasks = harnessTasks(options);
  const ports = harnessPorts(options, touches, trialRoot);
  const whitelist = capabilityWhitelistForArm(armFor('manager', options.askManager ?? true));
  const policy = harnessPolicy(options);
  const capabilities: ActorCapabilityRegistry = createActorCapabilityRegistry(TRIAL_ID);
  const capability = harnessCapability(options, whitelist, capabilities);
  const broker = createBenchmarkTaskBroker({
    policy, ports, capabilities, project: PROJECT, trialArtifactRoot: trialRoot,
    // §19.12.2: the model-facing claim routes through the injected dispatcher-owned callback.
    claimTarget: (requester: ActorCapability, id: string) => {
      claimTargetCalls.push({ requester: requester.task_id, targetId: id });
      return harnessMutation(options, touches, `claimTarget:${id}`);
    },
  });
  return { broker, capability, capabilities, touches, claimTargetCalls, tasks, trialRoot,
    call: (action, payload = {}) => capabilities.runInScope(capability, () => broker.call(action, payload)) };
}

function harnessTasks(options: HarnessOptions): Map<string, Task> {
  return new Map<string, Task>([
    ['root', taskRow({ id: 'root' })],
    ['bbbb', taskRow({ id: 'bbbb', parent: 'root' })],
    ['aaaa', taskRow({ id: 'aaaa', parent: 'bbbb', dispatch_generation: options.taskGeneration ?? GEN_1 })],
    ['dddd', taskRow({ id: 'dddd', parent: 'aaaa' })],
    ['cccc', taskRow({ id: 'cccc', parent: 'root' })],
    // §19.12.2 step 2 targets: a done (non-actionable) and an already-claimed descendant.
    ['e1', taskRow({ id: 'e1', parent: 'aaaa', status: 'done' })],
    ['f1', taskRow({ id: 'f1', parent: 'aaaa', claimed_by: 'someone', dispatch_generation: 'g-f1' })],
  ]);
}

function harnessMutation(options: HarnessOptions, touches: string[], touch: string): { success: boolean; code?: number } {
  const result = options.mutationResult ?? { success: true };
  if (result.success) touches.push(touch);
  return result;
}

function harnessPorts(options: HarnessOptions, touches: string[], trialRoot: string): BrokerPorts {
  return {
    taskRepository: {
      getById: (id: string) => harnessTasks(options).get(id) ?? null,
      list: (filter: { parent?: string }) => [...harnessTasks(options).values()].filter(task => (filter.parent === undefined ? true : task.parent === filter.parent)),
      // §19.12.2 step 2: the target must exist in the shipped actionable set.
      getActionable: () => [...harnessTasks(options).values()].filter(task => isActionable(task)),
    },
    taskMutator: {
      // §19.12.1: claim is REMOVED from the narrowed broker view — the model-facing claim
      // routes through the injected claimTarget callback, never through P3.claim directly.
      add: (_capability: ActorCapability) => harnessMutation(options, touches, 'mutator.add'),
      decompose: (_capability: ActorCapability) => harnessMutation(options, touches, 'mutator.decompose'),
      edit: (_capability: ActorCapability) => harnessMutation(options, touches, 'mutator.edit'),
      proposeComplete: (_capability: ActorCapability, id: string) => proposalResult(options, touches, 'mutator.proposeComplete', id),
      proposeBlock: (_capability: ActorCapability, id: string) => proposalResult(options, touches, 'mutator.proposeBlock', id),
    },
    taskLocks: { assertHeld: () => (options.lockHolder === undefined ? null : options.lockHolder) },
    taskArtifacts: {
      artifactPath: (_project: string, id: string) => options.artifactPathOverride ?? path.join(trialRoot, 'manager', id, 'artifact.md'),
      write: (_capability: ActorCapability) => { touches.push('artifacts.write'); },
    },
    acceptanceLedger: {
      pending: () => {
        if (options.ledgerThrows) throw new Error('ENOENT: ledger gone');
        return [];
      },
    },
    managerQa: {
      ask: (_capability: ActorCapability) => { touches.push('qa.ask'); return { questionId: 'q1' }; },
      answer: (_capability: ActorCapability) => {
        const result = options.qaAnswerResult ?? { success: true };
        if (result.success) touches.push('qa.answer');
        return result;
      },
    },
    parentQuestions: {
      record: (_capability: ActorCapability) => { touches.push('parentQuestions.record'); return { questionId: 'pq1' }; },
    },
  } as unknown as BrokerPorts;
}

function proposalResult(options: HarnessOptions, touches: string[], touch: string, id: string): { state: string } | { success: false; message: string; code: 33 | 34 } {
  if (options.proposalThrow) throw options.proposalThrow;
  if (options.proposalError) throw Object.assign(new Error('proposal failed'), options.proposalError);
  if (options.proposalRefusal) return options.proposalRefusal;
  touches.push(`${touch}:${id}`);
  return { state: 'proposed' };
}

function harnessPolicy(options: HarnessOptions): ResolvedTrialPolicy {
  return {
    trial_id: options.policyTrialId ?? TRIAL_ID,
    child_template_whitelist: ['benchmark-coder-review', 'benchmark-manager'],
    capability_whitelist: capabilityWhitelistForArm(
      armFor('manager', options.policyAskManager ?? options.askManager ?? true),
    ),
    limits: { max_tasks: options.maxTasks ?? 20, max_task_depth: options.maxTaskDepth ?? 4 },
  } as unknown as ResolvedTrialPolicy;
}

function harnessCapability(
  options: HarnessOptions, whitelist: BenchmarkBrokerCapability[], capabilities: ActorCapabilityRegistry,
): ActorCapability {
  const taskId = options.taskId ?? 'aaaa';
  const capability = mintActorCapability({
    trial_id: TRIAL_ID, task_id: taskId, dispatch_generation: options.generation ?? GEN_1,
    attempt_id: options.attemptId ?? 'attempt-1', role: 'manager',
    ancestry: options.ancestry ?? (taskId === 'root' ? [] : ['root', 'bbbb']),
    capability_whitelist: whitelist, allowed_actions: options.allowedActions, issued_at_epoch_ms: 1_000,
  });
  capabilities.register(capability);
  return capability;
}

function refusal(result: BrokerCallResult): BrokerRefusal {
  expect(result.ok).toBe(false);
  expect(result.status).toBe('rejected');
  return result as BrokerRefusal;
}

type OkCall = { action: BenchmarkBrokerCapability; payload: Record<string, unknown>; expected: Record<string, unknown>; touch?: string };
const OK_CALLS: OkCall[] = [
  { action: 'task.read', payload: {}, expected: { tasks: expect.any(Array) } },
  { action: 'task.create', payload: { text: 'new task' }, expected: { created: true }, touch: 'mutator.add' },
  { action: 'task.decompose', payload: { subtasks: [{ text: 'child' }] }, expected: { decomposed: true }, touch: 'mutator.decompose' },
  { action: 'task.claim', payload: { task_id: 'dddd' }, expected: { claimed: 'dddd' } },
  { action: 'task.propose_complete', payload: { note: 'done' }, expected: { proposal_recorded: true } },
  { action: 'task.propose_block', payload: { reason: 'blocked' }, expected: { proposal_recorded: true } },
  { action: 'artifact.write', payload: { content: 'artifact' }, expected: { written: true }, touch: 'artifacts.write' },
  { action: 'dependency.declare', payload: { task_id: 'aaaa', depends_on: ['dddd'] }, expected: { declared: true }, touch: 'mutator.edit' },
  { action: 'qa.ask', payload: { question: 'question?' }, expected: { question_id: 'q1' } },
  { action: 'qa.answer', payload: { question_id: 'q1', answer: 'yes' }, expected: { answered: true } },
];

describe('§8.3 the authorization matrix is a closed table of exactly ten actions', () => {
  it('has one row per action of BENCHMARK_BROKER_ACTIONS and no others', () => {
    expect(Object.keys(BROKER_ACTION_TABLE).sort()).toEqual([...BENCHMARK_BROKER_ACTIONS].sort());
    expect(Object.keys(BROKER_ACTION_TABLE)).toHaveLength(10);
  });
  it('carries no task.complete, task.block or task.uncomplete row (§8.6)', () => {
    expect(BROKER_ACTION_TABLE).not.toHaveProperty('task.complete');
    expect(BROKER_ACTION_TABLE).not.toHaveProperty('task.block');
    expect(BROKER_ACTION_TABLE).not.toHaveProperty('task.uncomplete');
  });
});
describe('§8.3 — the closed union, enforced at type and runtime level', () => {
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
    await expect(h.capabilities.runInScope(h.capability, () => h.broker.call('task.complete' as BenchmarkBrokerCapability, {}))).rejects.toThrow(BrokerArgumentsError);
    expect(h.touches).toEqual([]);
  });
});
describe('§8.3 — tool names and per-row guard lists', () => {
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

});
describe('§8.3 — per-row guard lists', () => {
  it('gives every row a GUARD list, not merely membership (§8.3\'s guard column)', () => {
    for (const action of BENCHMARK_BROKER_ACTIONS) {
      expect(BROKER_ACTION_TABLE[action].guards.length, action).toBeGreaterThan(0);
    }
    expect(BROKER_ACTION_TABLE['task.create'].guards).toEqual(expect.arrayContaining(['lock_held', 'template_whitelisted', 'task_budget', 'depth_budget']));
    expect(BROKER_ACTION_TABLE['task.decompose'].guards).toEqual(expect.arrayContaining(['generation_current', 'template_whitelisted', 'task_budget', 'depth_budget']));
    expect(BROKER_ACTION_TABLE['task.propose_complete'].guards).toEqual(expect.arrayContaining(['target_self', 'generation_current', 'ledger_readable']));
    expect(BROKER_ACTION_TABLE['task.claim'].guards).toEqual(['generation_current', 'in_branch', 'claimable_target']);
    expect(BROKER_ACTION_TABLE['dependency.declare'].guards).toEqual(['in_branch_endpoints', 'acyclic']);
    expect(BROKER_ACTION_TABLE['artifact.write'].guards).toEqual(['trial_path']);
  });
});
describe('§8.3 — frozen tables and schema exclusions', () => {
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
});
describe('§8.3 — well-formed calls pass on every authorised action', () => {
  it('honours a well-formed call on each authorised action, so the guards are not a blanket deny', async () => {
    const h = harness({ allowedActions: [...BENCHMARK_BROKER_ACTIONS] });
    for (const entry of OK_CALLS) {
      const result = await h.call(entry.action, entry.payload);
      expect(result.ok).toBe(true);
      expect((result as { result: Record<string, unknown> }).result).toEqual(entry.expected);
      if (entry.touch) expect(h.touches).toContain(entry.touch);
    }
  });
  it('routes a root manager qa.ask to the direct-parent bridge, never ask_manager', async () => {
    const h = harness({ taskId: 'root', allowedActions: ['qa.ask'] });
    expect((await h.call('qa.ask', { question: 'root question' })).ok).toBe(true);
    expect(h.touches).toEqual(['parentQuestions.record']);
  });
});
describe('§8.3 — qa.* refusals, typed failures and the strict schema', () => {
  it('returns answer_stale when the P13 acceptance predicate refuses qa.answer', async () => {
    const h = harness({ allowedActions: ['qa.answer'], qaAnswerResult: { success: false } });
    const result = refusal(await h.call('qa.answer', { question_id: 'missing', answer: 'no' }));
    expect(result.reason).toBe('answer_stale');
    expect(result).not.toHaveProperty('code');
    expect(h.touches).toEqual([]);
  });
  it('translates typed proposal-port failures into refusal frames instead of rejecting the call', async () => {
    const h = harness({ allowedActions: ['task.propose_complete'],
      proposalError: { reason: 'proposal_invalidated', code: 37 } });
    const result = refusal(await h.call('task.propose_complete', { note: 'stale proposal' }));
    expect(result.reason).toBe('proposal_invalidated');
    expect(result.code).toBe(37);
    expect(h.touches).toEqual([]);
  });
  it('runs the strict G5-W5 schema before any action guard or port effect', async () => {
    const h = harness({ allowedActions: [...BENCHMARK_BROKER_ACTIONS] });
    await expect(h.call('task.create', {})).rejects.toThrow(BrokerArgumentsError);
    expect(h.touches).toEqual([]);
  });
});
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
    const newer = mintActorCapability({
      trial_id: TRIAL_ID, task_id: 'aaaa', dispatch_generation: GEN_1, attempt_id: 'attempt-2',
      role: 'manager', ancestry: ['root', 'bbbb'], capability_whitelist: capabilityWhitelistForArm(armFor('manager', true)), issued_at_epoch_ms: 2_000,
    });
    h.capabilities.register(newer);
    expect(h.capabilities.currentAttempt('aaaa')).toEqual({ dispatch_generation: GEN_1, attempt_id: 'attempt-2' });
    const result = refusal(await h.call('task.propose_complete', { note: 'done' }));
    expect(result.code).toBe(34);
    expect(result.reason).toBe('stale_generation');
    expect(h.touches).toEqual([]);
  });

});
describe('§8.4 R1 — decompose guard, D-9 attempt and P3 propagation', () => {
  it('decompose is generation-guarded too ("ownership generation matches", §8.3)', async () => {
    const h = harness({ generation: 'gen-0', taskGeneration: GEN_1 });
    const result = refusal(await h.call('task.decompose', { subtasks: [{ text: 'child' }] }));
    expect(result.code).toBe(34);
    expect(h.touches).toEqual([]);
  });
  it('propagates P3 stale_generation instead of reporting a mutation that did not happen', async () => {
    const h = harness({ mutationResult: { success: false, code: 34 } });
    const result = refusal(await h.call('task.claim', { task_id: 'dddd' }));
    expect([result.code, result.reason]).toEqual([34, 'stale_generation']);
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
    expect(h.touches).toEqual(['claimTarget:dddd']);
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
    const result = refusal(await h.call('dependency.declare', { task_id: 'aaaa', depends_on: ['bbbb'] }));
    expect(result.code).toBe(35);
    expect(result.reason).toBe('parent_completion_by_child');
    expect(h.touches).toEqual([]);
  });
  it('refuses a proposal that targets an ancestor as R3, before the generic R4', async () => {
    const h = harness();
    const result = refusal(await h.broker.proposeComplete(h.capability, 'bbbb', 'done'));
    expect(result.code).toBe(35);
    expect(result.reason).toBe('parent_completion_by_child');
    expect(h.touches).toEqual([]);
  });
});
describe('§8.4 R4 proposal_target_not_self → code 35', () => {
  it('refuses a proposal naming a non-self, non-ancestor task on the leg-1 signature', async () => {
    const h = harness();
    const result = refusal(await h.capabilities.runInScope(h.capability, () => h.broker.proposeComplete(h.capability, 'cccc', 'done')));
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
    expect(code20.failureClass).toBe('P');
  });
  it('admits a whitelisted template, so the rule discriminates', async () => {
    const h = harness();
    const result = await h.call('task.create', { text: 'x', template: 'benchmark-coder-review' });
    expect(result.ok).toBe(true);
  });
});
describe('§8.4 R6 — subtask templates are checked, not just the top level', () => {
  it('checks every subtask template of a decompose, not just the top level', async () => {
    const h = harness();
    const result = refusal(await h.call('task.decompose', { subtasks: [{ text: 'x', template: 'not-whitelisted' }] }));
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
    const h = harness({ askManager: true, policyAskManager: false });
    const ask = refusal(await h.call('qa.ask', { question: 'q' }));
    expect(ask.code).toBe(33);
    expect(h.touches).toEqual([]);
    const answer = refusal(await h.call('qa.answer', { question_id: 'q1', answer: 'a' }));
    expect(answer.code).toBe(33);
    expect(h.touches).toEqual([]);
  });
  it('propagates P3 capability_denied instead of reporting a mutation that did not happen', async () => {
    const h = harness({ mutationResult: { success: false, code: 33 } });
    const result = refusal(await h.call('task.create', { text: 'x' }));
    expect([result.code, result.reason]).toEqual([33, 'capability_denied']);
    expect(h.touches).toEqual([]);
  });
});
describe('§8.4 R9 budget_exceeded → NO CODE (§18 G5-N4 interim rule)', () => {
  it('refuses a create that would push the trial past max_tasks, code KEY absent', async () => {
    const h = harness({ maxTasks: 7 }); // 7 tasks already in the table
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
  it('counts every child in a decompose against max_tasks, not the request as one task', async () => {
    const h = harness({ maxTasks: 8 }); // 7 existing rows; two children would make 9
    const result = refusal(await h.call('task.decompose', { subtasks: [{ text: 'first' }, { text: 'second' }] }));
    expect([result.reason, 'code' in result]).toEqual(['budget_exceeded', false]);
    expect(h.touches).toEqual([]);
  });
  it('admits a create inside both bounds, so the rules discriminate', async () => {
    const h = harness({ maxTasks: 9, maxTaskDepth: 3 });
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
  it('refuses a forged clone on the coordinator-internal proposal surface', async () => {
    const h = harness({ allowedActions: ['task.read'] });
    const widenedClone = Object.freeze({ ...h.capability, allowed_actions: new Set<BenchmarkBrokerCapability>(['task.read', 'task.propose_complete']) });
    const result = refusal(await h.broker.proposeComplete(widenedClone, 'aaaa', 'forged'));
    expect(result.code).toBe(27);
    expect(result.reason).toBe('token_invalid');
    expect(h.touches).toEqual([]);
  });
  it('refuses a capability invalidated between registration and call (§8.2 lifetime)', async () => {
    const h = harness();
    const result = refusal(await h.capabilities.runInScope(h.capability, async () => {
      h.capabilities.invalidateToken(h.capability.token_id);
      return h.broker.call('task.read', {});
    }));
    expect(result.code).toBe(27);
    expect(result.reason).toBe('token_invalid');
    expect(h.touches).toEqual([]);
  });
  it('refuses a capability minted for another trial', async () => {
    const h = harness({ policyTrialId: 'other-trial' });
    const result = refusal(await h.call('task.read', {}));
    expect(result.code).toBe(27);
    expect(result.reason).toBe('token_invalid');
    expect(h.touches).toEqual([]);
  });
});
describe('§8.5 the model-visible projection', () => {
  it('carries an EXHAUSTIVE field list that partitions keyof Task exactly', () => {
    const union = new Set([...MODEL_VISIBLE_TASK_FIELDS, ...PROJECTION_WITHHELD_TASK_FIELDS]);
    expect([...union].sort()).toEqual(Object.keys(SAMPLE_TASK).sort());
    expect(MODEL_VISIBLE_TASK_FIELDS).toHaveLength(21);
    expect(PROJECTION_WITHHELD_TASK_FIELDS).toHaveLength(6);
  });

});
describe('§8.5 — detached projection and field drops', () => {
  it('returns a detached projection whose arrays cannot mutate authoritative task state', () => {
    const authoritative = taskRow({ id: 'aaaa', depends_on: ['dddd'] });
    const projected = projectTaskForModel(authoritative);
    expect(projected.depends_on).not.toBe(authoritative.depends_on);
    expect(Object.isFrozen(projected.depends_on)).toBe(true);
    expect(() => (projected.depends_on as string[]).push('cccc')).toThrow(TypeError);
    expect(authoritative.depends_on).toEqual(['dddd']);
  });
  it('DROPS the claim and generation fields — §8.5\'s "not projected at all"', () => {
    const projected = projectTaskForModel({
      ...SAMPLE_TASK, claimed_by: 'claimant', claimed_at: '2026-01-01',
      origin_session_id: 's', origin_channel: 'c', origin_thread_id: 't',
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

});
describe('§8.5 — M16: no response carries token, generation or attempt', () => {
  it('M16 — no broker response anywhere carries the token, the generation or the attempt id', async () => {
    const h = harness({ allowedActions: [...BENCHMARK_BROKER_ACTIONS] });
    const forbidden = ['dispatch_generation', 'attempt_id', 'token_id', 'trial_id', 'role', 'ancestry', 'allowed_actions', 'issued_at_epoch_ms'];
    const responses = [
      await h.call('task.read', {}), await h.call('task.create', { text: 'x' }),
      await h.call('task.decompose', { subtasks: [{ text: 'x' }] }), await h.call('task.claim', { task_id: 'dddd' }),
      await h.call('task.propose_complete', { note: 'n' }), await h.call('task.propose_block', { reason: 'r' }),
      await h.call('artifact.write', { content: 'c' }), await h.call('dependency.declare', { task_id: 'aaaa', depends_on: ['dddd'] }),
      await h.call('qa.ask', { question: 'q' }), await h.call('qa.answer', { question_id: 'q1', answer: 'a' }),
    ];
    for (const response of responses) {
      expect(response.ok).toBe(true);
      const json = JSON.stringify(response);
      for (const field of forbidden) expect(json, field).not.toContain(field);
      expect(json).not.toContain(GEN_1);
      expect(json).not.toContain('attempt-1');
    }
  });

});
describe('§8.5 — M17: no argument accepts a capability-shaped field', () => {
const CAPABILITY_FORGED_PAYLOADS: Record<BenchmarkBrokerCapability, Record<string, unknown>> = {
  'task.create': { text: 'x', dispatch_generation: GEN_1 },
  'task.read': { task_id: 'aaaa', attempt_id: 'attempt-1' },
  'task.decompose': { subtasks: [{ text: 'x', token_id: 'forged' }] },
  'task.claim': { token_id: 'forged' },
  'task.propose_complete': { token_id: 'forged' },
  'task.propose_block': { token_id: 'forged' },
  'artifact.write': { token_id: 'forged' },
  'dependency.declare': { token_id: 'forged' },
  'qa.ask': { token_id: 'forged' },
  'qa.answer': { token_id: 'forged' },
};

  it('M17 — no ARGUMENT of any of the ten accepts a capability-shaped field (G5-W4.4/W4.5)', async () => {
    const h = harness({ allowedActions: [...BENCHMARK_BROKER_ACTIONS] });
    for (const action of BENCHMARK_BROKER_ACTIONS) {
      const payload = CAPABILITY_FORGED_PAYLOADS[action];
      await expect(h.call(action, payload)).rejects.toThrow(BrokerArgumentsError);
      expect(h.touches).toEqual([]);
    }
    await expect(h.call('task.decompose', { subtasks: [{ text: 'x', attempt_id: 'attempt-1' }] })).rejects.toThrow(BrokerArgumentsError);
    expect(h.touches).toEqual([]);
  });

});
describe('§8.5 — projection data alone cannot drive a mutation', () => {
  it('a mutation attempted from projection-visible data ALONE is rejected', async () => {
    const h = harness({ allowedActions: ['task.read', 'task.claim'] });
    const readOk = await h.call('task.read', {});
    expect(readOk.ok).toBe(true);
    const projected = (readOk as unknown as { result: { tasks: Record<string, unknown>[] } }).result.tasks;
    const seenTask = projected.find(row => row.id === 'dddd');
    expect(seenTask).toBeDefined();
    expect(seenTask).not.toHaveProperty('dispatch_generation');
    await expect(h.broker.call('task.claim', { task_id: String(seenTask!.id) })).rejects.toThrow();
    await expect(h.call('task.claim', { task_id: String(seenTask!.id), dispatch_generation: 'echoed' })).rejects.toThrow(BrokerArgumentsError);
    expect(h.touches).toEqual([]);
  });
});
describe('§19.12.2 — task.claim is a two-leg broker transaction through the injected claimTarget', () => {
  it('routes the claim through claimTarget(requester, targetId) and never through taskMutator.claim', async () => {
    const h = harness({ allowedActions: [...BENCHMARK_BROKER_ACTIONS] });
    const result = await h.call('task.claim', { task_id: 'dddd' });
    expect(result.ok).toBe(true);
    expect((result as { result: Record<string, unknown> }).result).toEqual({ claimed: 'dddd' });
    expect(h.claimTargetCalls).toEqual([{ requester: 'aaaa', targetId: 'dddd' }]);
    expect(h.touches).toEqual(['claimTarget:dddd']);
    // No generation or attempt ever enters the callback arguments (G5-W4.5).
    for (const needle of ['generation', 'attempt']) expect(JSON.stringify(h.claimTargetCalls)).not.toContain(needle);
  });
  it('checks requester generation/attempt currency on the requester row BEFORE any claimTarget call', async () => {
    const h = harness({ generation: 'gen-0', taskGeneration: GEN_1 }); // stale requester
    const result = refusal(await h.call('task.claim', { task_id: 'dddd' }));
    expect([result.code, result.reason]).toEqual([34, 'stale_generation']);
    expect(h.claimTargetCalls).toEqual([]);
    expect(h.touches).toEqual([]);
  });

});
describe('§19.12.2 — registry generation is checked even when the attempt id is reused', () => {
  it('checks the requester registry generation even when the attempt id is reused', async () => {
    const h = harness({ allowedActions: ['task.claim'] });
    const superseding = mintActorCapability({
      trial_id: TRIAL_ID, task_id: h.capability.task_id, dispatch_generation: 'gen-2',
      attempt_id: h.capability.attempt_id, role: h.capability.role, ancestry: h.capability.ancestry,
      capability_whitelist: ['task.claim'], issued_at_epoch_ms: 2_000,
    });
    h.capabilities.register(superseding);
    const result = refusal(await h.call('task.claim', { task_id: 'dddd' }));
    expect([result.code, result.reason]).toEqual([34, 'stale_generation']);
    expect(h.claimTargetCalls).toEqual([]);
    expect(h.touches).toEqual([]);
  });
});
describe('§19.12.2 — claim target proof precedes the callback', () => {
  it('refuses self, non-actionable and already-claimed targets before any claimTarget call', async () => {
    const h = harness();
    await expect(h.call('task.claim', { task_id: 'aaaa' })).rejects.toThrow(BrokerArgumentsError); // self
    await expect(h.call('task.claim', { task_id: 'e1' })).rejects.toThrow(BrokerArgumentsError); // done
    await expect(h.call('task.claim', { task_id: 'f1' })).rejects.toThrow(BrokerArgumentsError); // claimed
    expect(h.claimTargetCalls).toEqual([]);
    expect(h.touches).toEqual([]);
  });
  it('refuses ancestor (R3) and cross-branch (R2) targets before any claimTarget call', async () => {
    const h = harness();
    const ancestor = refusal(await h.call('task.claim', { task_id: 'bbbb' }));
    expect([ancestor.code, ancestor.reason]).toEqual([35, 'parent_completion_by_child']);
    const cross = refusal(await h.call('task.claim', { task_id: 'cccc' }));
    expect([cross.code, cross.reason]).toEqual([35, 'cross_branch_mutation']);
    expect(h.claimTargetCalls).toEqual([]);
    expect(h.touches).toEqual([]);
  });

});
describe('§19.12.2 — claimTarget refusal translation', () => {
  it('translates a claimTarget refusal 33/34 through R8/R1 like any other P3 mutation', async () => {
    const h = harness({ mutationResult: { success: false, code: 33 } });
    const denied = refusal(await h.call('task.claim', { task_id: 'dddd' }));
    expect([denied.code, denied.reason]).toEqual([33, 'capability_denied']);
    const h34 = harness({ mutationResult: { success: false, code: 34 } });
    const stale = refusal(await h34.call('task.claim', { task_id: 'dddd' }));
    expect([stale.code, stale.reason]).toEqual([34, 'stale_generation']);
    expect(h34.touches).toEqual([]);
  });
});
describe('§19.12.1/§19.12.6 — the proposal union narrows by literal success:false', () => {
  it('a MutationRefusal 33 narrows to an R8 capability_denied refusal before any store access', async () => {
    const h = harness({
      allowedActions: ['task.propose_complete'],
      proposalRefusal: { success: false, message: 'not allowed', code: 33 },
    });
    const result = refusal(await h.call('task.propose_complete', { note: 'n' }));
    expect([result.code, result.reason]).toEqual([33, 'capability_denied']);
    expect(h.touches).toEqual([]); // the store was never touched
  });
  it('a MutationRefusal 34 narrows to an R1 stale_generation refusal before any store access', async () => {
    const h = harness({
      allowedActions: ['task.propose_block'],
      proposalRefusal: { success: false, message: 'stale', code: 34 },
    });
    const result = refusal(await h.call('task.propose_block', { reason: 'r' }));
    expect([result.code, result.reason]).toEqual([34, 'stale_generation']);
    expect(h.touches).toEqual([]);
  });

});
describe('§19.12.1/§19.12.6 — the proposal ack and by-value refusals', () => {
  it('a valid proposal keeps the bare proposal_recorded ack — no row fields reach the model', async () => {
    const h = harness({ allowedActions: ['task.propose_complete'] });
    const result = await h.call('task.propose_complete', { note: 'done' });
    expect(result.ok).toBe(true);
    expect((result as { result: Record<string, unknown> }).result).toEqual({ proposal_recorded: true });
    expect(JSON.stringify(result)).not.toContain('state');
    expect(JSON.stringify(result)).not.toContain('intent');
  });
  it('proposal refusal codes 33/34 are returned by value, never thrown', async () => {
    const h = harness({
      allowedActions: ['task.propose_complete'],
      proposalRefusal: { success: false, message: 'stale', code: 34 },
    });
    const result = await h.call('task.propose_complete', { note: 'n' });
    expect(result.ok).toBe(false);
    expect(result).not.toBeInstanceOf(Error);
  });
});
describe('§19.12.6 — typedPortFailure matches the public reason, never detail', () => {
  it('a store failure carries reason ledger_unreadable + code 42 to the refusal frame', async () => {
    const h = harness({
      allowedActions: ['task.propose_complete'],
      proposalError: { reason: 'ledger_unreadable', code: 42 },
    });
    const result = refusal(await h.call('task.propose_complete', { note: 'n' }));
    expect([result.code, result.reason]).toEqual([42, 'ledger_unreadable']);
    expect(h.touches).toEqual([]);
  });
  it('an unknown port error is rethrown, never swallowed or mistranslated', async () => {
    const unknown = new Error('mystery failure');
    const h = harness({ allowedActions: ['task.propose_complete'], proposalThrow: unknown });
    await expect(h.call('task.propose_complete', { note: 'n' })).rejects.toBe(unknown);
    expect(h.touches).toEqual([]);
  });
});
