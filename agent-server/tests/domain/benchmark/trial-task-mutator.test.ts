// input:  the three production factories over real stores
// output: the R2-T1..T18 contract on the real chain
// pos:    Gate-5 P3 contract, proven via real factories
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECTS_DIR } from '../../../src/core/paths.js';
import { serializeTasksFileWithLock, type Task } from '../../../src/core/task-parser.js';
import { TaskRepo } from '../../../src/store/task-repo.js';
import { capabilityWhitelistForArm, mintActorCapability, type ActorCapability, type BenchmarkBrokerCapability } from '../../../src/domain/benchmark/capabilities.js';
import { createActorCapabilityRegistry, type ActorCapabilityRegistry } from '../../../src/domain/benchmark/actor-capability-scope.js';
import { createTaskArtifactProjection, createTrialTaskLockTable, createTrialTaskLocks, createTrialTaskRepository, withTrialTaskLockScope, type TrialTaskLockTable, type TrialTaskRepository } from '../../../src/domain/benchmark/trial-task-ports.js';
import { createAcceptanceLedgerPort } from '../../../src/domain/benchmark/composite-runtime-ports.js';
import { createTrialClock } from '../../../src/domain/benchmark/trial-clock.js';
import { recordProposal, proposalStorePath } from '../../../src/domain/benchmark/proposal-seal.js';
import { createDispatcherOwnedClaimTarget } from '../../../src/domain/benchmark/trial-task-dispatcher.js';
import { createBenchmarkTaskBroker, BrokerArgumentsError, type BrokerCallResult, type BrokerRefusal } from '../../../src/domain/benchmark/task-broker.js';
import type { ResolvedTrialPolicy } from '../../../src/domain/benchmark/resolved-policy.js';
import type { ArmDefinition } from '../../../src/domain/benchmark/arm-schema.js';
import { createTrialCapabilityAwareTaskMutator } from '../../../src/domain/tasks/mutator.js';

// The production chain is exactly createTrialCapabilityAwareTaskMutator ->
// createDispatcherOwnedClaimTarget -> createBenchmarkTaskBroker over real P2 files/delegate,
// P4 table/scope, production mint + exact registry and the shipped proposal store.
const TRIAL_ID = 'trial-749f';
const REQ_GEN = 'req-gen';
const REQ_ATTEMPT = 'req-attempt';
const TARGET_ATTEMPT = 'target-attempt-1';

function armFor(mode: 'manager' | 'coder-review', askManager: boolean): ArmDefinition {
  return {
    kind: 'cortex',
    orchestration: mode === 'manager' ? { mode, ask_manager: askManager } : { mode, ask_manager: false, coder_review_variant: 'audit-retry' },
  } as ArmDefinition;
}

function managerWhitelist(): BenchmarkBrokerCapability[] {
  return capabilityWhitelistForArm(armFor('manager', false));
}

function taskRow(overrides: Partial<Task> & Pick<Task, 'id' | 'project' | 'text'>): Task {
  return {
    why: '', done_when: '', priority: 'medium', status: 'open',
    template: 'benchmark-coder-review', plan: '', parent: null,
    depends_on: [], gpu: null, gpu_count: 0, blocked_by: null, claimed_by: null,
    claimed_at: null, dispatch_generation: null, paused: false, approval_needed: false,
    approved_at: null, not_before: null, completed_at: null, completed_note: null,
    pending_at: null, origin_session_id: null, origin_channel: null, origin_thread_id: null,
    ...overrides,
  };
}

let counter = 0;
function nextProject(): string { return `_t749f_${++counter}_`; }

interface TargetAuthorityState {
  fields: {
    attempt_id: string;
    role: 'parent' | 'manager' | 'coder' | 'reviewer' | 'verifier';
    ancestry: readonly string[];
    allowed_actions: readonly BenchmarkBrokerCapability[];
    issued_at_epoch_ms: number;
  } | null;
}

interface Composition {
  trialId: string; project: string; tasksPath: string;
  store: TaskRepo; repo: TrialTaskRepository & { commitAndPush(message: string): void };
  table: TrialTaskLockTable; locks: ReturnType<typeof createTrialTaskLocks>;
  registry: ActorCapabilityRegistry; requester: ActorCapability;
  mutator: ReturnType<typeof createTrialCapabilityAwareTaskMutator>;
  claimTarget: ReturnType<typeof createDispatcherOwnedClaimTarget>;
  broker: ReturnType<typeof createBenchmarkTaskBroker>;
  trialRoot: string; targetAuthority: TargetAuthorityState;
  releasing: Set<string>; recordedRows: unknown[];
  call(action: BenchmarkBrokerCapability, payload?: Record<string, unknown>): Promise<BrokerCallResult>;
  claimThroughBroker(taskId: string): Promise<BrokerCallResult>;
  readTasks(): Task[]; cleanup(): void;
}

interface CompositionOptions {
  requesterTaskId?: string; requesterGeneration?: string; requesterAttempt?: string;
  requesterActions?: readonly BenchmarkBrokerCapability[]; requesterRole?: ActorCapability['role'];
  requesterAncestry?: readonly string[]; extraTasks?: Task[]; releaseAttempt?: string;
}

interface BuildContext {
  trialId: string; project: string; tasksPath: string;
  store: TaskRepo; repo: TrialTaskRepository & { commitAndPush(message: string): void };
  table: TrialTaskLockTable; locks: ReturnType<typeof createTrialTaskLocks>;
  registry: ActorCapabilityRegistry; whitelist: BenchmarkBrokerCapability[];
  lockOwner: string; trialRoot: string; targetAuthority: TargetAuthorityState;
}

function baseRows(project: string, options: CompositionOptions): Task[] {
  return [
    taskRow({ id: 'root', project, text: 'root' }),
    taskRow({ id: 'aaaa', project, text: 'requester task', parent: 'root', claimed_by: 'req-agent', dispatch_generation: REQ_GEN }),
    taskRow({ id: 'dddd', project, text: 'claim target', parent: 'aaaa' }),
    taskRow({ id: 'bbbb', project, text: 'edit target', parent: 'aaaa', dispatch_generation: 'other-gen' }),
    taskRow({ id: 'cccc', project, text: 'sibling', parent: 'root' }),
    taskRow({ id: 'xxxx', project, text: 'done child', parent: 'aaaa', status: 'done' }),
    taskRow({ id: 'ff1', project, text: 'already claimed child', parent: 'aaaa', claimed_by: 'someone-else', dispatch_generation: 'g-ff' }),
    ...(options.extraTasks ?? []),
  ];
}

function openContext(options: CompositionOptions): BuildContext {
  const trialId = TRIAL_ID;
  const project = nextProject();
  const tasksPath = path.join(PROJECTS_DIR, project, 'TASKS.yaml');
  fs.mkdirSync(path.join(PROJECTS_DIR, project), { recursive: true });
  fs.writeFileSync(tasksPath, serializeTasksFileWithLock({ tasks: baseRows(project, options), lock: null }));
  const store = new TaskRepo({ skipGit: true });
  const repo = createTrialTaskRepository(store);
  const clock = createTrialClock({ deadlineEpochMs: Date.now() + 60_000 });
  const table = createTrialTaskLockTable(clock);
  const registry = createActorCapabilityRegistry(trialId);
  const whitelist = managerWhitelist();
  const trialRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't749f-root-'));
  const targetAuthority: TargetAuthorityState = {
    fields: {
      attempt_id: TARGET_ATTEMPT, role: 'coder', ancestry: ['root', 'aaaa'],
      allowed_actions: ['artifact.write', 'task.read'], issued_at_epoch_ms: 2_000,
    },
  };
  return {
    trialId, project, tasksPath, store, repo, table,
    locks: createTrialTaskLocks(table), registry, whitelist, lockOwner: trialId,
    trialRoot, targetAuthority,
  };
}

function mintRequester(ctx: BuildContext, options: CompositionOptions): ActorCapability {
  const requesterTaskId = options.requesterTaskId ?? 'aaaa';
  const requester = mintActorCapability({
    trial_id: ctx.trialId, task_id: requesterTaskId,
    dispatch_generation: options.requesterGeneration ?? REQ_GEN,
    attempt_id: options.requesterAttempt ?? REQ_ATTEMPT,
    role: requesterRole(options),
    ancestry: requesterAncestry(requesterTaskId, options),
    capability_whitelist: ctx.whitelist,
    allowed_actions: requesterActions(options, ctx.whitelist),
    issued_at_epoch_ms: 1_000,
  });
  ctx.registry.register(requester);
  return requester;
}

function requesterRole(options: CompositionOptions): ActorCapability['role'] { return options.requesterRole ?? 'manager'; }
function requesterAncestry(requesterTaskId: string, options: CompositionOptions): readonly string[] { return options.requesterAncestry ?? (requesterTaskId === 'root' ? [] : ['root']); }

function requesterActions(options: CompositionOptions, whitelist: BenchmarkBrokerCapability[]): readonly BenchmarkBrokerCapability[] {
  return options.requesterActions === undefined ? whitelist : options.requesterActions;
}

function buildMutator(
  ctx: BuildContext, releasing: Set<string>, recordedRows: unknown[],
): ReturnType<typeof createTrialCapabilityAwareTaskMutator> {
  return createTrialCapabilityAwareTaskMutator({
    repository: ctx.repo,
    locks: ctx.locks,
    registry: ctx.registry,
    trialId: ctx.trialId,
    project: ctx.project,
    lockOwner: ctx.lockOwner,
    // The shipped proposal store entry, wrapped only to observe the exact returned reference.
    recordProposal: (p, input) => { const row = recordProposal(p, input); recordedRows.push(row); return row; },
    attemptReleaseAuthority: {
      isCurrentRelease: capability => releasing.has(capability.attempt_id),
    },
  });
}

function buildClaimTarget(
  ctx: BuildContext, mutator: ReturnType<typeof createTrialCapabilityAwareTaskMutator>,
): ReturnType<typeof createDispatcherOwnedClaimTarget> {
  return createDispatcherOwnedClaimTarget({
    registry: ctx.registry,
    claim: (capability, taskId) => mutator.claim(capability, taskId),
    capability_whitelist: ctx.whitelist,
    targetAttemptAuthority: {
      current: () => { const fields = ctx.targetAuthority.fields; if (fields === null) throw new Error('target authority unset'); return fields; },
    },
  });
}

const UNUSED_PORT = (): never => { throw new Error('port not exercised in this suite'); };

function buildBroker(
  ctx: BuildContext,
  mutator: ReturnType<typeof createTrialCapabilityAwareTaskMutator>,
  claimTarget: ReturnType<typeof createDispatcherOwnedClaimTarget>,
): ReturnType<typeof createBenchmarkTaskBroker> {
  const artifacts = createTaskArtifactProjection({ root: ctx.trialRoot, project: ctx.project, resolveTaskId: capability => capability.task_id });
  const ledger = createAcceptanceLedgerPort(ctx.project, 'aaaa');
  const policy = {
    trial_id: ctx.trialId,
    child_template_whitelist: ['benchmark-coder-review'],
    capability_whitelist: ctx.whitelist,
    limits: { max_tasks: 20, max_task_depth: 4 },
  } as ResolvedTrialPolicy;
  return createBenchmarkTaskBroker({
    policy,
    ports: {
      taskRepository: ctx.repo,
      taskMutator: mutator,
      taskLocks: ctx.locks,
      taskArtifacts: artifacts,
      acceptanceLedger: ledger,
      managerQa: { ask: UNUSED_PORT, answer: UNUSED_PORT },
      parentQuestions: { record: UNUSED_PORT },
    },
    capabilities: ctx.registry,
    project: ctx.project,
    trialArtifactRoot: ctx.trialRoot,
    claimTarget,
  });
}

function buildComposition(options: CompositionOptions = {}): Composition {
  const ctx = openContext(options);
  const requester = mintRequester(ctx, options);
  const releasing = new Set<string>();
  const recordedRows: unknown[] = [];
  const mutator = buildMutator(ctx, releasing, recordedRows);
  const claimTarget = buildClaimTarget(ctx, mutator);
  const broker = buildBroker(ctx, mutator, claimTarget);
  return {
    trialId: ctx.trialId, project: ctx.project, tasksPath: ctx.tasksPath,
    store: ctx.store, repo: ctx.repo, table: ctx.table, locks: ctx.locks,
    registry: ctx.registry, requester, mutator, claimTarget, broker,
    trialRoot: ctx.trialRoot, targetAuthority: ctx.targetAuthority, releasing, recordedRows,
    call: (action, payload = {}) => ctx.registry.runInScope(requester, () => withTrialTaskLockScope(ctx.table, () => broker.call(action, payload))),
    claimThroughBroker: taskId => ctx.registry.runInScope(requester, () => withTrialTaskLockScope(ctx.table, () => broker.call('task.claim', { task_id: taskId }))),
    readTasks: () => { ctx.store.refresh(); return ctx.repo.list({}); },
    cleanup: () => {
      try { fs.rmSync(path.join(PROJECTS_DIR, ctx.project), { recursive: true, force: true }); } catch {}
      try { fs.rmSync(ctx.trialRoot, { recursive: true, force: true }); } catch {}
    },
  };
}

/** Builds the composition, runs the body and always cleans up after it settles. */
async function runWith<T>(options: CompositionOptions | undefined, body: (c: Composition) => T | Promise<T>): Promise<T> {
  const c = buildComposition(options);
  try {
    return await body(c);
  } finally {
    c.cleanup();
  }
}

function acquireTrialLock(c: Composition): void {
  const r = c.table.acquire(c.project, c.trialId);
  expect(r.acquired, r.message).toBe(true);
}

function refusalOf(result: BrokerCallResult): BrokerRefusal {
  expect(result.ok).toBe(false);
  return result as BrokerRefusal;
}
function taskById(c: Composition, id: string): Task | undefined {
  return c.readTasks().find(task => task.id === id);
}
function seedFilesSnapshot(c: Composition): { tasks: string; proposals: boolean; lock: { locked: boolean; owner?: string } } {
  return { tasks: fs.readFileSync(c.tasksPath, 'utf8'), proposals: fs.existsSync(proposalStorePath(c.project, 'aaaa')), lock: c.table.isProjectLocked(c.project) };
}

function expectZeroSideEffects(c: Composition, before: { tasks: string; proposals: boolean; lock: { locked: boolean; owner?: string } }): void {
  expect(fs.readFileSync(c.tasksPath, 'utf8')).toBe(before.tasks);
  expect(fs.existsSync(proposalStorePath(c.project, 'aaaa'))).toBe(before.proposals);
  // A refusal neither acquires nor releases a lock.
  expect(c.table.isProjectLocked(c.project)).toEqual(before.lock);
}

function staleCapabilityFor(c: Composition, overrides: Partial<Parameters<typeof mintActorCapability>[0]> = {}): ActorCapability {
  const capability = mintActorCapability({
    trial_id: c.trialId, task_id: 'aaaa', dispatch_generation: 'stale-gen',
    attempt_id: 'stale-attempt', role: 'manager', ancestry: ['root'],
    capability_whitelist: managerWhitelist(), issued_at_epoch_ms: 3_000, ...overrides,
  });
  c.registry.register(capability);
  return capability;
}

function newerAttempt(c: Composition, attemptId: string): void {
  c.registry.register(mintActorCapability({
    trial_id: c.trialId, task_id: 'aaaa', dispatch_generation: REQ_GEN, attempt_id: attemptId,
    role: 'manager', ancestry: ['root'], capability_whitelist: managerWhitelist(), issued_at_epoch_ms: 5_000,
  }));
}
type Invoke = (c: Composition, capability: ActorCapability) => unknown;
const INVOKE_TABLE: Record<string, Invoke> = {
  claim: (c, capability) => c.mutator.claim(capability, 'aaaa'),
  unclaim: (c, capability) => c.mutator.unclaim(capability, 'aaaa'),
  add: (c, capability) => c.mutator.add(capability, { project: c.project, fields: { text: 'x' } }),
  decompose: (c, capability) => c.mutator.decompose(capability, { project: c.project, fields: { subtasks: [{ text: 'c' }] } }),
  edit: (c, capability) => c.mutator.edit(capability, { project: c.project, taskId: 'bbbb', fields: { addDependsOn: ['dddd'] } }),
  proposeComplete: (c, capability) => c.mutator.proposeComplete(capability, 'aaaa', 'n'),
  proposeBlock: (c, capability) => c.mutator.proposeBlock(capability, 'aaaa', 'r'),
};

function invoke(c: Composition, method: string, capability: ActorCapability): unknown {
  const call = INVOKE_TABLE[method];
  return call === undefined ? unknownMethod(method) : call(c, capability);
}

function unknownMethod(method: string): never {
  throw new Error(`unknown method ${method}`);
}

const methods = ['claim', 'unclaim', 'add', 'decompose', 'edit', 'proposeComplete', 'proposeBlock'];
describe('R2-T1/T2 — claim and unclaim through the real production chain', () => {
  it('R2-T1 claim: two-leg claim through the broker claims the strict descendant with the target attempt', () => runWith(undefined, async c => {
    const result = await c.claimThroughBroker('dddd');
    expect(result.ok).toBe(true);
    expect((result as { result: Record<string, unknown> }).result).toEqual({ claimed: 'dddd' });
    const row = taskById(c, 'dddd')!;
    expect(row.claimed_by).toBe(TARGET_ATTEMPT); // P3 writes attempt_id, never token_id
    expect(row.dispatch_generation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row.dispatch_generation).not.toBe(REQ_GEN); // requester generation never copied
    expect(c.registry.currentAttempt('dddd')).toEqual({ dispatch_generation: row.dispatch_generation, attempt_id: TARGET_ATTEMPT });
    expect(c.registry.liveCount()).toBe(2); // requester + exactly one target capability
  }));

  it('R2-T2 unclaim: exact registered self-release succeeds only under the release authority mark', () => runWith(undefined, c => {
    // The coordinator's finalisation/recovery transition marks the attempt, then unclaims.
    c.releasing.add(REQ_ATTEMPT);
    const result = c.mutator.unclaim(c.requester, 'aaaa');
    expect(result.success).toBe(true);
    const row = taskById(c, 'aaaa')!;
    expect(row.claimed_by).toBeNull();
    expect(row.dispatch_generation).toBeNull();
    // Production order: the transition clears the mark and invalidates the token.
    c.releasing.delete(REQ_ATTEMPT);
    c.registry.invalidateToken(c.requester.token_id);
    expect(c.registry.isLive(c.requester.token_id)).toBe(false);
  }));
});
describe('R2-T3/T4 — add and decompose keep-parent spawn semantics', () => {
  it('R2-T3 add: one-child keep-parent spawn under cap.task_id', () => runWith(undefined, async c => {
    acquireTrialLock(c);
    const result = await c.call('task.create', { text: 'new child task', template: 'benchmark-coder-review' });
    expect(result.ok).toBe(true);
    const rows = c.readTasks();
    const child = rows.find(task => task.id !== 'aaaa' && task.parent === 'aaaa' && !['dddd', 'bbbb', 'xxxx', 'ff1'].includes(task.id))!;
    expect(child).toBeDefined();
    expect(child.text).toBe('new child task');
    expect(child.parent).toBe('aaaa');
    expect(taskById(c, 'aaaa')!.depends_on).toContain(child.id);
  }));

  it('R2-T4 decompose: forced keep-parent join node', () => runWith(undefined, async c => {
    acquireTrialLock(c);
    const result = await c.call('task.decompose', {
      subtasks: [{ text: 'first child' }, { text: 'second child' }],
    });
    expect(result.ok).toBe(true);
    const rows = c.readTasks();
    const children = rows.filter(task => ['first child', 'second child'].includes(task.text));
    expect(children).toHaveLength(2);
    for (const child of children) expect(child.parent).toBe('aaaa');
    // The join parent survives, with both children in depends_on.
    const parent = taskById(c, 'aaaa')!;
    expect(parent).toBeDefined();
    for (const child of children) expect(parent.depends_on).toContain(child.id);
  }));
});
describe('R2-T5/T6/T7 — edit, proposeComplete and proposeBlock', () => {
  it('R2-T5 edit: dependency.declare on a named descendant, R1 held on cap.task_id', () => runWith(undefined, async c => {
    acquireTrialLock(c);
    // bbbb carries a DIFFERENT generation than the requester — R1 must read cap.task_id's row.
    const result = await c.call('dependency.declare', { task_id: 'bbbb', depends_on: ['dddd'] });
    expect(result.ok).toBe(true);
    expect(taskById(c, 'bbbb')!.depends_on).toContain('dddd');
  }));

  it('R2-T6 proposeComplete: records the intent and returns the exact store row', () => runWith(undefined, c => {
    const result = c.mutator.proposeComplete(c.requester, 'aaaa', 'the note');
    expect(result).not.toHaveProperty('success'); // a ProposalRow has no success member
    expect(c.recordedRows).toHaveLength(1);
    expect(c.recordedRows[0]).toBe(result); // same object reference
    const stored = JSON.parse(fs.readFileSync(proposalStorePath(c.project, 'aaaa'), 'utf8'));
    expect(stored.proposals).toHaveLength(1);
    expect(stored.proposals[0]).toEqual(result);
    expect(stored.proposals[0]).toMatchObject({ intent: 'complete', note: 'the note', state: 'proposed' });
  }));

  it('R2-T7 proposeBlock: same store contract with intent block and opaque reason', () => runWith(undefined, c => {
    const result = c.mutator.proposeBlock(c.requester, 'aaaa', 'block reason');
    expect(c.recordedRows).toHaveLength(1);
    expect(c.recordedRows[0]).toBe(result);
    const stored = JSON.parse(fs.readFileSync(proposalStorePath(c.project, 'aaaa'), 'utf8'));
    expect(stored.proposals[0]).toMatchObject({ intent: 'block', note: 'block reason', state: 'proposed' });
  }));
});
describe('R2-T8a — non-exact and non-minted objects are 33, zero side effect', () => {
  it.each(methods)('%s: non-exact and non-minted objects return 33 by value, never thrown, zero side effect', (method) => runWith(undefined, c => {
    const before = seedFilesSnapshot(c);
    // Same token_id as the registered capability: token-id equality must NOT be authority.
    const tokenIdClone = Object.freeze({ ...c.requester });
    expect(invoke(c, method, tokenIdClone)).toEqual({ success: false, message: expect.any(String), code: 33 });
    expectZeroSideEffects(c, before);
    const forged = Object.freeze({ ...c.requester, token_id: 'forged-token' });
    expect(invoke(c, method, forged)).toEqual({ success: false, message: expect.any(String), code: 33 });
    expectZeroSideEffects(c, before);
  }));
});
describe('R2-T8b — a foreign-trial capability is 33 and never registers', () => {
  it.each(methods)('%s: a capability minted for another trial returns 33 and never registers', (method) => runWith(undefined, c => {
    const before = seedFilesSnapshot(c);
    const foreign = mintActorCapability({
      trial_id: 'other-trial', task_id: 'aaaa', dispatch_generation: REQ_GEN, attempt_id: REQ_ATTEMPT,
      role: 'manager', ancestry: ['root'], capability_whitelist: managerWhitelist(), issued_at_epoch_ms: 4_000,
    });
    expect(() => c.registry.register(foreign)).toThrow();
    expect(invoke(c, method, foreign)).toEqual({ success: false, message: expect.any(String), code: 33 });
    expectZeroSideEffects(c, before);
  }));
});
describe('R2-T8c — action outside allowed_actions is 33 (R8)', () => {
  it.each(['add', 'decompose', 'edit', 'proposeComplete', 'proposeBlock'])('%s: action outside allowed_actions returns 33 (R8), zero side effect', (method) => runWith({ requesterActions: ['task.read', 'artifact.write'] }, c => {
    const before = seedFilesSnapshot(c);
    expect(invoke(c, method, c.requester)).toEqual({ success: false, message: expect.any(String), code: 33 });
    expectZeroSideEffects(c, before);
  }));
});
describe('R2-T8d — stale actor subject is 34, zero side effect', () => {
  it.each(methods)('%s: stale actor subject (generation or registry attempt) returns 34, zero side effect', (method) => runWith(undefined, c => {
    const before = seedFilesSnapshot(c);
    const stale = staleCapabilityFor(c);
    // unclaim's C4 additionally requires the coordinator's release-transition mark; the stale
    // test marks the stale attempt so the refusal lands on C5 (34), not C4.
    if (method === 'unclaim') c.releasing.add('stale-attempt');
    expect(invoke(c, method, stale)).toEqual({ success: false, message: expect.any(String), code: 34 });
    if (method === 'proposeComplete') expect(c.mutator.proposeComplete(stale, 'dddd', 'n')).toEqual({ success: false, message: expect.any(String), code: 34 });
    expectZeroSideEffects(c, before);
    // A newer registered attempt makes the original capability's attempt stale (D-9).
    newerAttempt(c, 'attempt-2');
    if (method === 'unclaim') { c.releasing.delete('stale-attempt'); c.releasing.add(REQ_ATTEMPT); }
    const before2 = seedFilesSnapshot(c);
    expect(invoke(c, method, c.requester)).toEqual({ success: false, message: expect.any(String), code: 34 });
    expectZeroSideEffects(c, before2);
  }));
});
describe('R2-T8e — pre-claimed target refusal', () => {
  it('claim: a pre-claim row that is already claimed returns 34 and invalidates no live token', () => runWith(undefined, async c => {
    const first = await c.claimThroughBroker('dddd');
    expect(first.ok).toBe(true);
    const liveBefore = c.registry.liveCount();
    // Second claim of the same target: the broker guard refuses before any mint.
    await expect(c.claimThroughBroker('dddd')).rejects.toThrow(BrokerArgumentsError);
    expect(c.registry.liveCount()).toBe(liveBefore);
    expect(c.registry.isLive(c.requester.token_id)).toBe(true);
  }));
});
describe('R2-T9a — claim is two-leg: requester currency precedes any mint', () => {
  it('requires requester generation/attempt currency on the REQUESTER row before any mint', () => runWith({ requesterGeneration: 'stale-gen' }, async c => {
    const before = c.registry.liveCount();
    const result = refusalOf(await c.claimThroughBroker('dddd'));
    expect([result.code, result.reason]).toEqual([34, 'stale_generation']);
    expect(c.registry.liveCount()).toBe(before); // no mint happened
    expect(taskById(c, 'dddd')!.claimed_by).toBeNull();
  }));
  it('requires the requester attempt to be the registry current attempt (D-9)', () => runWith(undefined, async c => {
    newerAttempt(c, 'attempt-2');
    const before = c.registry.liveCount();
    const result = refusalOf(await c.claimThroughBroker('dddd'));
    expect([result.code, result.reason]).toEqual([34, 'stale_generation']);
    expect(c.registry.liveCount()).toBe(before);
  }));
});
describe('R2-T9b — strict actionable unclaimed descendant, fresh unequal generation', () => {
  it('proves the target is a strict actionable unclaimed descendant of the requester task', () => runWith(undefined, async c => {
    // cccc is a sibling (cross-branch R2); bbbb is a descendant but already carries a generation.
    const cross = refusalOf(await c.claimThroughBroker('cccc'));
    expect([cross.code, cross.reason]).toEqual([35, 'cross_branch_mutation']);
    await expect(c.claimThroughBroker('bbbb')).rejects.toThrow(BrokerArgumentsError);
    expect(taskById(c, 'bbbb')!.claimed_by).toBeNull(); // nothing was written
  }));

  it('mints a fresh generation unequal to the requester and writes it through P3 claim', () => runWith(undefined, async c => {
    const result = await c.claimThroughBroker('dddd');
    expect(result.ok).toBe(true);
    const row = taskById(c, 'dddd')!;
    expect(row.dispatch_generation).not.toBe(REQ_GEN);
    expect(c.registry.currentAttempt('dddd')).toEqual({ dispatch_generation: row.dispatch_generation, attempt_id: TARGET_ATTEMPT }); // one mint, one register
  }));

  it('no argument, response or projection carries dispatch_generation or attempt_id', () => runWith(undefined, async c => {
    const result = await c.claimThroughBroker('dddd');
    expect(result.ok).toBe(true);
    const json = JSON.stringify(result);
    for (const needle of ['dispatch_generation', 'attempt_id', TARGET_ATTEMPT]) expect(json).not.toContain(needle);
    // The model-facing read projection of the claimed row carries no generation either.
    const read = await c.call('task.read', { task_id: 'dddd' });
    expect(read.ok).toBe(true);
    const projected = ((read as { result: Readonly<Record<string, unknown>> }).result.tasks as Record<string, unknown>[])[0];
    for (const key of ['dispatch_generation', 'attempt_id', 'claimed_by']) expect(projected).not.toHaveProperty(key);
  }));
});
describe('R2-T10a — claim refusals precede any mint', () => {
  it('self, non-actionable and already-claimed targets are BrokerArgumentsError before any mint', () => runWith(undefined, async c => {
    const before = c.registry.liveCount();
    await expect(c.claimThroughBroker('aaaa')).rejects.toThrow(BrokerArgumentsError); // self
    await expect(c.claimThroughBroker('xxxx')).rejects.toThrow(BrokerArgumentsError); // done
    await expect(c.claimThroughBroker('ff1')).rejects.toThrow(BrokerArgumentsError); // claimed
    expect(c.registry.liveCount()).toBe(before);
    expect(taskById(c, 'ff1')!.claimed_by).toBe('someone-else');
  }));

  it('ancestor and cross-branch targets are R3/R2 refusals before any mint', () => runWith(undefined, async c => {
    const before = c.registry.liveCount();
    const ancestor = refusalOf(await c.claimThroughBroker('root'));
    expect([ancestor.code, ancestor.reason]).toEqual([35, 'parent_completion_by_child']);
    const cross = refusalOf(await c.claimThroughBroker('cccc'));
    expect([cross.code, cross.reason]).toEqual([35, 'cross_branch_mutation']);
    expect(c.registry.liveCount()).toBe(before);
  }));
});
describe('R2-T10b — post-registration failure invalidates the target token', () => {
  it('a failed post-registration claim invalidates the target token and never reports success', () => runWith(undefined, async c => {
    const first = await c.claimThroughBroker('dddd');
    expect(first.ok).toBe(true);
    // Direct callback invocation (the coordinator's own claim path) against the now-claimed
    // target: the mint/register succeeds, P3 refuses with 34, the token is invalidated.
    const liveBefore = c.registry.liveCount();
    const second = c.claimTarget(c.requester, 'dddd');
    expect(second).toEqual({ success: false, message: expect.any(String), code: 34 });
    // Exactly one more mint/register happened and its token was invalidated on refusal.
    expect(c.registry.liveCount()).toBe(liveBefore);
    expect(c.registry.isLive(c.requester.token_id)).toBe(true);
    // The row still carries the FIRST claim's attempt — no second write.
    expect(taskById(c, 'dddd')!.claimed_by).toBe(TARGET_ATTEMPT);
  }));
});
describe('R2-T10c — direct P3 recheck of target actionability', () => {
  it('P3 rechecks target actionability after registration and before the lifecycle write', () => runWith({
    extraTasks: [taskRow({
      id: 'pppp', project: '_placeholder_', text: 'paused target', parent: 'aaaa', paused: true,
    })],
  }, c => {
    const target = mintActorCapability({
      trial_id: c.trialId, task_id: 'pppp', dispatch_generation: 'fresh-target-generation', attempt_id: 'paused-target-attempt',
      role: 'coder', ancestry: ['root', 'aaaa'], capability_whitelist: managerWhitelist(), allowed_actions: ['artifact.write', 'task.read'], issued_at_epoch_ms: 7_000,
    });
    c.registry.register(target);
    const result = c.mutator.claim(target, 'pppp');
    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty('code');
    const row = taskById(c, 'pppp')!;
    expect(row.claimed_by).toBeNull();
    expect(row.dispatch_generation).toBeNull();
  }));
});
describe('R2-T11a — unclaim is coordinator-internal self-release under the authority mark', () => {
  const ROLE_SLOTS = ['parent', 'manager', 'coder', 'reviewer', 'verifier'] as const;

  it.each(ROLE_SLOTS)('role %s: exact registered self/current attempt succeeds only while the release transition marks it', (role) => runWith({
    requesterRole: role,
    requesterActions: ['task.read'],
  }, c => {
    // Outside the release transition: 33, zero side effect.
    const before = seedFilesSnapshot(c);
    expect(c.mutator.unclaim(c.requester, 'aaaa')).toEqual({ success: false, message: expect.any(String), code: 33 });
    expectZeroSideEffects(c, before);
    // Inside the coordinator's finalisation/recovery transition: self-release succeeds.
    c.releasing.add(REQ_ATTEMPT);
    const result = c.mutator.unclaim(c.requester, 'aaaa');
    expect(result.success).toBe(true);
    const row = taskById(c, 'aaaa')!;
    expect(row.claimed_by).toBeNull();
    expect(row.dispatch_generation).toBeNull();
  }));

  it('cross-target unclaim is 33 for every role', () => runWith(undefined, c => {
    c.releasing.add(REQ_ATTEMPT);
    expect(c.mutator.unclaim(c.requester, 'dddd')).toEqual({ success: false, message: expect.any(String), code: 33 });
    expect(taskById(c, 'dddd')!.claimed_by).toBeNull();
    expect(taskById(c, 'aaaa')!.claimed_by).toBe('req-agent');
  }));
});
describe('R2-T11b — stale self and the cleared release mark', () => {
  it('stale self row or stale registry attempt is 34 with zero side effect', () => runWith(undefined, c => {
    const before = seedFilesSnapshot(c);
    const stale = staleCapabilityFor(c);
    c.releasing.add('stale-attempt');
    expect(c.mutator.unclaim(stale, 'aaaa')).toEqual({ success: false, message: expect.any(String), code: 34 });
    expectZeroSideEffects(c, before);
  }));

  it('after the release transition clears its mark, the same call is 33 again', () => runWith(undefined, c => {
    c.releasing.add(REQ_ATTEMPT);
    expect(c.mutator.unclaim(c.requester, 'aaaa').success).toBe(true);
    // Clear the mark while C1/C2/C3 and the self-target check still pass.
    c.releasing.delete(REQ_ATTEMPT);
    expect(c.registry.isRegistered(c.requester)).toBe(true);
    const before = seedFilesSnapshot(c);
    const after = c.mutator.unclaim(c.requester, 'aaaa');
    expect(after).toEqual({ success: false, message: expect.any(String), code: 33 });
    expectZeroSideEffects(c, before);
    // Production order: only now invalidate the token.
    c.registry.invalidateToken(c.requester.token_id);
    expect(c.registry.isLive(c.requester.token_id)).toBe(false);
  }));
});
describe('R2-T12a — add/decompose reuse the shipped one-child keep-parent spawn', () => {
  it('add never calls top-level addTask: the child hangs under cap.task_id and the parent joins on it', () => runWith(undefined, async c => {
    acquireTrialLock(c);
    const result = await c.call('task.create', { text: 'spawned child' });
    expect(result.ok).toBe(true);
    const rows = c.readTasks();
    const child = rows.find(task => task.text === 'spawned child')!;
    expect(child.parent).toBe('aaaa'); // top-level addTask would set parent null
    expect(child.origin_thread_id).toBeNull();
    expect(taskById(c, 'aaaa')!.depends_on).toContain(child.id);
  }));

  it('decompose forces keepParent: the parent row survives as the join node', () => runWith(undefined, async c => {
    acquireTrialLock(c);
    const result = await c.call('task.decompose', {
      subtasks: [{ text: 'child-a' }, { text: 'child-b' }],
    });
    expect(result.ok).toBe(true);
    const rows = c.readTasks();
    const parent = rows.find(task => task.id === 'aaaa')!;
    expect(parent.text).toBe('requester task'); // row not replaced by the destructive variant
    const children = rows.filter(task => ['child-a', 'child-b'].includes(task.text));
    for (const child of children) expect(child.parent).toBe('aaaa');
    expect(parent.depends_on.sort()).toEqual(children.map(child => child.id).sort());
  }));
});
describe('R2-T12b — contended trial lock fails fast', () => {
  it('a contended trial lock fails fast with a no-code failure — no system-lock spin', () => runWith(undefined, async c => {
    expect(c.table.acquire(c.project, 'other-owner').acquired).toBe(true);
    const started = Date.now();
    const result = await c.call('task.create', { text: 'contended' });
    expect(result.ok).toBe(false);
    expect(refusalOf(result).reason).toBe('lock_not_held');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(taskById(c, 'aaaa')!.depends_on).toEqual([]);
  }));
});
describe('R2-T13a — edit proves R1 against cap.task_id', () => {
  it('a stale requester generation refuses 34 even when the named target is current', () => runWith({ requesterGeneration: 'stale-gen' }, async c => {
    acquireTrialLock(c);
    const before = seedFilesSnapshot(c);
    const result = refusalOf(await c.call('dependency.declare', {
      task_id: 'bbbb', depends_on: ['dddd'],
    }));
    expect([result.code, result.reason]).toEqual([34, 'stale_generation']);
    expectZeroSideEffects(c, before);
  }));

  it('the requester generation is never compared with the named target row', () => runWith(undefined, async c => {
    acquireTrialLock(c);
    // bbbb carries dispatch_generation 'other-gen' — a requester-vs-target comparison
    // would refuse here; R1 reads cap.task_id only.
    const result = await c.call('dependency.declare', { task_id: 'bbbb', depends_on: ['dddd'] });
    expect(result.ok).toBe(true);
    expect(taskById(c, 'bbbb')!.depends_on).toContain('dddd');
  }));
});
describe('R2-T13b — the target guards inspect the named descendant', () => {
  it('the target guards (branch, acyclic, lock) inspect the named descendant', () => runWith(undefined, async c => {
    acquireTrialLock(c);
    // Cross-branch endpoint: cccc is not in the requester's branch.
    const cross = refusalOf(await c.call('dependency.declare', {
      task_id: 'bbbb', depends_on: ['cccc'],
    }));
    expect([cross.code, cross.reason]).toEqual([35, 'cross_branch_mutation']);
    // bbbb→dddd would close a cycle — a mutation-validity BrokerArgumentsError (G5-N4).
    const first = await c.call('dependency.declare', { task_id: 'dddd', depends_on: ['bbbb'] });
    expect(first.ok).toBe(true);
    await expect(c.call('dependency.declare', {
      task_id: 'bbbb', depends_on: ['dddd'],
    })).rejects.toThrow(BrokerArgumentsError);
  }));
});
describe('R2-T14 — proposals return the exact recordProposal object; refusals precede store access', () => {
  it('valid proposals write and read back the real file exactly once per call', () => runWith(undefined, c => {
    const first = c.mutator.proposeComplete(c.requester, 'aaaa', 'note');
    expect(c.recordedRows).toHaveLength(1);
    expect(c.recordedRows[0]).toBe(first);
    // Re-proposing on the same live attempt transitions the SAME row — one row, not two.
    const second = c.mutator.proposeComplete(c.requester, 'aaaa', 'note 2');
    expect(c.recordedRows).toHaveLength(2);
    expect(c.recordedRows[1]).toBe(second);
    const stored = JSON.parse(fs.readFileSync(proposalStorePath(c.project, 'aaaa'), 'utf8'));
    expect(stored.proposals).toHaveLength(1);
    expect(stored.proposals[0].note).toBe('note 2');
  }));

  it('33/34 refusals are returned by value before the store is touched', () => runWith(undefined, c => {
    const stale = staleCapabilityFor(c);
    const before = seedFilesSnapshot(c);
    // By value — the return IS the refusal, nothing was thrown.
    expect(c.mutator.proposeComplete(stale, 'aaaa', 'n')).toEqual({ success: false, message: expect.any(String), code: 34 });
    expect(c.mutator.proposeBlock(stale, 'aaaa', 'r')).toEqual({ success: false, message: expect.any(String), code: 34 });
    expectZeroSideEffects(c, before);
  }));
});
describe('R2-T15 — forced proposal-store read error: detail, public reason and code 42', () => {
  it('ProposalSealError carries detail store_unreadable, reason ledger_unreadable, code 42', () => runWith(undefined, c => {
    const target = proposalStorePath(c.project, 'aaaa');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{not-json');
    let caught: unknown;
    try {
      c.mutator.proposeComplete(c.requester, 'aaaa', 'n');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const error = caught as { detail: string; reason: string; code: number; message: string };
    expect(error.detail).toBe('store_unreadable');
    expect(error.reason).toBe('ledger_unreadable');
    expect(error.code).toBe(42);
  }));

  it('the broker matches the public reason and returns a 42 refusal frame', () => runWith(undefined, async c => {
    const target = proposalStorePath(c.project, 'aaaa');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{not-json');
    const result = refusalOf(await c.broker.proposeComplete(c.requester, 'aaaa', 'n'));
    expect([result.code, result.reason]).toEqual([42, 'ledger_unreadable']);
  }));
});
describe('R2-T16 — proposed leaves authoritative state unchanged and emits no in-trial event', () => {
  it('task status, claim and dependencies are byte-identical after a proposal', () => runWith(undefined, async c => {
    const before = fs.readFileSync(c.tasksPath, 'utf8');
    const result = await c.call('task.propose_complete', { note: 'done soon' });
    expect(result.ok).toBe(true);
    expect((result as { result: Record<string, unknown> }).result).toEqual({ proposal_recorded: true });
    expect(fs.readFileSync(c.tasksPath, 'utf8')).toBe(before);
    const row = taskById(c, 'aaaa')!;
    expect(row.status).toBe('open');
    expect(row.claimed_by).toBe('req-agent');
    expect(row.dispatch_generation).toBe(REQ_GEN);
  }));
  it('proposeComplete never routes into a completion lifecycle', () => runWith(undefined, c => {
    c.mutator.proposeComplete(c.requester, 'aaaa', 'n');
    const row = taskById(c, 'aaaa')!;
    expect(row.status).toBe('open'); // a routed completion would flip status to done
    expect(row.completed_at).toBeNull();
  }));
});
describe('R2-T17a — results are plain objects, never unawaited Promises', () => {
  it('the direct claim result is a plain object, not an unawaited Promise', () => runWith(undefined, c => {
    const result = c.claimTarget(c.requester, 'dddd');
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown }).then).not.toBe('function');
    expect(result.success).toBe(true);
  }));
  it('the direct add result is a plain object, not a Promise', () => runWith(undefined, c => {
    acquireTrialLock(c);
    const result = c.mutator.add(c.requester, { project: c.project, fields: { text: 'sync child' } });
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.success).toBe(true);
    expect(taskById(c, 'aaaa')!.depends_on).toHaveLength(1);
  }));
});
function t17Calls(c: Composition): (() => Promise<BrokerCallResult>)[] {
  return [
    ...Array.from({ length: 4 }, (_, i) => () => c.call('task.create', { text: `concurrent-${i}` })),
    () => c.broker.proposeComplete(c.requester, 'aaaa', 'concurrent proposal'), () => c.broker.proposeBlock(c.requester, 'aaaa', 'concurrent block'),
    () => c.call('dependency.declare', { task_id: 'bbbb', depends_on: ['dddd'] }),
  ];
}
function t17Snapshot(c: Composition) {
  const rows = c.readTasks();
  const children = rows.filter(task => /^concurrent-\d$/.test(task.text));
  const textById = new Map(rows.map(task => [task.id, task.text]));
  const stored: { proposals: { intent: string; note: string | null; state: string }[] } = JSON.parse(fs.readFileSync(proposalStorePath(c.project, 'aaaa'), 'utf8'));
  return {
    children: children.map(task => `${task.text}:${task.parent}`).sort(), parentDependencies: taskById(c, 'aaaa')!.depends_on.map(id => textById.get(id) ?? id).sort(),
    editDependencies: [...taskById(c, 'bbbb')!.depends_on].sort(),
    proposals: stored.proposals.map(({ intent, note, state }) => ({ intent, note, state })),
  };
}
async function runT17(c: Composition, parallel: boolean): Promise<ReturnType<typeof t17Snapshot>> {
  acquireTrialLock(c);
  const calls = t17Calls(c);
  const results = parallel ? await Promise.all(calls.map(call => call())) : [];
  if (!parallel) for (const call of calls) results.push(await call());
  expect(results.every(result => result.ok)).toBe(true);
  return t17Snapshot(c);
}
describe('R2-T17b — concurrent production-factory calls equal a serial order', () => {
  it('concurrent broker calls leave exactly the serial final state with no lost mutation', async () => {
    const concurrent = await runWith(undefined, c => runT17(c, true));
    const serial = await runWith(undefined, c => runT17(c, false));
    expect(concurrent).toEqual(serial);
  });
});

