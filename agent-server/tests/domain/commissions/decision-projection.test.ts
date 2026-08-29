// input:  ../../_test-home, vitest, decision-projection with injected deps
// output: projection targeting, line shape, and no-commission no-op tests
// pos:    Commission decisions.jsonl projection contract
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../../_test-home.js';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  projectCommissionDecisions,
  projectCommissionDecisionAction,
  type DecisionProjectionDeps,
} from '../../../src/domain/commissions/decision-projection.js';

function harness(commissionId: string | null): { deps: DecisionProjectionDeps; lines: { file: string; line: string }[] } {
  const lines: { file: string; line: string }[] = [];
  return {
    lines,
    deps: {
      getSession: async () => ({ commissionId }),
      findCommission: async (id) => (id === 'comm-1' ? { projectId: 'proj', slug: 'my-task' } : null),
      resolveFile: (projectId, slug) => `/ctx/${projectId}/commissions/${slug}/decisions.jsonl`,
      appendLine: async (file, line) => { lines.push({ file, line }); },
    },
  };
}

const ITEM = { id: 'd1', title: 't', decision: 'd', context: 'c', reasoning: 'r' };

test('decision lines land in the commission decisions.jsonl with full payload', async () => {
  const h = harness('comm-1');
  const ok = await projectCommissionDecisions({ sessionId: 's1', ts: 'T1', items: [ITEM] }, h.deps);
  assert.equal(ok, true);
  assert.equal(h.lines[0].file, '/ctx/proj/commissions/my-task/decisions.jsonl');
  assert.deepEqual(JSON.parse(h.lines[0].line), { v: 1, kind: 'decision', ts: 'T1', sessionId: 's1', items: [ITEM] });
});

test('action lines record the response; approve carries no message field', async () => {
  const h = harness('comm-1');
  await projectCommissionDecisionAction({ sessionId: 's1', ts: 'T2', decisionId: 'd1', action: 'approve' }, h.deps);
  await projectCommissionDecisionAction({ sessionId: 's1', ts: 'T3', decisionId: 'd1', action: 'revise', message: 'no' }, h.deps);
  const rows = h.lines.map(l => JSON.parse(l.line));
  assert.equal(rows[0].message, undefined);
  assert.deepEqual(rows[1], { v: 1, kind: 'action', ts: 'T3', sessionId: 's1', decisionId: 'd1', action: 'revise', message: 'no' });
});

test('sessions without a commission (or with a dangling id) are silent no-ops', async () => {
  const none = harness(null);
  assert.equal(await projectCommissionDecisions({ sessionId: 's1', ts: 'T', items: [ITEM] }, none.deps), false);
  const dangling = harness('comm-gone');
  assert.equal(await projectCommissionDecisions({ sessionId: 's1', ts: 'T', items: [ITEM] }, dangling.deps), false);
  assert.equal(none.lines.length + dangling.lines.length, 0);
});
