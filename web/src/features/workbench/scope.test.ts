// input:  thread DTO fixtures and shared scope model
// output: status scope and recent thread regressions
// pos:    Thread scope model unit tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { ThreadInfo } from '@cortex-agent/ui-contract';
import { recentTerminalThreads, threadScopeFilter } from './scope';

const NOW = Date.parse('2026-07-30T17:00:00.000Z');

function thread(overrides: Partial<ThreadInfo> & Pick<ThreadInfo, 'id'>): ThreadInfo {
  return {
    templateName: 'coder-review',
    currentStep: null,
    status: 'completed',
    projectId: 'nimbus',
    createdAt: new Date(NOW - 48 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    totalSteps: 2,
    artifactPath: null,
    ...overrides,
  };
}

describe('threadScopeFilter', () => {
  it('active → live thread statuses only', () => {
    expect(threadScopeFilter('active')).toEqual(['running', 'waiting']);
  });

  it('history and recent → terminal thread statuses only', () => {
    const terminal = ['completed', 'failed', 'cancelled', 'aborted'];
    expect(threadScopeFilter('history')).toEqual(terminal);
    expect(threadScopeFilter('recent')).toEqual(terminal);
  });

  it('returns a fresh array (mutating the result does not leak into the constant)', () => {
    const first = threadScopeFilter('active');
    first.push('mutated');
    expect(threadScopeFilter('active')).toEqual(['running', 'waiting']);
  });
});

describe('recentTerminalThreads', () => {
  it('keeps terminal threads within 24 hours and sorts newest first', () => {
    const result = recentTerminalThreads([
      thread({ id: 'older', status: 'failed', updatedAt: new Date(NOW - 23 * 60 * 60 * 1000).toISOString() }),
      thread({ id: 'newer', updatedAt: new Date(NOW - 15 * 60 * 1000).toISOString() }),
      thread({ id: 'boundary', status: 'cancelled', updatedAt: new Date(NOW - 24 * 60 * 60 * 1000).toISOString() }),
    ], NOW);
    expect(result.map((item) => item.id)).toEqual(['newer', 'older', 'boundary']);
  });

  it('excludes live, stale, future, and invalid timestamps', () => {
    const result = recentTerminalThreads([
      thread({ id: 'live', status: 'running' }),
      thread({ id: 'stale', updatedAt: new Date(NOW - 24 * 60 * 60 * 1000 - 1).toISOString() }),
      thread({ id: 'future', updatedAt: new Date(NOW + 1).toISOString() }),
      thread({ id: 'invalid', updatedAt: 'not-a-date' }),
    ], NOW);
    expect(result).toEqual([]);
  });
});
