// input:  trial-local task store, limits, clock and manager actions
// output: durable task DAG, attempts, verdicts and finalization evidence
// pos:    Trial-local manager task-tree authority
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteSync } from '../../core/atomic-write.js';
import type { Task } from '../../core/task-parser.js';
import type { RoleSlot } from './capabilities.js';
import {
  mintActorCapability, type ActorCapability, type BenchmarkBrokerCapability,
} from './capabilities.js';
import {
  createActorCapabilityRegistry, type ActorCapabilityRegistry,
} from './actor-capability-scope.js';
import type { DeterministicClock } from './trial-clock.js';

export type TreeAttemptRole = 'manager' | 'coder';
export type TreeVerdict = 'pending' | 'accepted' | 'rejected' | 'superseded';

export interface TrialSubtaskInput {
  key: string;
  text: string;
  doneWhen: string;
  template: 'benchmark-manager' | 'benchmark-coder-review';
  why?: string;
  dependsOn?: string[];
}

export interface TrialAttempt {
  capability: ActorCapability;
  dispatchGeneration: string;
  attemptId: string;
  ordinal: number;
  task: Task;
  role: TreeAttemptRole;
}

export interface AttemptFinishInput {
  kind: 'complete' | 'block' | 'continue';
  note: string;
  threadId: string;
  quiescent: boolean;
  manifestCommitted: boolean;
}

export interface TrialAttemptEvidence {
  taskId: string;
  parentTaskId: string | null;
  attemptId: string;
  dispatchGeneration: string;
  ordinal: number;
  role: TreeAttemptRole;
  template: string;
  threadId: string;
  kind: AttemptFinishInput['kind'];
  note: string;
  quiescent: boolean;
  manifestCommitted: boolean;
  disposition: TreeVerdict | 'none' | 'invalidated';
}

export interface AcceptanceState {
  parentId: string;
  verdict: TreeVerdict;
  note: string;
  reworkRound: number;
}

interface ManagerState {
  phase: 'ready' | 'running' | 'waiting' | 'question' | 'completed' | 'cancelled';
  artifact: string;
  rotations: number;
  parentAnswer: string | null;
}

interface AttemptState extends Omit<TrialAttemptEvidence, 'threadId' | 'kind' | 'note' | 'quiescent' | 'manifestCommitted' | 'disposition'> {
  status: 'active' | 'terminal' | 'invalidated';
  threadId: string | null;
  kind: AttemptFinishInput['kind'] | null;
  note: string | null;
  quiescent: boolean | null;
  manifestCommitted: boolean | null;
  disposition: TreeVerdict | 'none' | 'invalidated';
}

interface TreeState {
  schemaVersion: 'cortex-trial-task-tree/1';
  rootTaskId: string | null;
  nextTask: number;
  attempts: AttemptState[];
  acceptance: Record<string, AcceptanceState>;
  managers: Record<string, ManagerState>;
  terminal: 'running' | 'completed' | 'failed' | 'cancelled';
  cancelReason: string | null;
}

export interface TreeSnapshot {
  rootTaskId: string | null;
  tasks: Task[];
  attempts: TrialAttemptEvidence[];
  acceptance: Record<string, AcceptanceState>;
  managers: Record<string, ManagerState>;
  writer: string | null;
  terminal: TreeState['terminal'];
}

export interface TreeFinalizationEvidence {
  terminal: 'completed' | 'failed' | 'cancelled';
  rootCompleted: boolean;
  descendantsQuiescent: boolean;
  liveCapabilities: number;
  writer: string | null;
}

export interface TrialTaskStorePort {
  getById(taskId: string): Task | null;
  getAll(project?: string): Task[];
  flush(): Promise<void>;
  set(task: Task): Promise<void>;
}

export interface TrialTaskTreeInput {
  trialId: string;
  project: string;
  root: string;
  tasks: TrialTaskStorePort;
  clock: DeterministicClock;
  limits: { maxTasks: number; maxDepth: number };
  qaEnabled: boolean;
}

export interface RootTaskInput {
  text: string;
  doneWhen: string;
}

export interface TrialTaskTreeCoordinator {
  initializeRoot(input: RootTaskInput): Promise<Task>;
  startAttempt(taskId: string, role: TreeAttemptRole): Promise<TrialAttempt>;
  decompose(capability: ActorCapability, subtasks: TrialSubtaskInput[]): Promise<Task[]>;
  wait(capability: ActorCapability): Promise<void>;
  actionable(): Task[];
  finishAttempt(capability: ActorCapability, input: AttemptFinishInput): Promise<boolean>;
  recordVerdict(
    capability: ActorCapability, childId: string, verdict: 'accepted' | 'rejected', note: string,
  ): Promise<void>;
  resumeReadyManagers(): Promise<string[]>;
  completeManager(capability: ActorCapability, note: string): Promise<void>;
  checkpointManager(capability: ActorCapability, artifact: string): Promise<void>;
  setParentAnswer(taskId: string, answer: string): Promise<void>;
  consumeParentAnswer(taskId: string): string | null;
  withWriter<T>(capability: ActorCapability, action: () => Promise<T>): Promise<T>;
  cancel(reason: string): Promise<void>;
  finalize(terminal: 'completed' | 'failed' | 'cancelled'): Promise<TreeFinalizationEvidence>;
  snapshot(): TreeSnapshot;
  capabilityRegistry(): ActorCapabilityRegistry;
}

function initialState(): TreeState {
  return {
    schemaVersion: 'cortex-trial-task-tree/1', rootTaskId: null, nextTask: 1,
    attempts: [], acceptance: {}, managers: {}, terminal: 'running', cancelReason: null,
  };
}

function statePath(root: string): string {
  return path.join(root, 'coordinator', 'task-tree.json');
}

function readState(root: string): TreeState {
  const file = statePath(root);
  if (!fs.existsSync(file)) return initialState();
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as TreeState;
  if (value?.schemaVersion !== 'cortex-trial-task-tree/1' || !Array.isArray(value.attempts)) {
    throw new Error(`Trial task tree is malformed: ${file}`);
  }
  return value;
}

function writeState(root: string, state: TreeState): void {
  const file = statePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function taskId(state: TreeState): string {
  const id = state.nextTask.toString(16).padStart(4, '0');
  state.nextTask += 1;
  return id;
}

function newTask(
  input: TrialTaskTreeInput,
  id: string,
  parent: string | null,
  subtask: Omit<TrialSubtaskInput, 'key' | 'dependsOn'>,
  dependencies: string[],
): Task {
  return {
    id, project: input.project, text: subtask.text, why: subtask.why ?? '',
    done_when: subtask.doneWhen, priority: 'medium', status: 'open', template: subtask.template,
    plan: '', parent, depends_on: dependencies, gpu: null, gpu_count: 0, blocked_by: null,
    claimed_by: null, claimed_at: null, dispatch_generation: null, paused: false,
    approval_needed: false, approved_at: null, not_before: null, completed_at: null,
    completed_note: null, pending_at: null, origin_session_id: null, origin_channel: null,
    origin_thread_id: null,
  };
}

function rootTask(input: TrialTaskTreeInput, root: RootTaskInput): Task {
  return newTask(input, 'root', null, {
    text: root.text, doneWhen: root.doneWhen, template: 'benchmark-manager',
  }, []);
}

function managerState(state: TreeState, id: string): ManagerState {
  return state.managers[id] ?? (state.managers[id] = {
    phase: 'ready', artifact: '', rotations: 0, parentAnswer: null,
  });
}

function taskAncestors(tasks: TrialTaskStorePort, task: Task): string[] {
  const ancestors: string[] = [];
  let parent = task.parent;
  while (parent) {
    ancestors.unshift(parent);
    parent = tasks.getById(parent)?.parent ?? null;
  }
  return ancestors;
}

function actions(
  input: TrialTaskTreeInput,
  role: TreeAttemptRole,
): BenchmarkBrokerCapability[] {
  const values: BenchmarkBrokerCapability[] = role === 'manager'
    ? [
      'task.read', 'task.create', 'task.decompose', 'task.claim',
      'task.propose_complete', 'task.propose_block', 'artifact.write', 'dependency.declare',
    ]
    : ['task.read', 'task.claim', 'task.propose_complete', 'task.propose_block', 'artifact.write'];
  if (input.qaEnabled) {
    values.push('qa.ask');
    if (role === 'manager') values.push('qa.answer');
  }
  return values;
}

function requireAction(
  capability: ActorCapability,
  action: BenchmarkBrokerCapability,
): void {
  if (!capability.allowed_actions.has(action)) {
    throw new Error(`capability does not allow ${action}`);
  }
}

function requireManager(capability: ActorCapability): void {
  if (capability.role !== 'manager') throw new Error('manager capability required');
}

function roleSlot(role: TreeAttemptRole): RoleSlot {
  return role === 'manager' ? 'manager' : 'coder';
}

function attemptOrdinal(state: TreeState, id: string): number {
  return state.attempts.filter(attempt => attempt.taskId === id).length + 1;
}

function currentAttempt(state: TreeState, taskIdValue: string): AttemptState | null {
  return [...state.attempts].reverse().find(
    attempt => attempt.taskId === taskIdValue && attempt.status === 'active',
  ) ?? null;
}

function invalidateCurrent(
  state: TreeState,
  registry: ActorCapabilityRegistry,
  taskIdValue: string,
): void {
  const current = currentAttempt(state, taskIdValue);
  if (!current) return;
  current.status = 'invalidated';
  current.disposition = 'invalidated';
  registry.invalidateAttempt(current.attemptId);
}

function requireCurrent(
  state: TreeState,
  registry: ActorCapabilityRegistry,
  capability: ActorCapability,
): AttemptState {
  const attempt = currentAttempt(state, capability.task_id);
  const matches = attempt?.attemptId === capability.attempt_id
    && attempt.dispatchGeneration === capability.dispatch_generation
    && registry.isRegistered(capability);
  if (!matches) throw new Error('stale task dispatch generation');
  return attempt!;
}

function depth(tasks: TrialTaskStorePort, task: Task): number {
  return taskAncestors(tasks, task).length;
}

function dependenciesFor(
  subtask: TrialSubtaskInput,
  localIds: ReadonlyMap<string, string>,
): string[] {
  return (subtask.dependsOn ?? []).map(dependency => localIds.get(dependency) ?? dependency);
}

function assertSubtasks(
  input: TrialTaskTreeInput,
  state: TreeState,
  parent: Task,
  subtasks: TrialSubtaskInput[],
): void {
  if (subtasks.length === 0) throw new Error('decompose requires at least one subtask');
  if (input.tasks.getAll(input.project).length + subtasks.length > input.limits.maxTasks) {
    throw new Error('manager task limit exceeded');
  }
  if (depth(input.tasks, parent) >= input.limits.maxDepth) {
    throw new Error('manager task depth exceeded');
  }
  const keys = subtasks.map(subtask => subtask.key);
  if (new Set(keys).size !== keys.length || keys.some(key => !key)) {
    throw new Error('subtask keys must be unique and non-empty');
  }
  const declared = new Set(keys);
  if (subtasks.some(subtask => (subtask.dependsOn ?? []).some(key => !declared.has(key)))) {
    throw new Error('subtask names an unknown local dependency');
  }
  if (state.terminal !== 'running') throw new Error('trial is finalizing');
}

function hasCycle(tasks: Task[]): boolean {
  const edges = new Map(tasks.map(task => [task.id, task.depends_on]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((edges.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...edges.keys()].some(visit);
}

function acceptanceReady(state: TreeState, dependency: string): boolean {
  return state.acceptance[dependency]?.verdict === 'accepted';
}

function taskIsActionable(input: TrialTaskTreeInput, state: TreeState, task: Task): boolean {
  if (task.status !== 'open' || task.blocked_by || task.paused) return false;
  if (currentAttempt(state, task.id)) return false;
  if (!task.depends_on.every(dependency => acceptanceReady(state, dependency))) return false;
  if (task.template !== 'benchmark-manager') return true;
  return managerState(state, task.id).phase === 'ready';
}

function finishEvidence(attempt: AttemptState, finish: AttemptFinishInput): TrialAttemptEvidence {
  return {
    taskId: attempt.taskId, parentTaskId: attempt.parentTaskId,
    attemptId: attempt.attemptId, dispatchGeneration: attempt.dispatchGeneration,
    ordinal: attempt.ordinal, role: attempt.role, template: attempt.template,
    threadId: finish.threadId, kind: finish.kind, note: finish.note,
    quiescent: finish.quiescent, manifestCommitted: finish.manifestCommitted,
    disposition: attempt.disposition,
  };
}

function evidenceOf(attempt: AttemptState): TrialAttemptEvidence | null {
  if (attempt.threadId === null || attempt.kind === null || attempt.note === null
      || attempt.quiescent === null || attempt.manifestCommitted === null) return null;
  return finishEvidence(attempt, {
    threadId: attempt.threadId, kind: attempt.kind, note: attempt.note,
    quiescent: attempt.quiescent, manifestCommitted: attempt.manifestCommitted,
  });
}

function settleAttemptState(attempt: AttemptState, finish: AttemptFinishInput): void {
  attempt.status = 'terminal';
  attempt.threadId = finish.threadId;
  attempt.kind = finish.kind;
  attempt.note = finish.note;
  attempt.quiescent = finish.quiescent;
  attempt.manifestCommitted = finish.manifestCommitted;
}

async function persist(input: TrialTaskTreeInput, state: TreeState): Promise<void> {
  writeState(input.root, state);
  await input.tasks.flush();
}

export function createTrialTaskTreeCoordinator(
  input: TrialTaskTreeInput,
): TrialTaskTreeCoordinator {
  const state = readState(input.root);
  const registry = createActorCapabilityRegistry(input.trialId);
  let writer: string | null = null;

  async function initializeRootTask(root: RootTaskInput): Promise<Task> {
    if (state.rootTaskId) return input.tasks.getById(state.rootTaskId)!;
    const task = rootTask(input, root);
    state.rootTaskId = task.id;
    managerState(state, task.id);
    await input.tasks.set(task);
    await persist(input, state);
    return task;
  }

  async function startAttempt(taskIdValue: string, role: TreeAttemptRole): Promise<TrialAttempt> {
    const task = input.tasks.getById(taskIdValue);
    if (!task) throw new Error(`unknown trial task: ${taskIdValue}`);
    const expectedRole: TreeAttemptRole = task.template === 'benchmark-manager' ? 'manager' : 'coder';
    if (role !== expectedRole) throw new Error('attempt role does not match task template');
    const rotatingManager = role === 'manager' && currentAttempt(state, task.id) !== null
      && managerState(state, task.id).phase === 'ready';
    if (!rotatingManager && !taskIsActionable(input, state, task)) {
      throw new Error('trial task is not actionable');
    }
    invalidateCurrent(state, registry, task.id);
    const ordinal = attemptOrdinal(state, task.id);
    const dispatchGeneration = crypto.randomUUID();
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const capability = mintActorCapability({
      trial_id: input.trialId, task_id: task.id, dispatch_generation: dispatchGeneration,
      attempt_id: attemptId, role: roleSlot(role), ancestry: taskAncestors(input.tasks, task),
      capability_whitelist: actions(input, 'manager'), allowed_actions: actions(input, role),
      issued_at_epoch_ms: input.clock.nowMs(),
    });
    registry.register(capability);
    task.claimed_by = attemptId;
    task.claimed_at = input.clock.nowDate().toISOString();
    task.dispatch_generation = dispatchGeneration;
    if (role === 'manager') managerState(state, task.id).phase = 'running';
    state.attempts.push({
      taskId: task.id, parentTaskId: task.parent, attemptId, dispatchGeneration, ordinal,
      role, template: task.template, status: 'active', threadId: null, kind: null, note: null,
      quiescent: null, manifestCommitted: null, disposition: 'none',
    });
    await input.tasks.set(task);
    await persist(input, state);
    return { capability, dispatchGeneration, attemptId, ordinal, task, role };
  }

  async function decompose(
    capability: ActorCapability,
    subtasks: TrialSubtaskInput[],
  ): Promise<Task[]> {
    requireCurrent(state, registry, capability);
    requireAction(capability, 'task.decompose');
    const parent = input.tasks.getById(capability.task_id)!;
    assertSubtasks(input, state, parent, subtasks);
    const ids = new Map(subtasks.map(subtask => [subtask.key, taskId(state)]));
    const created = subtasks.map(subtask => newTask(input, ids.get(subtask.key)!, parent.id, {
      text: subtask.text, doneWhen: subtask.doneWhen,
      template: subtask.template, why: subtask.why,
    }, dependenciesFor(subtask, ids)));
    const all = [...input.tasks.getAll(input.project), ...created];
    if (hasCycle(all)) throw new Error('declared dependencies contain a cycle');
    for (const task of created) {
      await input.tasks.set(task);
      if (task.template === 'benchmark-manager') managerState(state, task.id);
      state.acceptance[task.id] = {
        parentId: parent.id, verdict: 'pending', note: '', reworkRound: 0,
      };
    }
    await persist(input, state);
    return created;
  }

  async function wait(capability: ActorCapability): Promise<void> {
    requireCurrent(state, registry, capability);
    requireManager(capability);
    managerState(state, capability.task_id).phase = 'waiting';
    await persist(input, state);
  }

  function actionable(): Task[] {
    return input.tasks.getAll(input.project).filter(task => taskIsActionable(input, state, task));
  }

  async function finishAttempt(
    capability: ActorCapability,
    finish: AttemptFinishInput,
  ): Promise<boolean> {
    let attempt: AttemptState;
    try { attempt = requireCurrent(state, registry, capability); }
    catch {
      const completedManager = state.attempts.find(candidate => (
        candidate.attemptId === capability.attempt_id
        && candidate.status === 'active'
        && managerState(state, capability.task_id).phase === 'completed'
      ));
      if (!completedManager) return false;
      attempt = completedManager;
    }
    requireAction(capability, finish.kind === 'block' ? 'task.propose_block'
      : finish.kind === 'complete' ? 'task.propose_complete' : 'task.read');
    if (!finish.quiescent || !finish.manifestCommitted) {
      attempt.status = 'invalidated';
      attempt.disposition = 'invalidated';
      settleAttemptState(attempt, finish);
      registry.invalidateToken(capability.token_id);
      await persist(input, state);
      return false;
    }
    settleAttemptState(attempt, finish);
    registry.invalidateToken(capability.token_id);
    const task = input.tasks.getById(capability.task_id)!;
    if (attempt.role === 'coder') {
      await settleLeaf(task, finish);
      const acceptance = state.acceptance[task.id];
      if (finish.kind === 'complete' && acceptance?.verdict === 'rejected') {
        acceptance.verdict = 'pending';
      }
    }
    attempt.disposition = task.parent ? state.acceptance[task.id]?.verdict ?? 'pending' : 'none';
    await persist(input, state);
    return true;
  }

  async function settleLeaf(task: Task, finish: AttemptFinishInput): Promise<void> {
    task.claimed_by = null;
    task.claimed_at = null;
    if (finish.kind === 'complete') {
      task.status = 'done';
      task.completed_note = finish.note;
      task.completed_at = input.clock.nowDate().toISOString();
      task.blocked_by = null;
    } else if (finish.kind === 'block') {
      task.blocked_by = finish.note;
    }
    await input.tasks.set(task);
  }

  async function recordVerdict(
    capability: ActorCapability,
    childId: string,
    verdict: 'accepted' | 'rejected',
    note: string,
  ): Promise<void> {
    requireCurrent(state, registry, capability);
    requireManager(capability);
    const child = input.tasks.getById(childId);
    const acceptance = state.acceptance[childId];
    if (!child || child.parent !== capability.task_id || !acceptance) {
      throw new Error('acceptance target is outside the manager branch');
    }
    if (child.status !== 'done') throw new Error('acceptance target is not complete');
    acceptance.verdict = verdict;
    acceptance.note = note;
    const attempt = [...state.attempts].reverse().find(row => row.taskId === childId);
    if (attempt) attempt.disposition = verdict;
    if (verdict === 'rejected') await reopenChild(child, acceptance);
    await persist(input, state);
  }

  async function reopenChild(child: Task, acceptance: AcceptanceState): Promise<void> {
    acceptance.reworkRound += 1;
    child.status = 'open';
    child.completed_at = null;
    child.completed_note = null;
    child.claimed_by = null;
    child.claimed_at = null;
    child.dispatch_generation = null;
    if (child.template === 'benchmark-manager') managerState(state, child.id).phase = 'ready';
    managerState(state, acceptance.parentId).phase = 'waiting';
    await input.tasks.set(child);
  }

  async function resumeReadyManagers(): Promise<string[]> {
    const ready: string[] = [];
    for (const [id, manager] of Object.entries(state.managers)) {
      if (manager.phase !== 'waiting') continue;
      const children = input.tasks.getAll(input.project).filter(task => task.parent === id);
      if (!children.some(child => child.status === 'done'
        && state.acceptance[child.id]?.verdict === 'pending')) continue;
      manager.phase = 'ready';
      ready.push(id);
    }
    if (ready.length > 0) await persist(input, state);
    return ready;
  }

  async function completeManager(capability: ActorCapability, note: string): Promise<void> {
    requireCurrent(state, registry, capability);
    requireManager(capability);
    requireAction(capability, 'task.propose_complete');
    const task = input.tasks.getById(capability.task_id)!;
    const children = input.tasks.getAll(input.project).filter(child => child.parent === task.id);
    if (children.some(child => state.acceptance[child.id]?.verdict !== 'accepted')) {
      throw new Error('manager has a pending verdict');
    }
    task.status = 'done';
    task.completed_note = note;
    task.completed_at = input.clock.nowDate().toISOString();
    task.claimed_by = null;
    task.claimed_at = null;
    managerState(state, task.id).phase = 'completed';
    registry.invalidateToken(capability.token_id);
    await input.tasks.set(task);
    await persist(input, state);
  }

  async function checkpointManager(
    capability: ActorCapability,
    artifact: string,
  ): Promise<void> {
    requireCurrent(state, registry, capability);
    requireManager(capability);
    requireAction(capability, 'artifact.write');
    const manager = managerState(state, capability.task_id);
    manager.artifact = artifact;
    manager.rotations += 1;
    await persist(input, state);
  }

  async function setParentAnswer(taskIdValue: string, answer: string): Promise<void> {
    const manager = managerState(state, taskIdValue);
    manager.parentAnswer = answer;
    manager.phase = 'ready';
    await persist(input, state);
  }

  function consumeParentAnswer(taskIdValue: string): string | null {
    const manager = managerState(state, taskIdValue);
    const answer = manager.parentAnswer;
    manager.parentAnswer = null;
    writeState(input.root, state);
    return answer;
  }

  async function withWriter<T>(
    capability: ActorCapability,
    action: () => Promise<T>,
  ): Promise<T> {
    requireCurrent(state, registry, capability);
    requireAction(capability, 'artifact.write');
    if (writer !== null) throw new Error(`workspace writer already held by ${writer}`);
    writer = capability.attempt_id;
    try { return await action(); }
    finally { writer = null; }
  }

  async function cancel(reason: string): Promise<void> {
    state.terminal = 'cancelled';
    state.cancelReason = reason;
    registry.invalidateTrial();
    writer = null;
    for (const attempt of state.attempts) {
      if (attempt.status === 'active') {
        attempt.status = 'invalidated';
        attempt.disposition = 'invalidated';
      }
    }
    for (const manager of Object.values(state.managers)) {
      if (manager.phase !== 'completed') manager.phase = 'cancelled';
    }
    await persist(input, state);
  }

  async function finalize(
    terminal: 'completed' | 'failed' | 'cancelled',
  ): Promise<TreeFinalizationEvidence> {
    const root = state.rootTaskId ? input.tasks.getById(state.rootTaskId) : null;
    if (terminal === 'completed' && root?.status !== 'done') {
      throw new Error('root task is not complete');
    }
    if (terminal !== 'cancelled') registry.invalidateTrial();
    state.terminal = terminal;
    await persist(input, state);
    const attempts = state.attempts.map(evidenceOf).filter(Boolean) as TrialAttemptEvidence[];
    return {
      terminal,
      rootCompleted: root?.status === 'done',
      descendantsQuiescent: attempts.every(attempt => attempt.quiescent),
      liveCapabilities: registry.liveCount(),
      writer,
    };
  }

  function snapshot(): TreeSnapshot {
    const attempts = state.attempts.map(evidenceOf).filter(Boolean) as TrialAttemptEvidence[];
    return {
      rootTaskId: state.rootTaskId,
      tasks: structuredClone(input.tasks.getAll(input.project)),
      attempts: structuredClone(attempts),
      acceptance: structuredClone(state.acceptance),
      managers: structuredClone(state.managers),
      writer,
      terminal: state.terminal,
    };
  }

  return {
    initializeRoot: initializeRootTask, startAttempt, decompose, wait, actionable,
    finishAttempt, recordVerdict, resumeReadyManagers, completeManager, checkpointManager,
    setParentAnswer, consumeParentAnswer, withWriter, cancel, finalize, snapshot,
    capabilityRegistry: () => registry,
  };
}
