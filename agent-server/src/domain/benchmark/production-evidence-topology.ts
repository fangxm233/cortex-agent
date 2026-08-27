// input:  frozen attempt linkage and production topology facts
// output: validated durable v2 edges and attempt dispositions
// pos:    Production evidence topology projector
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ProductionAttemptIdentityRecord } from '../agent-run/production-attempt-identity.js';
import type { ProductionTopologyFact } from '../tasks/production-topology-ledger.js';
import type { AttemptDisposition, AttemptEdge } from './attempt-record.js';
import type { OrchestrationModeName } from './composite-manifest.js';

export interface ProductionTopologyAttempt {
  readonly identity: ProductionAttemptIdentityRecord;
  readonly parentTaskId: string | null;
  readonly taskDependencies: readonly string[];
}

export interface ProductionTopologyProjection {
  readonly edges: readonly AttemptEdge[];
  readonly dispositions: ReadonlyMap<string, AttemptDisposition>;
}

function fail(detail: string): never {
  throw new Error(`production evidence topology invalid: ${detail}`);
}

function factTouchesTrial(
  fact: ProductionTopologyFact, attempts: readonly ProductionTopologyAttempt[],
): boolean {
  const threads = new Set(attempts.map(item => item.identity.thread_id));
  const tasks = new Set(attempts.map(item => item.identity.task_id));
  const values = Object.entries(fact).filter(([key]) => (
    key === 'thread_id' || key === 'task_id'
      || key.endsWith('_thread_id') || key.endsWith('_task_id')
  )).map(([, value]) => value);
  return values.some(value => typeof value === 'string' && (threads.has(value) || tasks.has(value)));
}

function latestAttemptAt(
  attempts: readonly ProductionTopologyAttempt[], threadId: string, occurredAt: string,
): ProductionTopologyAttempt {
  const matches = attempts.filter(item => item.identity.thread_id === threadId
    && item.identity.frozen_at <= occurredAt)
    .sort((left, right) => right.identity.frozen_at.localeCompare(left.identity.frozen_at));
  if (matches.length === 0) fail(`thread ${threadId} has no preceding attempt`);
  if (matches[1]?.identity.frozen_at === matches[0].identity.frozen_at) {
    fail(`thread ${threadId} has ambiguous preceding attempts`);
  }
  return matches[0];
}

function dispatchAttempts(
  attempts: readonly ProductionTopologyAttempt[], threadId: string, generation: string,
): ProductionTopologyAttempt[] {
  const matches = attempts.filter(item => item.identity.thread_id === threadId
    && item.identity.dispatch_generation === generation);
  if (matches.length === 0) fail(`dispatch ${threadId}/${generation} has no attempts`);
  return matches;
}

function dispatchWasAttempted(
  attempts: readonly ProductionTopologyAttempt[], threadId: string, generation: string,
): boolean {
  return attempts.some(item => item.identity.thread_id === threadId
    && item.identity.dispatch_generation === generation);
}

function dispatchBoundary(
  attempts: readonly ProductionTopologyAttempt[], threadId: string, generation: string,
  boundary: 'first' | 'last',
): ProductionTopologyAttempt {
  const matches = dispatchAttempts(attempts, threadId, generation);
  const candidates = matches.filter(item => boundary === 'first'
    ? !matches.some(other => other.identity.attempt_id === item.identity.spawn_parent_attempt_id)
    : !matches.some(other => other.identity.spawn_parent_attempt_id === item.identity.attempt_id));
  if (candidates.length !== 1) fail(`dispatch ${threadId}/${generation} ${boundary} is ambiguous`);
  return candidates[0];
}

function assertTask(
  attempt: ProductionTopologyAttempt, taskId: string, label: string,
): ProductionTopologyAttempt {
  if (attempt.identity.task_id !== taskId) {
    fail(`${label} task ${taskId} mismatches attempt ${attempt.identity.attempt_id}`);
  }
  return attempt;
}

function simpleEdge(
  fact: ProductionTopologyFact, attempts: readonly ProductionTopologyAttempt[],
): AttemptEdge | null {
  if (fact.kind === 'decompose') {
    const actor = assertTask(
      latestAttemptAt(attempts, fact.actor_thread_id, fact.occurred_at),
      fact.parent_task_id, 'decompose parent',
    );
    return {
      kind: fact.kind, from: { ref: 'attempt', id: actor.identity.attempt_id },
      to: { ref: 'task', id: fact.child_task_id },
    };
  }
  if (fact.kind === 'depends_on') return {
    kind: fact.kind, from: { ref: 'task', id: fact.task_id },
    to: { ref: 'task', id: fact.dependency_task_id },
  };
  if (fact.kind === 'dispatch') {
    const target = assertTask(dispatchBoundary(
      attempts, fact.thread_id, fact.dispatch_generation, 'first',
    ), fact.task_id, 'dispatch');
    return {
      kind: fact.kind, from: { ref: 'task', id: fact.task_id },
      to: { ref: 'attempt', id: target.identity.attempt_id },
    };
  }
  return null;
}

function deliveryEdge(
  fact: Extract<ProductionTopologyFact, { kind: 'delivery' }>,
  attempts: readonly ProductionTopologyAttempt[],
): AttemptEdge {
  const child = assertTask(dispatchBoundary(
    attempts, fact.child_thread_id, fact.child_dispatch_generation, 'last',
  ), fact.child_task_id, 'delivery child');
  const parent = assertTask(
    latestAttemptAt(attempts, fact.parent_thread_id, fact.occurred_at),
    fact.parent_task_id, 'delivery parent',
  );
  return {
    kind: fact.kind, from: { ref: 'outcome', id: child.identity.attempt_id },
    to: { ref: 'attempt', id: parent.identity.attempt_id },
  };
}

function verdictEdge(
  fact: Extract<ProductionTopologyFact, { kind: 'verdict' }>,
  attempts: readonly ProductionTopologyAttempt[],
): AttemptEdge {
  const manager = assertTask(
    latestAttemptAt(attempts, fact.manager_thread_id, fact.occurred_at),
    fact.parent_task_id, 'verdict parent',
  );
  const child = assertTask(dispatchBoundary(
    attempts, fact.child_thread_id, fact.child_dispatch_generation, 'last',
  ), fact.child_task_id, 'verdict child');
  return {
    kind: fact.kind, from: { ref: 'attempt', id: manager.identity.attempt_id },
    to: { ref: 'attempt', id: child.identity.attempt_id },
  };
}

function reworkEdge(
  fact: Extract<ProductionTopologyFact, { kind: 'rework' }>,
  attempts: readonly ProductionTopologyAttempt[],
): AttemptEdge {
  const rejected = assertTask(dispatchBoundary(
    attempts, fact.rejected_thread_id, fact.rejected_dispatch_generation, 'last',
  ), fact.task_id, 'rework rejected');
  const replacement = assertTask(dispatchBoundary(
    attempts, fact.replacement_thread_id, fact.replacement_dispatch_generation, 'first',
  ), fact.task_id, 'rework replacement');
  return {
    kind: fact.kind, from: { ref: 'attempt', id: rejected.identity.attempt_id },
    to: { ref: 'attempt', id: replacement.identity.attempt_id },
  };
}

function qaEdge(
  fact: Extract<ProductionTopologyFact, { kind: 'question' | 'answer' }>,
  attempts: readonly ProductionTopologyAttempt[],
): AttemptEdge | null {
  if (!fact.projectable) return null;
  const fromThread = fact.kind === 'question' ? fact.asker_thread_id : fact.answerer_thread_id;
  const toThread = fact.kind === 'question' ? fact.manager_thread_id : fact.asker_thread_id;
  if (!fromThread || !toThread) fail(`${fact.kind} ${fact.question_id} lacks an endpoint`);
  return {
    kind: fact.kind,
    from: { ref: 'attempt', id: latestAttemptAt(
      attempts, fromThread, fact.occurred_at,
    ).identity.attempt_id },
    to: { ref: 'attempt', id: latestAttemptAt(
      attempts, toThread, fact.occurred_at,
    ).identity.attempt_id },
  };
}

function projectFact(
  fact: ProductionTopologyFact, attempts: readonly ProductionTopologyAttempt[],
): AttemptEdge | null {
  // A task can be dispatched more than once -- the first thread is cut off and the task goes out
  // again -- and the last dispatch of a trial that ends mid-flight may have no attempt at all,
  // because the thread never got as far as freezing one. The edge is `task -> attempt`, so there is
  // no edge to draw: an absent endpoint, not a broken graph. Refusing cost five terminal-bench
  // manager trials their score on 2026-08-27, the export refusal aborting each trial before the
  // verifier ran. The fact stays in the collected topology ledger, so the dispatch is still on the
  // record; only its projection is missing, as it must be. Guarded here rather than inside
  // `simpleEdge`, whose `null` already means "not one of my kinds".
  if (fact.kind === 'dispatch'
    && !dispatchWasAttempted(attempts, fact.thread_id, fact.dispatch_generation)) return null;
  const simple = simpleEdge(fact, attempts);
  if (simple) return simple;
  if (fact.kind === 'delivery') return deliveryEdge(fact, attempts);
  if (fact.kind === 'verdict') return verdictEdge(fact, attempts);
  if (fact.kind === 'rework') return reworkEdge(fact, attempts);
  if (fact.kind === 'question' || fact.kind === 'answer') return qaEdge(fact, attempts);
  if (fact.kind === 'spawn') return null;
  return fail(`unsupported kind ${(fact as ProductionTopologyFact).kind}`);
}

function taskDispatchGroups(attempts: readonly ProductionTopologyAttempt[]) {
  const groups = new Map<string, ProductionTopologyAttempt[]>();
  for (const attempt of attempts.filter(item => item.parentTaskId !== null)) {
    const identity = attempt.identity;
    if (!identity.dispatch_generation) fail(`task attempt ${identity.attempt_id} lacks generation`);
    const key = `${identity.task_id}\0${identity.thread_id}\0${identity.dispatch_generation}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(attempt);
    groups.set(key, bucket);
  }
  return groups;
}

function factsForGroup(
  facts: readonly ProductionTopologyFact[], group: readonly ProductionTopologyAttempt[],
): ProductionTopologyFact[] {
  const identity = group[0].identity;
  return facts.filter(fact => {
    if (fact.kind === 'dispatch') {
      return fact.thread_id === identity.thread_id
        && fact.dispatch_generation === identity.dispatch_generation;
    }
    if (fact.kind === 'delivery' || fact.kind === 'verdict') {
      return fact.child_thread_id === identity.thread_id
        && fact.child_dispatch_generation === identity.dispatch_generation;
    }
    return false;
  });
}

function assertReworkLinks(
  facts: readonly ProductionTopologyFact[], groups: readonly ProductionTopologyAttempt[][],
): void {
  const ordered = [...groups].sort((left, right) => (
    left[0].identity.frozen_at.localeCompare(right[0].identity.frozen_at)
  ));
  for (const replacement of ordered.slice(1)) {
    const identity = replacement[0].identity;
    const links = facts.filter(fact => fact.kind === 'rework'
      && fact.task_id === identity.task_id
      && fact.replacement_thread_id === identity.thread_id
      && fact.replacement_dispatch_generation === identity.dispatch_generation);
    if (links.length !== 1) fail(`task ${identity.task_id} replacement has ${links.length} rework facts`);
  }
}

function assertManagerGroups(
  facts: readonly ProductionTopologyFact[], attempts: readonly ProductionTopologyAttempt[],
): void {
  const groups = taskDispatchGroups(attempts);
  const childTasks = new Set([...groups.values()].map(group => group[0].identity.task_id));
  for (const taskId of childTasks) {
    const taskGroups = [...groups.values()].filter(group => group[0].identity.task_id === taskId);
    const parent = taskGroups[0][0].parentTaskId;
    const decompositions = facts.filter(fact => fact.kind === 'decompose'
      && fact.child_task_id === taskId && fact.parent_task_id === parent);
    if (decompositions.length !== 1) fail(`task ${taskId} has ${decompositions.length} decompose facts`);
    assertReworkLinks(facts, taskGroups);
  }
  for (const group of groups.values()) {
    const lifecycle = factsForGroup(facts, group);
    for (const kind of ['dispatch', 'delivery', 'verdict'] as const) {
      const count = lifecycle.filter(fact => fact.kind === kind).length;
      if (count !== 1) fail(`${group[0].identity.task_id} ${kind} count is ${count}`);
    }
  }
}

function assertDependsOn(
  facts: readonly ProductionTopologyFact[], attempts: readonly ProductionTopologyAttempt[],
): void {
  const byTask = new Map<string, readonly string[]>();
  attempts.forEach(item => byTask.set(item.identity.task_id, item.taskDependencies));
  for (const [taskId, expected] of byTask) {
    const actual = facts.filter(fact => fact.kind === 'depends_on' && fact.task_id === taskId)
      .map(fact => fact.kind === 'depends_on' ? fact.dependency_task_id : '').sort();
    if ([...expected].sort().join('\0') !== actual.join('\0')) {
      fail(`task ${taskId} dependency topology mismatches durable task state`);
    }
  }
}

function assertQa(
  managerQa: 'on' | 'off', facts: readonly ProductionTopologyFact[],
): void {
  const qa = facts.filter((fact): fact is Extract<ProductionTopologyFact, {
    kind: 'question' | 'answer'
  }> => (fact.kind === 'question' || fact.kind === 'answer') && fact.projectable);
  if (managerQa === 'off' && qa.length > 0) fail('manager Q&A-off topology is not empty');
  if (managerQa === 'off') return;
  const questions = qa.filter(fact => fact.kind === 'question').map(fact => fact.question_id).sort();
  const answers = qa.filter(fact => fact.kind === 'answer').map(fact => fact.question_id).sort();
  if (questions.join('\0') !== answers.join('\0') || new Set(questions).size !== questions.length) {
    fail('manager Q&A topology is unpaired');
  }
}

function spawnEdges(attempts: readonly ProductionTopologyAttempt[]): AttemptEdge[] {
  return attempts.flatMap((item): AttemptEdge[] => item.identity.spawn_parent_attempt_id ? [{
    kind: 'spawn',
    from: { ref: 'attempt', id: item.identity.spawn_parent_attempt_id },
    to: { ref: 'attempt', id: item.identity.attempt_id },
  }] : []);
}

function dispositions(
  facts: readonly ProductionTopologyFact[], attempts: readonly ProductionTopologyAttempt[],
): ReadonlyMap<string, AttemptDisposition> {
  const result = new Map<string, AttemptDisposition>();
  for (const fact of facts) {
    if (fact.kind === 'verdict') {
      const attempt = dispatchBoundary(
        attempts, fact.child_thread_id, fact.child_dispatch_generation, 'last',
      );
      result.set(attempt.identity.attempt_id, fact.verdict);
    }
    if (fact.kind === 'rework') {
      const attempt = dispatchBoundary(
        attempts, fact.rejected_thread_id, fact.rejected_dispatch_generation, 'last',
      );
      result.set(attempt.identity.attempt_id, 'superseded');
    }
  }
  return result;
}

export function projectProductionEvidenceTopology(
  mode: OrchestrationModeName, managerQa: 'on' | 'off' | null,
  allFacts: readonly ProductionTopologyFact[], attempts: readonly ProductionTopologyAttempt[],
): ProductionTopologyProjection {
  const facts = allFacts.filter(fact => factTouchesTrial(fact, attempts));
  if (mode === 'manager') {
    if (!managerQa) fail('manager Q&A mode is missing');
    assertManagerGroups(facts, attempts);
    assertDependsOn(facts, attempts);
    assertQa(managerQa, facts);
  }
  const edges = spawnEdges(attempts);
  for (const fact of facts) {
    const edge = projectFact(fact, attempts);
    if (edge) edges.push(edge);
  }
  const keys = edges.map(edge => JSON.stringify(edge));
  if (new Set(keys).size !== keys.length) fail('duplicate durable edge');
  return { edges, dispositions: dispositions(facts, attempts) };
}
