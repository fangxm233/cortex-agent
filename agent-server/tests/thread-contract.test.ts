// input:  Node test runner + domain/threads/contract
// output: buildContractPrompt / buildMissionChain / checkContractBudget tests
// pos:    Verify structured delegation contracts and budget circuit breaker (DR-0014 Phase 3)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildContractPrompt,
  buildMissionChain,
  checkContractBudget,
} from '../src/domain/threads/contract.js';
import type { ThreadRecord, ThreadContract } from '../src/core/types/thread-types.js';

function fakeThread(over: Partial<ThreadRecord> = {}): ThreadRecord {
  const now = new Date().toISOString();
  return {
    id: 'thr_contract_fake',
    templateName: null,
    status: 'running',
    channel: 'C',
    projectId: 'general',
    platformThreadId: null,
    userMessage: 'investigate the flaky integration test in CI and find the root cause',
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
}

// --- buildContractPrompt ---

test('buildContractPrompt with no contract and no mission chain returns the message unchanged', () => {
  const out = buildContractPrompt({ message: 'just do the thing', contract: null, missionChain: [] });
  assert.equal(out, 'just do the thing');
});

test('buildContractPrompt renders all contract sections in order', () => {
  const contract: ThreadContract = {
    goal: 'find root cause of flaky test',
    doneWhen: 'root cause documented in report.md with reproduction steps',
    contextFiles: ['/proj/STATUS.md', '/proj/tests/flaky.test.ts'],
    deliverablePath: '/proj/report.md',
    budgetUsd: 2.5,
  };
  const out = buildContractPrompt({
    message: 'see details above',
    contract,
    missionChain: ['ship v2 of the pipeline', 'stabilize CI'],
  });

  const idx = (s: string) => out.indexOf(s);
  assert.ok(idx('## Mission Chain') >= 0);
  assert.ok(idx('1. ship v2 of the pipeline') >= 0);
  assert.ok(idx('2. stabilize CI') >= 0);
  assert.ok(idx('## Goal') > idx('## Mission Chain'));
  assert.ok(idx('find root cause of flaky test') > 0);
  assert.ok(idx('## Done When') > idx('## Goal'));
  assert.ok(idx('## Context') > idx('## Done When'));
  assert.ok(idx('/proj/STATUS.md') > 0 && idx('/proj/tests/flaky.test.ts') > 0);
  assert.ok(idx('## Deliverable') > idx('## Context'));
  assert.ok(idx('/proj/report.md') > 0);
  assert.ok(idx('## Budget') > idx('## Deliverable'));
  assert.ok(idx('$2.50') > 0);
  assert.ok(out.trimEnd().endsWith('see details above'), 'original message comes last');
});

test('buildContractPrompt omits sections for absent fields', () => {
  const out = buildContractPrompt({
    message: 'msg',
    contract: { goal: 'only a goal' },
    missionChain: [],
  });
  assert.ok(out.includes('## Goal'));
  assert.equal(out.includes('## Mission Chain'), false);
  assert.equal(out.includes('## Done When'), false);
  assert.equal(out.includes('## Context'), false);
  assert.equal(out.includes('## Deliverable'), false);
  assert.equal(out.includes('## Budget'), false);
});

// --- buildMissionChain ---

test('buildMissionChain returns [] without a parent', () => {
  assert.deepEqual(buildMissionChain(null), []);
});

test('buildMissionChain appends the parent goal to the parent chain (root-first)', () => {
  const parent = fakeThread({
    metadata: {
      missionChain: ['root mission'],
      contract: { goal: 'parent goal' },
    },
  });
  assert.deepEqual(buildMissionChain(parent), ['root mission', 'parent goal']);
});

test('buildMissionChain falls back to truncated userMessage when parent has no contract', () => {
  const longMsg = 'x'.repeat(300);
  const parent = fakeThread({ userMessage: longMsg, metadata: null });
  const chain = buildMissionChain(parent);
  assert.equal(chain.length, 1);
  assert.ok(chain[0].length <= 121);
  assert.ok(chain[0].startsWith('xxx'));
});

test('buildMissionChain truncates each entry to keep deep-tree prompts bounded', () => {
  const parent = fakeThread({
    metadata: {
      missionChain: ['a'.repeat(500)],
      contract: { goal: 'b'.repeat(500) },
    },
  });
  const chain = buildMissionChain(parent);
  for (const entry of chain) assert.ok(entry.length <= 121, `entry too long: ${entry.length}`);
});

// --- checkContractBudget ---

test('checkContractBudget passes when no contract or no budget', () => {
  assert.equal(checkContractBudget(fakeThread()), false);
  assert.equal(checkContractBudget(fakeThread({ metadata: { contract: { goal: 'g' } } })), false);
});

test('checkContractBudget trips when totalCostUsd reaches the contract budget', () => {
  const t = fakeThread({ totalCostUsd: 2.5, metadata: { contract: { goal: 'g', budgetUsd: 2.5 } } });
  assert.equal(checkContractBudget(t), true);
  const under = fakeThread({ totalCostUsd: 2.49, metadata: { contract: { goal: 'g', budgetUsd: 2.5 } } });
  assert.equal(checkContractBudget(under), false);
});
