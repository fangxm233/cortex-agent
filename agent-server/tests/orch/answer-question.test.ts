import { test } from 'vitest';
import assert from 'node:assert/strict';
import { answerQuestion } from '../../src/orchestration/interactions/answer-question.js';

function makeDeps(opts: { status?: string; group?: any; hook?: boolean; raw?: boolean } = {}) {
  const resolved: any[] = [];
  const hookCalls: any[] = [];
  return {
    resolved,
    hookCalls,
    deps: {
      interactionRecords: {
        get: () => (opts.status ? { status: opts.status } as any : null),
        resolve: async (args: any) => { resolved.push(args); return 'resolved' as const; },
      },
      getGroup: () => opts.group ?? null,
      tryResolveHook: (group: any) => { hookCalls.push(group); return opts.hook ?? true; },
      resolveRequest: () => opts.raw ?? false,
    },
  };
}

function group() {
  return {
    questions: [{ question: 'Which?', header: 'Pick', pendingId: 'p0' }],
    answers: new Map(),
  };
}

test('answers fill the group, resolve the hook and record who answered', () => {
  const g = group();
  const { deps, resolved, hookCalls } = makeDeps({ status: 'pending', group: g });
  assert.equal(answerQuestion('req-1', { 'Which?': 'A' }, 'agent', deps), 'resolved');
  assert.deepEqual(g.answers.get('p0'), { header: 'Pick', value: 'A' });
  assert.equal(hookCalls.length, 1);
  assert.equal(resolved[0].resolvedVia, 'agent');
  assert.deepEqual(resolved[0].result, { answers: { 'Which?': 'A' } });
});

test('a record that is no longer pending is already resolved', () => {
  const { deps, resolved } = makeDeps({ status: 'answered', group: group() });
  assert.equal(answerQuestion('req-1', { 'Which?': 'A' }, 'web', deps), 'already-resolved');
  assert.equal(resolved.length, 0);
});

test('without a group the raw hook request is unblocked, or reported missing', () => {
  const ok = makeDeps({ raw: true });
  assert.equal(answerQuestion('req-2', { q: 'a' }, 'web', ok.deps), 'resolved');
  assert.equal(ok.resolved[0].resolvedVia, 'web');
  const missing = makeDeps({ raw: false });
  assert.equal(answerQuestion('req-3', { q: 'a' }, 'web', missing.deps), 'not-found');
});

test('a group the hook cannot resolve reports not-found and seals nothing', () => {
  const { deps, resolved } = makeDeps({ status: 'pending', group: group(), hook: false });
  assert.equal(answerQuestion('req-4', { 'Which?': 'A' }, 'web', deps), 'not-found');
  assert.equal(resolved.length, 0);
});
