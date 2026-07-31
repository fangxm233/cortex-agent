// input:  thread DTO fixtures and shared grouping model
// output: active and history section regressions
// pos:    Thread grouping model unit tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { ThreadInfo } from '@cortex-agent/ui-contract';
import { groupThreads, threadScopeFilter } from './scope';

function thread(id: string, status: ThreadInfo['status']): ThreadInfo {
  return {
    id,
    templateName: 'coder-review',
    currentStep: null,
    status,
    projectId: 'nimbus',
    createdAt: '2026-07-30T15:00:00.000Z',
    updatedAt: '2026-07-30T16:00:00.000Z',
    totalSteps: 2,
    artifactPath: null,
  };
}

describe('threadScopeFilter', () => {
  it('returns active statuses for non-list consumers', () => {
    expect(threadScopeFilter('active')).toEqual(['running', 'waiting']);
  });
});

describe('groupThreads', () => {
  it('groups running and waiting as active, with terminal threads in history', () => {
    const groups = groupThreads([
      thread('done', 'completed'),
      thread('run', 'running'),
      thread('failed', 'failed'),
      thread('wait', 'waiting'),
      thread('cancelled', 'cancelled'),
      thread('aborted', 'aborted'),
    ]);

    expect(groups.map((group) => ({
      kind: group.kind,
      ids: group.threads.map((item) => item.id),
    }))).toEqual([
      { kind: 'active', ids: ['run', 'wait'] },
      { kind: 'history', ids: ['done', 'failed', 'cancelled', 'aborted'] },
    ]);
  });

  it('omits empty sections', () => {
    expect(groupThreads([thread('done', 'completed')]).map((group) => group.kind)).toEqual(['history']);
    expect(groupThreads([])).toEqual([]);
  });
});
