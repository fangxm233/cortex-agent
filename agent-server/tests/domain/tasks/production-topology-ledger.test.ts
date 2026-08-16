// input:  Vitest, production topology ledger, real attempt resolver
// output: durable lifecycle and strict manager-Q&A projection tests
// pos:    Proves restart-safe production topology facts and read model
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../../_test-home.js';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  PRODUCTION_TOPOLOGY_SOURCE,
  ProductionTopologyProjectionError,
  projectManagerQaEdges,
  readProductionTopologyFacts,
  recordProductionTopologyFact,
} from '../../../src/domain/tasks/production-topology-ledger.js';

let sequence = 0;
function project(): string {
  return `_test_topology_${++sequence}`;
}

describe('production topology ledger', () => {
  it('retains the correlated manager lifecycle facts needed after current state is overwritten', () => {
    const projectId = project();
    const common = { project: projectId };
    recordProductionTopologyFact({ ...common, kind: 'spawn', parent_thread_id: 'thr_root', child_thread_id: 'thr_mgr' });
    recordProductionTopologyFact({ ...common, kind: 'decompose', actor_thread_id: 'thr_mgr', parent_task_id: 'a001', child_task_id: 'b001' });
    recordProductionTopologyFact({ ...common, kind: 'depends_on', task_id: 'b002', dependency_task_id: 'b001' });
    recordProductionTopologyFact({ ...common, kind: 'dispatch', task_id: 'b001', dispatch_generation: 'gen-1', thread_id: 'thr_child' });
    recordProductionTopologyFact({ ...common, kind: 'delivery', child_task_id: 'b001', child_thread_id: 'thr_child', child_dispatch_generation: 'gen-1', parent_task_id: 'a001', parent_thread_id: 'thr_mgr', outcome: 'completed' });
    recordProductionTopologyFact({ ...common, kind: 'verdict', parent_task_id: 'a001', manager_thread_id: 'thr_mgr', child_task_id: 'b001', child_thread_id: 'thr_child', child_dispatch_generation: 'gen-1', verdict: 'rejected', rework_round: 1 });
    recordProductionTopologyFact({ ...common, kind: 'rework', task_id: 'b001', rejected_thread_id: 'thr_child', rejected_dispatch_generation: 'gen-1', replacement_thread_id: 'thr_child_2', replacement_dispatch_generation: 'gen-2', rework_round: 1 });

    const facts = readProductionTopologyFacts({ project: projectId });
    assert.deepEqual(facts.map((fact) => fact.kind), [
      'spawn', 'decompose', 'depends_on', 'dispatch', 'delivery', 'verdict', 'rework',
    ]);
    assert.equal(new Set(facts.map((fact) => fact.fact_id)).size, facts.length);
    assert.ok(facts.every((fact) => fact.source === PRODUCTION_TOPOLOGY_SOURCE));
  });

  it('Q&A-off has no projected edges and Q&A-on projects only real nested attempts', () => {
    const offProject = project();
    assert.deepEqual(projectManagerQaEdges(
      offProject, new Set(['thr_current']), () => null,
    ).edges, []);

    const onProject = project();
    recordProductionTopologyFact({
      project: onProject, kind: 'question', question_id: 'q_nested',
      asker_thread_id: 'thr_child', asker_task_id: 'c001', manager_thread_id: 'thr_manager',
      origin_channel: null, question: 'Which branch?', projectable: true,
    });
    recordProductionTopologyFact({
      project: onProject, kind: 'answer', question_id: 'q_nested',
      answerer_thread_id: 'thr_manager', answerer_channel: null, asker_thread_id: 'thr_child',
      answer: 'Use branch A.', consumed_at: null, projectable: true,
    });
    const attemptIds = new Map([
      ['thr_child', 'thread-thr_child'], ['thr_manager', 'thread-thr_manager'],
    ]);

    const projection = projectManagerQaEdges(
      onProject, new Set(attemptIds.keys()), (threadId) => attemptIds.get(threadId) ?? null,
    );
    assert.equal(projection.source, PRODUCTION_TOPOLOGY_SOURCE);
    assert.deepEqual(projection.edges, [
      { kind: 'question', from: { ref: 'attempt', id: 'thread-thr_child' }, to: { ref: 'attempt', id: 'thread-thr_manager' } },
      { kind: 'answer', from: { ref: 'attempt', id: 'thread-thr_manager' }, to: { ref: 'attempt', id: 'thread-thr_child' } },
    ]);
  });

  it('keeps top-level origin/human Q&A durable but omits it from attempt edges', () => {
    const projectId = project();
    recordProductionTopologyFact({
      project: projectId, kind: 'question', question_id: 'q_origin',
      asker_thread_id: 'thr_top', asker_task_id: 'a001', manager_thread_id: null,
      origin_channel: 'channel-1', question: 'Need owner intent', projectable: false,
    });
    recordProductionTopologyFact({
      project: projectId, kind: 'answer', question_id: 'q_origin',
      answerer_thread_id: null, answerer_channel: 'channel-1', asker_thread_id: 'thr_top',
      answer: 'Owner answer', consumed_at: null, projectable: false,
    });

    assert.equal(readProductionTopologyFacts({ project: projectId }).length, 2);
    assert.deepEqual(projectManagerQaEdges(
      projectId, new Set(['thr_top']), () => null,
    ).edges, []);
  });

  it('fails closed when a fact claims projectability but an attempt endpoint is unresolved', () => {
    const projectId = project();
    recordProductionTopologyFact({
      project: projectId, kind: 'question', question_id: 'q_bad',
      asker_thread_id: 'thr_child', asker_task_id: 'c001', manager_thread_id: 'thr_missing',
      origin_channel: null, question: 'Question', projectable: true,
    });

    assert.throws(
      () => projectManagerQaEdges(
        projectId, new Set(['thr_child', 'thr_missing']),
        (threadId) => threadId === 'thr_child' ? 'thread-thr_child' : null,
      ),
      ProductionTopologyProjectionError,
    );
  });

  it('scopes Q&A projection to the frozen attempts instead of project history', () => {
    const projectId = project();
    recordProductionTopologyFact({
      project: projectId, kind: 'question', question_id: 'q_old',
      asker_thread_id: 'thr_old_child', asker_task_id: 'c001',
      manager_thread_id: 'thr_old_manager', origin_channel: null,
      question: 'Old run question', projectable: true,
    });

    const projection = projectManagerQaEdges(
      projectId, new Set(['thr_new_root']),
      (threadId) => threadId === 'thr_new_root' ? 'thread-thr_new_root' : null,
    );
    assert.deepEqual(projection.edges, []);
  });
});
