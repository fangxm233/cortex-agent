import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  projectBoardDecisions,
  projectBoardDecisionAction,
  type DecisionProjectionDeps,
} from '../../../src/domain/boards/decision-projection.js';

function harness(boardId: string | null): { deps: DecisionProjectionDeps; lines: { file: string; line: string }[] } {
  const lines: { file: string; line: string }[] = [];
  return {
    lines,
    deps: {
      getSession: async () => ({ boardId }),
      findBoard: async (id) => (id === 'b-1' ? { projectId: 'proj', slug: 'my-task' } : null),
      resolveFile: (projectId, slug) => `/ctx/${projectId}/boards/${slug}/decisions.jsonl`,
      appendLine: async (file, line) => { lines.push({ file, line }); },
    },
  };
}

const ITEM = { id: 'd1', title: 't', decision: 'd', context: 'c', reasoning: 'r' };

test('decision lines land in the board decisions.jsonl with full payload', async () => {
  const h = harness('b-1');
  const ok = await projectBoardDecisions({ sessionId: 's1', ts: 'T1', items: [ITEM] }, h.deps);
  assert.equal(ok, true);
  assert.equal(h.lines[0].file, '/ctx/proj/boards/my-task/decisions.jsonl');
  assert.deepEqual(JSON.parse(h.lines[0].line), { v: 1, kind: 'decision', ts: 'T1', sessionId: 's1', items: [ITEM] });
});

test('action lines record the response; approve carries no message field', async () => {
  const h = harness('b-1');
  await projectBoardDecisionAction({ sessionId: 's1', ts: 'T2', decisionId: 'd1', action: 'approve' }, h.deps);
  await projectBoardDecisionAction({ sessionId: 's1', ts: 'T3', decisionId: 'd1', action: 'revise', message: 'no' }, h.deps);
  const rows = h.lines.map(l => JSON.parse(l.line));
  assert.equal(rows[0].message, undefined);
  assert.deepEqual(rows[1], { v: 1, kind: 'action', ts: 'T3', sessionId: 's1', decisionId: 'd1', action: 'revise', message: 'no' });
});

test('sessions without a board (or with a dangling id) are silent no-ops', async () => {
  const none = harness(null);
  assert.equal(await projectBoardDecisions({ sessionId: 's1', ts: 'T', items: [ITEM] }, none.deps), false);
  const dangling = harness('b-gone');
  assert.equal(await projectBoardDecisions({ sessionId: 's1', ts: 'T', items: [ITEM] }, dangling.deps), false);
  assert.equal(none.lines.length + dangling.lines.length, 0);
});

test('the board refresh hint goes to the bus it was handed, after the line lands', async () => {
  const h = harness('b-1');
  const published: unknown[] = [];
  await projectBoardDecisions({ sessionId: 's1', ts: 'T', items: [ITEM] }, { ...h.deps, bus: { publish: (e: any) => { published.push(e); } } });
  assert.deepEqual(published, [{ type: 'board.updated', boardId: 'b-1', projectId: 'proj' }]);
});

test('the default append creates the board directory when it is missing', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-board-proj-'));
  t.onTestFinished(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'boards', 'my-task', 'decisions.jsonl');
  const ok = await projectBoardDecisions({ sessionId: 's1', ts: 'T', items: [ITEM] }, {
    getSession: async () => ({ boardId: 'b-1' }),
    findBoard: async () => ({ projectId: 'proj', slug: 'my-task' }),
    resolveFile: () => file,
  });
  assert.equal(ok, true);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
});
