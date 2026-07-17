// input:  Node test runner + domain/threads/tree
// output: getRootThreadId / getTreeThreads / summarizeTree / checkSpawnGuards / buildThreadTree tests
// pos:    Verify recursive thread-tree infrastructure (DR-0014)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { threadStore } from '../src/store/thread-repo.js';
import {
  getRootThreadId,
  getTreeThreads,
  summarizeTree,
  checkSpawnGuards,
  buildThreadTree,
  registerChildSpawn,
} from '../src/domain/threads/tree.js';
import type { ThreadRecord, ThreadMetadata, ThreadStatus } from '../src/core/types/thread-types.js';

const createdThreadIds = new Set<string>();
let seq = 0;

afterAll(async () => {
  for (const id of createdThreadIds) await threadStore.delete(id);
  await threadStore.flush();
});

function makeThread(over: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = over.id ?? `thr_tree${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const rec: ThreadRecord = {
    id,
    templateName: null,
    status: 'running' as ThreadStatus,
    channel: 'C-tree-test',
    projectId: 'general',
    platformThreadId: null,
    userMessage: 'x',
    userMessageTs: 'ts',
    workspacePath: '',
    artifactPath: '',
    agents: {},
    activeAgent: 'main',
    activeStage: null,
    currentStepIndex: 0,
    steps: [],
    iterationCounts: {},
    totalCostUsd: 0,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    error: null,
    abortReason: null,
    metadata: null,
    ...over,
  };
  threadStore.set(rec);
  createdThreadIds.add(id);
  return rec;
}

function meta(m: Partial<ThreadMetadata>): ThreadMetadata {
  return { trigger: 'mcp-thread', ...m };
}

/** Build a root + child + grandchild chain wired with rootThreadId/parentThreadId/childThreadIds. */
function makeChain(costs: [number, number, number] = [0, 0, 0]): { root: ThreadRecord; child: ThreadRecord; grandchild: ThreadRecord } {
  const root = makeThread({ totalCostUsd: costs[0] });
  const child = makeThread({
    totalCostUsd: costs[1],
    metadata: meta({ parentThreadId: root.id, rootThreadId: root.id, depth: 1 }),
  });
  const grandchild = makeThread({
    totalCostUsd: costs[2],
    metadata: meta({ parentThreadId: child.id, rootThreadId: root.id, depth: 2 }),
  });
  root.metadata = meta({ childThreadIds: [child.id] });
  threadStore.set(root);
  child.metadata!.childThreadIds = [grandchild.id];
  threadStore.set(child);
  return { root, child, grandchild };
}

// --- getRootThreadId ---

test('getRootThreadId falls back to the thread own id when no rootThreadId metadata', () => {
  const t = makeThread();
  assert.equal(getRootThreadId(t), t.id);
});

test('getRootThreadId returns metadata.rootThreadId when set', () => {
  const { root, grandchild } = makeChain();
  assert.equal(getRootThreadId(grandchild), root.id);
});

// --- getTreeThreads / summarizeTree ---

test('getTreeThreads returns root and all descendants, excluding unrelated threads', () => {
  const { root, child, grandchild } = makeChain();
  const unrelated = makeThread();
  const tree = getTreeThreads(root.id);
  const ids = new Set(tree.map(t => t.id));
  assert.ok(ids.has(root.id) && ids.has(child.id) && ids.has(grandchild.id));
  assert.equal(ids.has(unrelated.id), false);
  assert.equal(tree.length, 3);
});

test('summarizeTree aggregates node count, cost, and status histogram', async () => {
  const { root, child } = makeChain([1, 0.5, 0.25]);
  await threadStore.mutate(child.id, (t) => { t.status = 'completed'; });
  const s = summarizeTree(root.id);
  assert.equal(s.nodeCount, 3);
  assert.ok(Math.abs(s.totalCostUsd - 1.75) < 1e-9);
  assert.equal(s.byStatus['completed'], 1);
  assert.equal(s.byStatus['running'], 2);
});

// --- checkSpawnGuards ---

function withEnv(key: string, value: string, fn: () => void): void {
  const prev = process.env[key];
  process.env[key] = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('checkSpawnGuards allows spawn with no parent (top-level)', () => {
  assert.deepEqual(checkSpawnGuards(null), { ok: true });
});

test('checkSpawnGuards allows spawn under generous limits', () => {
  const { child } = makeChain();
  const res = checkSpawnGuards(child);
  assert.equal(res.ok, true);
});

test('checkSpawnGuards rejects when parent reached max children (width cap)', () => {
  withEnv('CORTEX_THREAD_MAX_CHILDREN', '2', () => {
    const parent = makeThread({ metadata: meta({ childThreadIds: ['thr_a', 'thr_b'] }) });
    const res = checkSpawnGuards(parent);
    assert.equal(res.ok, false);
    assert.match((res as { ok: false; reason: string }).reason, /children/i);
  });
});

test('checkSpawnGuards rejects when tree reached max node count', () => {
  withEnv('CORTEX_TREE_MAX_NODES', '3', () => {
    const { grandchild } = makeChain();
    const res = checkSpawnGuards(grandchild);
    assert.equal(res.ok, false);
    assert.match((res as { ok: false; reason: string }).reason, /nodes/i);
  });
});

test('checkSpawnGuards rejects when an ancestor contract budget is exhausted by its subtree cost', () => {
  const { root, grandchild } = makeChain([0.6, 0.5, 0.1]);
  root.metadata!.contract = { goal: 'g', budgetUsd: 1 };
  threadStore.set(root);
  // subtree cost of root = 0.6 + 0.5 + 0.1 = 1.2 >= 1
  const res = checkSpawnGuards(grandchild);
  assert.equal(res.ok, false);
  assert.match((res as { ok: false; reason: string }).reason, /budget/i);
});

test('checkSpawnGuards rejects when global tree cost limit is hit', () => {
  withEnv('CORTEX_TREE_MAX_COST_USD', '0.5', () => {
    const { child } = makeChain([0.4, 0.2, 0]);
    const res = checkSpawnGuards(child);
    assert.equal(res.ok, false);
    assert.match((res as { ok: false; reason: string }).reason, /cost/i);
  });
});

// --- buildThreadTree ---

test('buildThreadTree nests children under parents and computes root rollup', async () => {
  const { root, child, grandchild } = makeChain([1, 2, 4]);
  await threadStore.mutate(grandchild.id, (t) => { t.status = 'completed'; });
  const nodes = buildThreadTree(getTreeThreads(root.id));
  assert.equal(nodes.length, 1);
  const rootNode = nodes[0];
  assert.equal(rootNode.threadId, root.id);
  assert.equal(rootNode.children.length, 1);
  assert.equal(rootNode.children[0].threadId, child.id);
  assert.equal(rootNode.children[0].children[0].threadId, grandchild.id);
  assert.equal(rootNode.children[0].children[0].depth, 2);
  assert.ok(rootNode.rollup);
  assert.equal(rootNode.rollup!.nodeCount, 3);
  assert.ok(Math.abs(rootNode.rollup!.totalCostUsd - 7) < 1e-9);
  assert.equal(rootNode.rollup!.maxDepth, 2);
  assert.equal(rootNode.rollup!.byStatus['completed'], 1);
});

// --- registerChildSpawn ---

test('registerChildSpawn appends to childThreadIds and (when wait) to waitingOn', async () => {
  const parent = makeThread();
  await registerChildSpawn(parent.id, 'thr_kid1', true);
  await registerChildSpawn(parent.id, 'thr_kid2', false);
  const p = threadStore.get(parent.id)!;
  assert.deepEqual(p.metadata!.childThreadIds, ['thr_kid1', 'thr_kid2']);
  assert.deepEqual(p.metadata!.waitingOn, ['thr_kid1']);
});

test('buildThreadTree treats nodes whose parent is outside the set as roots', () => {
  const orphan = makeThread({ metadata: meta({ parentThreadId: 'thr_gone_' + Date.now() }) });
  const nodes = buildThreadTree([orphan]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].threadId, orphan.id);
});
