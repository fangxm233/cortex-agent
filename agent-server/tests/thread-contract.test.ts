import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildContractPrompt,
  buildMissionChain,
  checkContractBudget,
} from '../src/domain/threads/contract.js';
import type { ThreadRecord } from '../src/core/types/thread-types.js';

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
