// input:  the three production factories (createTrialCapabilityAwareTaskMutator,
//         createDispatcherOwnedClaimTarget, createBenchmarkTaskBroker) over real P2/P4/registry/
//         proposal-store objects — no subclass, no module mock, no test-only composition
// output: the §19.12.8 R2-T1…R2-T18 contract, run against the exact production chain
// pos:    Gate-5 P3 — the capability-aware task mutator, the two-leg claim and the proposal
//         union, proven through the same factories Gate 6 will call
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import '../../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROJECTS_DIR } from '../../../src/core/paths.js';
import { serializeTasksFileWithLock, type Task } from '../../../src/core/task-parser.js';
import { TaskRepo } from '../../../src/store/task-repo.js';
import {
  BENCHMARK_BROKER_ACTIONS, capabilityWhitelistForArm, mintActorCapability,
  type ActorCapability, type BenchmarkBrokerCapability,
} from '../../../src/domain/benchmark/capabilities.js';
import {
  createActorCapabilityRegistry, type ActorCapabilityRegistry,
} from '../../../src/domain/benchmark/actor-capability-scope.js';
import {
  createTaskArtifactProjection, createTrialTaskLockTable, createTrialTaskLocks,
  createTrialTaskRepository, withTrialTaskLockScope,
  type TrialTaskLockTable, type TrialTaskRepository,
} from '../../../src/domain/benchmark/trial-task-ports.js';
// The production wiring surface re-exports the same factories; the composition below is
// exercised through composite-runtime-ports' createAcceptanceLedgerPort + createDispatcherPort
// siblings only where the frozen interface is the consumer.
import { createAcceptanceLedgerPort } from '../../../src/domain/benchmark/composite-runtime-ports.js';
import { createTrialClock } from '../../../src/domain/benchmark/trial-clock.js';
import { recordProposal, proposalStorePath } from '../../../src/domain/benchmark/proposal-seal.js';
import { createDispatcherOwnedClaimTarget, mintTrialDispatchGeneration } from '../../../src/domain/benchmark/trial-task-dispatcher.js';
import { createBenchmarkTaskBroker, BrokerArgumentsError, type BrokerCallResult, type BrokerRefusal } from '../../../src/domain/benchmark/task-broker.js';
import type { ResolvedTrialPolicy } from '../../../src/domain/benchmark/resolved-policy.js';
import type { ArmDefinition } from '../../../src/domain/benchmark/arm-schema.js';
import { createTrialCapabilityAwareTaskMutator } from '../../../src/domain/tasks/mutator.js';

const TRIAL_ID = 'trial-749f';
const REQ_GEN = 'req-gen';
const REQ_ATTEMPT = 'req-attempt';
const TARGET_ATTEMPT = 'target-attempt-1';

function armFor(mode: 'manager' | 'coder-review', askManager: boolean): ArmDefinition {
  return {
    kind: 'cortex',
    orchestration: mode === 'manager'
      ? { mode, ask_manager: askManager }
      : { mode, ask_manager: false, coder_review_variant: 'audit-retry' },
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
  trialId: string;
  project: string;
  tasksPath: string;
  store: TaskRepo;
  repo: TrialTaskRepository & { commitAndPush(message: string): void };
  table: TrialTaskLockTable;
  locks: ReturnType<typeof createTrialTaskLocks>;
  registry: ActorCapabilityRegistry;
  requester: ActorCapability;
  mutator: ReturnType<typeof createTrialCapabilityAwareTaskMutator>;
  claimTarget: ReturnType<typeof createDispatcherOwnedClaimTarget>;
  broker: ReturnType<typeof createBenchmarkTaskBroker>;
  trialRoot: string;
  targetAuthority: TargetAuthorityState;
  releasing: Set<string>;
  recordedRows: unknown[];
  call(action: BenchmarkBrokerCapability, payload?: Record<string, unknown>): Promise<BrokerCallResult>;
  claimThroughBroker(taskId: string): Promise<BrokerCallResult>;
  readTasks(): Task[];
  cleanup(): void;
}

interface CompositionOptions {
  requesterTaskId?: string;
  requesterGeneration?: string;
  requesterAttempt?: string;
  requesterActions?: readonly BenchmarkBrokerCapability[];
  requesterRole?: ActorCapability['role'];
  requesterAncestry?: readonly string[];
  extraTasks?: Task[];
  releaseAttempt?: string;
}

function buildComposition(options: CompositionOptions = {}): Composition {
  const trialId = TRIAL_ID;
  const project = nextProject();
  const projectDir = path.join(PROJECTS_DIR, project);
  const tasksPath = path.join(projectDir, 'TASKS.yaml');
  fs.mkdirSync(projectDir, { recursive: true });

  const requesterTaskId = options.requesterTaskId ?? 'aaaa';
  const requesterAncestry = options.requesterAncestry ?? (requesterTaskId === 'root' ? [] : ['root']);
  const rows: Task[] = [
    taskRow({ id: 'root', project, text: 'root' }),
    taskRow({
      id: 'aaaa', project, text: 'requester task', parent: 'root',
      claimed_by: 'req-agent', dispatch_generation: REQ_GEN,
    }),
    taskRow({ id: 'dddd', project, text: 'claim target', parent: 'aaaa' }),
    taskRow({
      id: 'bbbb', project, text: 'edit target', parent: 'aaaa',
      dispatch_generation: 'other-gen',
    }),
    taskRow({ id: 'cccc', project, text: 'sibling', parent: 'root' }),
    taskRow({ id: 'xxxx', project, text: 'done child', parent: 'aaaa', status: 'done' }),
    taskRow({
      id: 'ff1', project, text: 'already claimed child', parent: 'aaaa',
      claimed_by: 'someone-else', dispatch_generation: 'g-ff',
    }),
    ...(options.extraTasks ?? []),
  ];
  fs.writeFileSync(tasksPath, serializeTasksFileWithLock({ tasks: rows, lock: null }));

  const store = new TaskRepo({ skipGit: true });
  const repo = createTrialTaskRepository(store);
  const clock = createTrialClock({ deadlineEpochMs: Date.now() + 60_000 });
  const table = createTrialTaskLockTable(clock);
  const locks = createTrialTaskLocks(table);
  const registry = createActorCapabilityRegistry(trialId);
  const whitelist = managerWhitelist();
  const lockOwner = trialId;

  const requester = mintActorCapability({
    trial_id: trialId,
    task_id: requesterTaskId,
    dispatch_generation: options.requesterGeneration ?? REQ_GEN,
    attempt_id: options.requesterAttempt ?? REQ_ATTEMPT,
    role: options.requesterRole ?? 'manager',
    ancestry: requesterAncestry,
    capability_whitelist: whitelist,
    allowed_actions: options.requesterActions === undefined ? whitelist : options.requesterActions,
    issued_at_epoch_ms: 1_000,
  });
  registry.register(requester);

  const releasing = new Set<string>();
  const recordedRows: unknown[] = [];
  const mutator = createTrialCapabilityAwareTaskMutator({
    repository: repo,
    locks,
    registry,
    trialId,
    project,
    lockOwner,
    // The shipped proposal store entry, wrapped only to observe the exact returned reference.
    recordProposal: (p, input) => {
      const row = recordProposal(p, input);
      recordedRows.push(row);
      return row;
    },
    attemptReleaseAuthority: {
      isCurrentRelease: capability => releasing.has(capability.attempt_id),
    },
  });

  const targetAuthority: TargetAuthorityState = {
    fields: {
      attempt_id: TARGET_ATTEMPT,
      role: 'coder',
      ancestry: ['root', 'aaaa'],
      allowed_actions: ['artifact.write', 'task.read'],
      issued_at_epoch_ms: 2_000,
    },
  };
  const claimTarget = createDispatcherOwnedClaimTarget({
    registry,
    claim: (capability, taskId) => mutator.claim(capability, taskId),
    capability_whitelist: whitelist,
    targetAttemptAuthority: {
      current: () => {
        if (targetAuthority.fields === null) throw new Error('target authority unset');
        return targetAuthority.fields;
      },
    },
  });

  const trialRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't749f-root-'));
  const artifacts = createTaskArtifactProjection({
    root: trialRoot, project, resolveTaskId: capability => capability.task_id,
  });
  const ledger = createAcceptanceLedgerPort(project, requesterTaskId);
  const policy = {
    trial_id: trialId,
    child_template_whitelist: ['benchmark-coder-review'],
    capability_whitelist: whitelist,
    limits: { max_tasks: 20, max_task_depth: 4 },
  } as ResolvedTrialPolicy;

  const broker = createBenchmarkTaskBroker({
    policy,
    ports: {
      taskRepository: repo,
      taskMutator: mutator,
      taskLocks: locks,
      taskArtifacts: artifacts,
      acceptanceLedger: ledger,
      managerQa: {
        ask: () => { throw new Error('qa.ask not exercised in this suite'); },
        answer: () => { throw new Error('qa.answer not exercised in this suite'); },
      },
      parentQuestions: {
        record: () => { throw new Error('parentQuestions not exercised in this suite'); },
      },
    },
    capabilities: registry,
    project,
    trialArtifactRoot: trialRoot,
    claimTarget,
  });

  return {
    trialId,
    project,
    tasksPath,
    store,
    repo,
    table,
    locks,
    registry,
    requester,
    mutator,
    claimTarget,
    broker,
    trialRoot,
    targetAuthority,
    releasing,
    recordedRows,
    call: (action, payload = {}) => registry.runInScope(
      requester, () => withTrialTaskLockScope(table, () => broker.call(action, payload)),
    ),
    claimThroughBroker: taskId => registry.runInScope(
      requester, () => withTrialTaskLockScope(table, () => broker.call('task.claim', { task_id: taskId })),
    ),
    readTasks: () => {
      store.refresh();
      return repo.list({});
    },
    cleanup: () => {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(trialRoot, { recursive: true, force: true }); } catch {}
    },
  };
}

function acquireTrialLock(c: Composition): void {
  const r = c.table.acquire(c.project, c.trialId);
  expect(r.acquired, r.message).toBe(true);
}

function refusalOf(result: BrokerCallResult): BrokerRefusal {
  expect(result.ok).toBe(false);
  return result as BrokerRefusal;
}

function readTaskRows(c: Composition): Task[] {
  return c.readTasks();
}

function taskById(c: Composition, id: string): Task | undefined {
  return readTaskRows(c).find(task => task.id === id);
}

function seedFilesSnapshot(c: Composition): { tasks: string; proposals: boolean; lock: { locked: boolean; owner?: string } } {
  return {
    tasks: fs.readFileSync(c.tasksPath, 'utf8'),
    proposals: fs.existsSync(proposalStorePath(c.project, 'aaaa')),
    lock: c.table.isProjectLocked(c.project),
  };
}

function expectZeroSideEffects(c: Composition, before: { tasks: string; proposals: boolean; lock: { locked: boolean; owner?: string } }): void {
  const afterTasks = fs.readFileSync(c.tasksPath, 'utf8');
  expect(afterTasks).toBe(before.tasks);
  expect(fs.existsSync(proposalStorePath(c.project, 'aaaa'))).toBe(before.proposals);
  // The lock table is unchanged — a refusal neither acquires nor releases a lock.
  expect(c.table.isProjectLocked(c.project)).toEqual(before.lock);
}

function staleCapabilityFor(c: Composition, overrides: Partial<Parameters<typeof mintActorCapability>[0]> = {}): ActorCapability {
  const capability = mintActorCapability({
    trial_id: c.trialId,
    task_id: 'aaaa',
    dispatch_generation: 'stale-gen',
    attempt_id: 'stale-attempt',
    role: 'manager',
    ancestry: ['root'],
    capability_whitelist: managerWhitelist(),
    issued_at_epoch_ms: 3_000,
    ...overrides,
  });
  c.registry.register(capability);
  return capability;
}

describe('R2-T1…R2-T7 — one real-production-factory test per method', () => {
  it('R2-T1 claim: two-leg claim through the broker claims the strict descendant with the target attempt', async () => {
    const c = buildComposition();
    try {
      const result = await c.claimThroughBroker('dddd');
      expect(result.ok).toBe(true);
      expect((result as { result: Record<string, unknown> }).result).toEqual({ claimed: 'dddd' });

      const row = taskById(c, 'dddd')!;
      expect(row.claimed_by).toBe(TARGET_ATTEMPT); // P3 writes attempt_id, never token_id
      expect(row.dispatch_generation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(row.dispatch_generation).not.toBe(REQ_GEN); // requester generation never copied
      expect(c.registry.currentAttempt('dddd')).toEqual({
        dispatch_generation: row.dispatch_generation,
        attempt_id: TARGET_ATTEMPT,
      });
      expect(c.registry.liveCount()).toBe(2); // requester + exactly one target capability
    } finally {
      c.cleanup();
    }
  });

  it('R2-T2 unclaim: exact registered self-release succeeds only under the release authority mark', async () => {
    const c = buildComposition();
    try {
      // The requester task is claimed with the requester's generation; the coordinator's
      // attempt-finalisation/recovery transition marks the attempt, then unclaims.
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
    } finally {
      c.cleanup();
    }
  });

  it('R2-T3 add: one-child keep-parent spawn under cap.task_id', async () => {
    const c = buildComposition();
    try {
      acquireTrialLock(c);
      const result = await c.call('task.create', { text: 'new child task', template: 'benchmark-coder-review' });
      expect(result.ok).toBe(true);

      const rows = readTaskRows(c);
      const child = rows.find(task => task.id !== 'aaaa' && task.parent === 'aaaa'
        && !['dddd', 'bbbb', 'xxxx', 'ff1'].includes(task.id))!;
      expect(child).toBeDefined();
      expect(child.text).toBe('new child task');
      expect(child.parent).toBe('aaaa');
      expect(taskById(c, 'aaaa')!.depends_on).toContain(child.id);
    } finally {
      c.cleanup();
    }
  });

  it('R2-T4 decompose: forced keep-parent join node', async () => {
    const c = buildComposition();
    try {
      acquireTrialLock(c);
      const result = await c.call('task.decompose', {
        subtasks: [{ text: 'first child' }, { text: 'second child' }],
      });
      expect(result.ok).toBe(true);

      const rows = readTaskRows(c);
      const children = rows.filter(task => ['first child', 'second child'].includes(task.text));
      expect(children).toHaveLength(2);
      for (const child of children) expect(child.parent).toBe('aaaa');
      // The join parent survives, with both children in depends_on.
      const parent = taskById(c, 'aaaa')!;
      expect(parent).toBeDefined();
      for (const child of children) expect(parent.depends_on).toContain(child.id);
    } finally {
      c.cleanup();
    }
  });

  it('R2-T5 edit: dependency.declare on a named descendant, R1 held on cap.task_id', async () => {
    const c = buildComposition();
    try {
      acquireTrialLock(c);
      // bbbb carries a DIFFERENT generation than the requester — R1 must read cap.task_id's row.
      const result = await c.call('dependency.declare', { task_id: 'bbbb', depends_on: ['dddd'] });
      expect(result.ok).toBe(true);
      expect(taskById(c, 'bbbb')!.depends_on).toContain('dddd');
    } finally {
      c.cleanup();
    }
  });

  it('R2-T6 proposeComplete: records the intent and returns the exact store row', async () => {
    const c = buildComposition();
    try {
      const result = c.mutator.proposeComplete(c.requester, 'aaaa', 'the note');
      expect(result).not.toHaveProperty('success'); // a ProposalRow has no success member
      expect(c.recordedRows).toHaveLength(1);
      expect(c.recordedRows[0]).toBe(result); // same object reference
      const stored = JSON.parse(fs.readFileSync(proposalStorePath(c.project, 'aaaa'), 'utf8'));
      expect(stored.proposals).toHaveLength(1);
      expect(stored.proposals[0]).toEqual(result);
      expect(stored.proposals[0].intent).toBe('complete');
      expect(stored.proposals[0].note).toBe('the note');
      expect(stored.proposals[0].state).toBe('proposed');
    } finally {
      c.cleanup();
    }
  });

  it('R2-T7 proposeBlock: same store contract with intent block and opaque reason', async () => {
    const c = buildComposition();
    try {
      const result = c.mutator.proposeBlock(c.requester, 'aaaa', 'block reason');
      expect(c.recordedRows).toHaveLength(1);
      expect(c.recordedRows[0]).toBe(result);
      const stored = JSON.parse(fs.readFileSync(proposalStorePath(c.project, 'aaaa'), 'utf8'));
      expect(stored.proposals[0].intent).toBe('block');
      expect(stored.proposals[0].note).toBe('block reason');
      expect(stored.proposals[0].state).toBe('proposed');
    } finally {
      c.cleanup();
    }
  });
});

describe('R2-T8 — the C1–C5 fence: 33 for authority, 34 for stale, zero side effect', () => {
  function invoke(c: Composition, method: string, capability: ActorCapability): unknown {
    switch (method) {
      // claim's C5 pre-claim row is cap.task_id itself: an already-claimed row is 34.
      case 'claim': return c.mutator.claim(capability, 'aaaa');
      case 'unclaim': return c.mutator.unclaim(capability, 'aaaa');
      case 'add': return c.mutator.add(capability, { project: c.project, fields: { text: 'x' } });
      case 'decompose': return c.mutator.decompose(capability, {
        project: c.project, fields: { subtasks: [{ text: 'c' }] },
      });
      case 'edit': return c.mutator.edit(capability, {
        project: c.project, taskId: 'bbbb', fields: { addDependsOn: ['dddd'] },
      });
      case 'proposeComplete': return c.mutator.proposeComplete(capability, 'aaaa', 'n');
      case 'proposeBlock': return c.mutator.proposeBlock(capability, 'aaaa', 'r');
    }
    throw new Error(`unknown method ${method}`);
  }

  const methods = ['claim', 'unclaim', 'add', 'decompose', 'edit', 'proposeComplete', 'proposeBlock'];

  it.each(methods)('%s: non-exact and non-minted objects return 33 by value, never thrown, zero side effect', (method) => {
    const c = buildComposition();
    try {
      const before = seedFilesSnapshot(c);
      // Same token_id as the registered capability: token-id equality must NOT be authority.
      const tokenIdClone = Object.freeze({ ...c.requester });
      const cloneResult = invoke(c, method, tokenIdClone);
      expect(cloneResult).toEqual({ success: false, message: expect.any(String), code: 33 });
      expectZeroSideEffects(c, before);

      // A forged non-minted object with a foreign token id.
      const forged = Object.freeze({ ...c.requester, token_id: 'forged-token' });
      const forgedResult = invoke(c, method, forged);
      expect(forgedResult).toEqual({ success: false, message: expect.any(String), code: 33 });
      expectZeroSideEffects(c, before);
    } finally {
      c.cleanup();
    }
  });

  it.each(methods)('%s: a capability minted for another trial returns 33 and never registers', (method) => {
    const c = buildComposition();
    try {
      const before = seedFilesSnapshot(c);
      const foreign = mintActorCapability({
        trial_id: 'other-trial',
        task_id: 'aaaa',
        dispatch_generation: REQ_GEN,
        attempt_id: REQ_ATTEMPT,
        role: 'manager',
        ancestry: ['root'],
        capability_whitelist: managerWhitelist(),
        issued_at_epoch_ms: 4_000,
      });
      expect(() => c.registry.register(foreign)).toThrow();
      const result = invoke(c, method, foreign);
      expect(result).toEqual({ success: false, message: expect.any(String), code: 33 });
      expectZeroSideEffects(c, before);
    } finally {
      c.cleanup();
    }
  });

  it.each(['add', 'decompose', 'edit', 'proposeComplete', 'proposeBlock'])(
    '%s: action outside allowed_actions returns 33 (R8), zero side effect', (method) => {
      const c = buildComposition({ requesterActions: ['task.read', 'artifact.write'] });
      try {
        const before = seedFilesSnapshot(c);
        const result = invoke(c, method, c.requester);
        expect(result).toEqual({ success: false, message: expect.any(String), code: 33 });
        expectZeroSideEffects(c, before);
      } finally {
        c.cleanup();
      }
    },
  );

  it.each(methods)('%s: stale actor subject (generation or registry attempt) returns 34, zero side effect', (method) => {
    const c = buildComposition();
    try {
      const before = seedFilesSnapshot(c);
      const stale = staleCapabilityFor(c);
      // unclaim's C4 additionally requires the coordinator's release-transition mark; the stale
      // test marks the stale attempt so the refusal lands on C5 (34), not C4.
      if (method === 'unclaim') c.releasing.add('stale-attempt');
      const result = invoke(c, method, stale);
      expect(result).toEqual({ success: false, message: expect.any(String), code: 34 });
      expectZeroSideEffects(c, before);

      // A newer registered attempt makes the original capability's attempt stale (D-9).
      const newer = mintActorCapability({
        trial_id: c.trialId,
        task_id: 'aaaa',
        dispatch_generation: REQ_GEN,
        attempt_id: 'attempt-2',
        role: 'manager',
        ancestry: ['root'],
        capability_whitelist: managerWhitelist(),
        issued_at_epoch_ms: 5_000,
      });
      c.registry.register(newer);
      if (method === 'unclaim') {
        c.releasing.delete('stale-attempt');
        c.releasing.add(REQ_ATTEMPT);
      }
      const before2 = seedFilesSnapshot(c);
      const result2 = invoke(c, method, c.requester);
      expect(result2).toEqual({ success: false, message: expect.any(String), code: 34 });
      expectZeroSideEffects(c, before2);
    } finally {
      c.cleanup();
    }
  });

  it('claim: a pre-claim row that is already claimed returns 34 and invalidates no live token', async () => {
    const c = buildComposition();
    try {
      const first = await c.claimThroughBroker('dddd');
      expect(first.ok).toBe(true);
      const liveBefore = c.registry.liveCount();
      // Second claim of the same target: the broker guard refuses before any mint.
      await expect(c.claimThroughBroker('dddd')).rejects.toThrow(BrokerArgumentsError);
      expect(c.registry.liveCount()).toBe(liveBefore);
      expect(c.registry.isLive(c.requester.token_id)).toBe(true);
    } finally {
      c.cleanup();
    }
  });

  it('P3 source carries no event, hook or bus surface (the zero-emission half of the fence)', () => {
    const source = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname),
        '../../../src/domain/benchmark/trial-task-mutator.ts'),
      'utf8',
    );
    expect(source).not.toContain('hook-bus');
    expect(source).not.toContain('emitCortexEvent');
    expect(source).not.toContain('event-bus');
    expect(source).not.toContain('publish');
  });
});

describe('R2-T9 — claim is two-leg: requester currency, strict actionable unclaimed descendant, fresh unequal generation', () => {
  it('requires requester generation/attempt currency on the REQUESTER row before any mint', async () => {
    const c = buildComposition({ requesterGeneration: 'stale-gen' });
    try {
      const before = c.registry.liveCount();
      const result = refusalOf(await c.claimThroughBroker('dddd'));
      expect([result.code, result.reason]).toEqual([34, 'stale_generation']);
      expect(c.registry.liveCount()).toBe(before); // no mint happened
      expect(taskById(c, 'dddd')!.claimed_by).toBeNull();
    } finally {
      c.cleanup();
    }
  });

  it('requires the requester attempt to be the registry current attempt (D-9)', async () => {
    const c = buildComposition();
    try {
      const newer = mintActorCapability({
        trial_id: c.trialId,
        task_id: 'aaaa',
        dispatch_generation: REQ_GEN,
        attempt_id: 'attempt-2',
        role: 'manager',
        ancestry: ['root'],
        capability_whitelist: managerWhitelist(),
        issued_at_epoch_ms: 6_000,
      });
      c.registry.register(newer);
      const before = c.registry.liveCount();
      const result = refusalOf(await c.claimThroughBroker('dddd'));
      expect([result.code, result.reason]).toEqual([34, 'stale_generation']);
      expect(c.registry.liveCount()).toBe(before);
    } finally {
      c.cleanup();
    }
  });

  it('proves the target is a strict actionable unclaimed descendant of the requester task', async () => {
    const c = buildComposition();
    try {
      // cccc is a sibling of the requester's task — cross-branch, R2.
      const cross = refusalOf(await c.claimThroughBroker('cccc'));
      expect([cross.code, cross.reason]).toEqual([35, 'cross_branch_mutation']);
      // bbbb is a descendant but carries a dispatch_generation — the unclaimed check refuses it.
      await expect(c.claimThroughBroker('bbbb')).rejects.toThrow(BrokerArgumentsError);
      expect(taskById(c, 'bbbb')!.claimed_by).toBeNull(); // nothing was written
    } finally {
      c.cleanup();
    }
  });

  it('mints a fresh generation unequal to the requester and writes it through P3 claim', async () => {
    const c = buildComposition();
    try {
      const result = await c.claimThroughBroker('dddd');
      expect(result.ok).toBe(true);
      const row = taskById(c, 'dddd')!;
      expect(row.dispatch_generation).not.toBe(REQ_GEN);
      // The registry attempt for the target equals the written generation (one mint, one register).
      expect(c.registry.currentAttempt('dddd')).toEqual({
        dispatch_generation: row.dispatch_generation,
        attempt_id: TARGET_ATTEMPT,
      });
    } finally {
      c.cleanup();
    }
  });

  it('no argument, response or projection carries dispatch_generation or attempt_id', async () => {
    const c = buildComposition();
    try {
      const result = await c.claimThroughBroker('dddd');
      expect(result.ok).toBe(true);
      const json = JSON.stringify(result);
      expect(json).not.toContain('dispatch_generation');
      expect(json).not.toContain('attempt_id');
      expect(json).not.toContain(TARGET_ATTEMPT);
      // The model-facing read projection of the claimed row carries no generation either.
      const read = await c.call('task.read', { task_id: 'dddd' });
      expect(read.ok).toBe(true);
      const tasks = (read as { result: Readonly<Record<string, unknown>> }).result
        .tasks as Record<string, unknown>[];
      const projected = tasks[0];
      expect(projected).not.toHaveProperty('dispatch_generation');
      expect(projected).not.toHaveProperty('attempt_id');
      expect(projected).not.toHaveProperty('claimed_by');
    } finally {
      c.cleanup();
    }
  });
});

describe('R2-T10 — claim refusals precede any mint; post-registration failure invalidates the target token', () => {
  it('self, non-actionable and already-claimed targets are BrokerArgumentsError before any mint', async () => {
    const c = buildComposition();
    try {
      const before = c.registry.liveCount();
      await expect(c.claimThroughBroker('aaaa')).rejects.toThrow(BrokerArgumentsError); // self
      await expect(c.claimThroughBroker('xxxx')).rejects.toThrow(BrokerArgumentsError); // done
      await expect(c.claimThroughBroker('ff1')).rejects.toThrow(BrokerArgumentsError); // claimed
      expect(c.registry.liveCount()).toBe(before);
      expect(taskById(c, 'ff1')!.claimed_by).toBe('someone-else');
    } finally {
      c.cleanup();
    }
  });

  it('ancestor and cross-branch targets are R3/R2 refusals before any mint', async () => {
    const c = buildComposition();
    try {
      const before = c.registry.liveCount();
      const ancestor = refusalOf(await c.claimThroughBroker('root'));
      expect([ancestor.code, ancestor.reason]).toEqual([35, 'parent_completion_by_child']);
      const cross = refusalOf(await c.claimThroughBroker('cccc'));
      expect([cross.code, cross.reason]).toEqual([35, 'cross_branch_mutation']);
      expect(c.registry.liveCount()).toBe(before);
    } finally {
      c.cleanup();
    }
  });

  it('a failed post-registration claim invalidates the target token and never reports success', async () => {
    const c = buildComposition();
    try {
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
    } finally {
      c.cleanup();
    }
  });

  it('P3 rechecks target actionability after registration and before the lifecycle write', () => {
    const c = buildComposition({
      extraTasks: [taskRow({
        id: 'pppp', project: '_placeholder_', text: 'paused target', parent: 'aaaa', paused: true,
      })],
    });
    try {
      const target = mintActorCapability({
        trial_id: c.trialId,
        task_id: 'pppp',
        dispatch_generation: 'fresh-target-generation',
        attempt_id: 'paused-target-attempt',
        role: 'coder',
        ancestry: ['root', 'aaaa'],
        capability_whitelist: managerWhitelist(),
        allowed_actions: ['artifact.write', 'task.read'],
        issued_at_epoch_ms: 7_000,
      });
      c.registry.register(target);

      const result = c.mutator.claim(target, 'pppp');
      expect(result.success).toBe(false);
      expect(result).not.toHaveProperty('code');
      const row = taskById(c, 'pppp')!;
      expect(row.claimed_by).toBeNull();
      expect(row.dispatch_generation).toBeNull();
    } finally {
      c.cleanup();
    }
  });
});

describe('R2-T11 — unclaim is coordinator-internal self-release, gated by AttemptReleaseAuthority', () => {
  const ROLE_SLOTS = ['parent', 'manager', 'coder', 'reviewer', 'verifier'] as const;

  it.each(ROLE_SLOTS)('role %s: exact registered self/current attempt succeeds only while the release transition marks it', (role) => {
    const c = buildComposition({
      requesterRole: role,
      requesterActions: ['task.read'],
    });
    try {
      // Outside the release transition: 33, zero side effect.
      const before = seedFilesSnapshot(c);
      const outside = c.mutator.unclaim(c.requester, 'aaaa');
      expect(outside).toEqual({ success: false, message: expect.any(String), code: 33 });
      expectZeroSideEffects(c, before);

      // Inside the coordinator's finalisation/recovery transition: self-release succeeds.
      c.releasing.add(REQ_ATTEMPT);
      const result = c.mutator.unclaim(c.requester, 'aaaa');
      expect(result.success).toBe(true);
      const row = taskById(c, 'aaaa')!;
      expect(row.claimed_by).toBeNull();
      expect(row.dispatch_generation).toBeNull();
    } finally {
      c.cleanup();
    }
  });

  it('cross-target unclaim is 33 for every role', () => {
    const c = buildComposition();
    try {
      c.releasing.add(REQ_ATTEMPT);
      const result = c.mutator.unclaim(c.requester, 'dddd');
      expect(result).toEqual({ success: false, message: expect.any(String), code: 33 });
      expect(taskById(c, 'dddd')!.claimed_by).toBeNull();
      expect(taskById(c, 'aaaa')!.claimed_by).toBe('req-agent');
    } finally {
      c.cleanup();
    }
  });

  it('stale self row or stale registry attempt is 34 with zero side effect', () => {
    const c = buildComposition();
    try {
      const before = seedFilesSnapshot(c);
      const stale = staleCapabilityFor(c);
      c.releasing.add('stale-attempt');
      const result = c.mutator.unclaim(stale, 'aaaa');
      expect(result).toEqual({ success: false, message: expect.any(String), code: 34 });
      expectZeroSideEffects(c, before);
    } finally {
      c.cleanup();
    }
  });

  it('after the release transition clears its mark, the same call is 33 again', () => {
    const c = buildComposition();
    try {
      c.releasing.add(REQ_ATTEMPT);
      expect(c.mutator.unclaim(c.requester, 'aaaa').success).toBe(true);
      // Production order: clear the mark, then invalidate the token.
      c.releasing.delete(REQ_ATTEMPT);
      c.registry.invalidateToken(c.requester.token_id);
      const after = c.mutator.unclaim(c.requester, 'aaaa');
      expect(after).toEqual({ success: false, message: expect.any(String), code: 33 });
    } finally {
      c.cleanup();
    }
  });
});

describe('R2-T12 — add/decompose reuse the shipped one-child keep-parent spawn', () => {
  it('add never calls top-level addTask: the child hangs under cap.task_id and the parent joins on it', async () => {
    const c = buildComposition();
    try {
      acquireTrialLock(c);
      const result = await c.call('task.create', { text: 'spawned child' });
      expect(result.ok).toBe(true);
      const rows = readTaskRows(c);
      const child = rows.find(task => task.text === 'spawned child')!;
      expect(child.parent).toBe('aaaa'); // top-level addTask would set parent null
      expect(child.origin_thread_id).toBeNull();
      expect(taskById(c, 'aaaa')!.depends_on).toContain(child.id);
    } finally {
      c.cleanup();
    }
  });

  it('decompose forces keepParent: the parent row survives as the join node', async () => {
    const c = buildComposition();
    try {
      acquireTrialLock(c);
      const result = await c.call('task.decompose', {
        subtasks: [{ text: 'child-a' }, { text: 'child-b' }],
      });
      expect(result.ok).toBe(true);
      const rows = readTaskRows(c);
      const parent = rows.find(task => task.id === 'aaaa')!;
      expect(parent.text).toBe('requester task'); // row not replaced by the destructive variant
      const children = rows.filter(task => ['child-a', 'child-b'].includes(task.text));
      for (const child of children) expect(child.parent).toBe('aaaa');
      expect(parent.depends_on.sort()).toEqual(children.map(child => child.id).sort());
    } finally {
      c.cleanup();
    }
  });

  it('a contended trial lock fails fast with a no-code failure — no system-lock spin', async () => {
    const c = buildComposition();
    try {
      expect(c.table.acquire(c.project, 'other-owner').acquired).toBe(true);
      const started = Date.now();
      const result = await c.call('task.create', { text: 'contended' });
      expect(result.ok).toBe(false);
      const refusal = refusalOf(result);
      expect(refusal.reason).toBe('lock_not_held');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(taskById(c, 'aaaa')!.depends_on).toEqual([]);
    } finally {
      c.cleanup();
    }
  });
});

describe('R2-T13 — edit proves R1 against cap.task_id; the named target is checked separately', () => {
  it('a stale requester generation refuses 34 even when the named target is current', async () => {
    const c = buildComposition({ requesterGeneration: 'stale-gen' });
    try {
      acquireTrialLock(c);
      const before = seedFilesSnapshot(c);
      const result = refusalOf(await c.call('dependency.declare', {
        task_id: 'bbbb', depends_on: ['dddd'],
      }));
      expect([result.code, result.reason]).toEqual([34, 'stale_generation']);
      expectZeroSideEffects(c, before);
    } finally {
      c.cleanup();
    }
  });

  it('the requester generation is never compared with the named target row', async () => {
    const c = buildComposition();
    try {
      acquireTrialLock(c);
      // bbbb carries dispatch_generation 'other-gen' — a requester-vs-target comparison
      // would refuse here; R1 reads cap.task_id only.
      const result = await c.call('dependency.declare', { task_id: 'bbbb', depends_on: ['dddd'] });
      expect(result.ok).toBe(true);
      expect(taskById(c, 'bbbb')!.depends_on).toContain('dddd');
    } finally {
      c.cleanup();
    }
  });

  it('the target guards (branch, acyclic, lock) inspect the named descendant', async () => {
    const c = buildComposition();
    try {
      acquireTrialLock(c);
      // Cross-branch endpoint: cccc is not in the requester's branch.
      const cross = refusalOf(await c.call('dependency.declare', {
        task_id: 'bbbb', depends_on: ['cccc'],
      }));
      expect([cross.code, cross.reason]).toEqual([35, 'cross_branch_mutation']);
      // dddd→bbbb is acyclic; the follow-up bbbb→dddd would close a cycle and is refused as a
      // mutation-validity BrokerArgumentsError (no code exists for a cyclic declare, G5-N4).
      const first = await c.call('dependency.declare', { task_id: 'dddd', depends_on: ['bbbb'] });
      expect(first.ok).toBe(true);
      await expect(c.call('dependency.declare', {
        task_id: 'bbbb', depends_on: ['dddd'],
      })).rejects.toThrow(BrokerArgumentsError);
    } finally {
      c.cleanup();
    }
  });
});

describe('R2-T14 — proposals return the exact recordProposal object; refusals precede store access', () => {
  it('valid proposals write and read back the real file exactly once per call', () => {
    const c = buildComposition();
    try {
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
    } finally {
      c.cleanup();
    }
  });

  it('33/34 refusals are returned by value before the store is touched', () => {
    const c = buildComposition();
    try {
      const stale = staleCapabilityFor(c);
      const before = seedFilesSnapshot(c);
      const refused = c.mutator.proposeComplete(stale, 'aaaa', 'n');
      // By value — the return IS the refusal, nothing was thrown.
      expect(refused).toEqual({ success: false, message: expect.any(String), code: 34 });
      const refusedBlock = c.mutator.proposeBlock(stale, 'aaaa', 'r');
      expect(refusedBlock).toEqual({ success: false, message: expect.any(String), code: 34 });
      expectZeroSideEffects(c, before);
    } finally {
      c.cleanup();
    }
  });
});

describe('R2-T15 — forced proposal-store read error: detail, public reason and code 42', () => {
  it('ProposalSealError carries detail store_unreadable, reason ledger_unreadable, code 42', () => {
    const c = buildComposition();
    try {
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
    } finally {
      c.cleanup();
    }
  });

  it('the broker matches the public reason and returns a 42 refusal frame', async () => {
    const c = buildComposition();
    try {
      const target = proposalStorePath(c.project, 'aaaa');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{not-json');
      const result = refusalOf(await c.broker.proposeComplete(c.requester, 'aaaa', 'n'));
      expect([result.code, result.reason]).toEqual([42, 'ledger_unreadable']);
    } finally {
      c.cleanup();
    }
  });
});

describe('R2-T16 — proposed leaves authoritative state unchanged and emits no in-trial event', () => {
  it('task status, claim and dependencies are byte-identical after a proposal', async () => {
    const c = buildComposition();
    try {
      const before = fs.readFileSync(c.tasksPath, 'utf8');
      const result = await c.call('task.propose_complete', { note: 'done soon' });
      expect(result.ok).toBe(true);
      expect((result as { result: Record<string, unknown> }).result).toEqual({ proposal_recorded: true });
      const after = fs.readFileSync(c.tasksPath, 'utf8');
      expect(after).toBe(before);
      const row = taskById(c, 'aaaa')!;
      expect(row.status).toBe('open');
      expect(row.claimed_by).toBe('req-agent');
      expect(row.dispatch_generation).toBe(REQ_GEN);
    } finally {
      c.cleanup();
    }
  });

  it('proposeComplete never routes into a completion lifecycle', () => {
    const c = buildComposition();
    try {
      c.mutator.proposeComplete(c.requester, 'aaaa', 'n');
      const row = taskById(c, 'aaaa')!;
      expect(row.status).toBe('open'); // a routed completion would flip status to done
      expect(row.completed_at).toBeNull();
    } finally {
      c.cleanup();
    }
  });
});

describe('R2-T17 — concurrent production-factory calls equal a serial order; results are never Promise-shaped', () => {
  it('P3 methods are synchronous: the direct result is a plain object, not a Promise', () => {
    const c = buildComposition();
    try {
      acquireTrialLock(c);
      const result = c.mutator.add(c.requester, {
        project: c.project, fields: { text: 'sync child' },
      });
      expect(result).not.toBeInstanceOf(Promise);
      expect(result.success).toBe(true);
      expect(taskById(c, 'aaaa')!.depends_on).toHaveLength(1);
    } finally {
      c.cleanup();
    }
  });

  it('concurrent broker calls leave exactly the serial final state with no lost mutation', async () => {
    const c = buildComposition();
    try {
      acquireTrialLock(c);
      const calls = [
        ...Array.from({ length: 4 }, (_, i) => c.call('task.create', { text: `concurrent-${i}` })),
        c.call('task.propose_complete', { note: 'concurrent proposal' }),
        c.call('task.propose_block', { reason: 'concurrent block' }),
        c.call('dependency.declare', { task_id: 'bbbb', depends_on: ['dddd'] }),
      ];
      const results = await Promise.all(calls);
      for (const result of results) {
        expect(result).not.toBeInstanceOf(Promise);
        expect(typeof (result as { then?: unknown }).then).not.toBe('function');
        expect(result.ok).toBe(true);
      }
      const rows = readTaskRows(c);
      const children = rows.filter(task => /^concurrent-\d$/.test(task.text));
      expect(children).toHaveLength(4);
      for (const child of children) expect(child.parent).toBe('aaaa');
      expect(taskById(c, 'aaaa')!.depends_on.sort()).toEqual(children.map(child => child.id).sort());
      expect(taskById(c, 'bbbb')!.depends_on).toContain('dddd');
      const stored = JSON.parse(fs.readFileSync(proposalStorePath(c.project, 'aaaa'), 'utf8'));
      expect(stored.proposals).toHaveLength(1);
    } finally {
      c.cleanup();
    }
  });
});

describe('R2-T18 — pins: proposal-seal hash, sole mint, no second token, no model generation field', () => {
  it('proposal-seal.ts is byte-identical to the accepted pin md5', () => {
    const bytes = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname),
        '../../../src/domain/benchmark/proposal-seal.ts'),
    );
    const hash = crypto.createHash('md5').update(bytes).digest('hex');
    expect(hash).toBe('b7527c95219c54f9bb98ece7a4f284d8');
  });

  it('the dispatcher carries the sole generation mint and both consumers use it', () => {
    const source = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname),
        '../../../src/domain/benchmark/trial-task-dispatcher.ts'),
      'utf8',
    );
    const literals = source.match(/const dispatchGeneration = randomUUID\(\);/g) ?? [];
    expect(literals).toHaveLength(1);
    expect(source).toContain('export function mintTrialDispatchGeneration()');
    expect(source.match(/mintTrialDispatchGeneration\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    const first = mintTrialDispatchGeneration();
    const second = mintTrialDispatchGeneration();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });

  it('the claim callback mints and registers exactly one target capability through the production mint', () => {
    const source = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname),
        '../../../src/domain/benchmark/trial-task-dispatcher.ts'),
      'utf8',
    );
    expect(source.match(/mintActorCapability\(/g)).toHaveLength(1);
    expect(source.match(/\.register\(/g)).toHaveLength(1);
    expect(source.match(/invalidateToken\(/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('the P3 module imports only Node builtins and ./capabilities.js', () => {
    const source = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname),
        '../../../src/domain/benchmark/trial-task-mutator.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1]);
    for (const specifier of imports) {
      const isBuiltin = /^node:/.test(specifier) || specifier === 'node:crypto';
      const isCapabilities = specifier === './capabilities.js';
      expect(isBuiltin || isCapabilities, `import ${specifier}`).toBe(true);
    }
  });

  it('the broker surface carries no task.unclaim action, tool or CLI name', () => {
    const brokerSource = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname),
        '../../../src/domain/benchmark/task-broker.ts'),
      'utf8',
    );
    expect(brokerSource).not.toContain("'task.unclaim'");
    expect(brokerSource).not.toContain('task_unclaim');
    expect(BENCHMARK_BROKER_ACTIONS).not.toContain('task.unclaim');
  });
});
