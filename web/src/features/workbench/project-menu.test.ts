// input:  project-scoped session and thread fixtures
// output: running, unread, and action-required count tests
// pos:    Verifies active project attention aggregation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import type { ThreadInfo } from '@cortex-agent/ui-contract';
import {
  runningCountByProject,
  unreadCountByProject,
  awaitingInputCountByProject,
  projectAttentionBadge,
} from './project-menu';

const thread = (projectId: string, status: ThreadInfo['status']): ThreadInfo => ({
  id: 't_' + Math.random().toString(36).slice(2),
  templateName: 'coder-review',
  currentStep: null,
  status,
  projectId,
  createdAt: '2026-07-06T00:00:00Z',
  updatedAt: '2026-07-06T00:00:00Z',
  totalSteps: 1,
  artifactPath: null,
});

describe('runningCountByProject', () => {
  it('counts only running + waiting threads, grouped by projectId', () => {
    const counts = runningCountByProject([
      thread('a', 'running'),
      thread('a', 'waiting'),
      thread('a', 'completed'),
      thread('b', 'running'),
      thread('c', 'failed'),
    ]);
    expect(counts).toEqual({ a: 2, b: 1 });
  });

  it('returns an empty map for no active threads', () => {
    expect(runningCountByProject([thread('a', 'completed')])).toEqual({});
  });
});

describe('project attention counts', () => {
  const s = (projectId: string, unread: boolean, awaitingInput = false) =>
    ({ projectId, unread, awaitingInput }) as never;

  it('counts unread sessions per project', () => {
    expect(
      unreadCountByProject([s('p1', true), s('p1', true), s('p2', false), s('p3', true)]),
    ).toEqual({ p1: 2, p3: 1 });
  });

  it('counts sessions awaiting user input per project', () => {
    expect(
      awaitingInputCountByProject([
        s('p1', false, true),
        s('p1', true, true),
        s('p2', true, false),
        s('p3', false, true),
      ]),
    ).toEqual({ p1: 2, p3: 1 });
  });

  it('combines unread + action counts and lets action win the badge tone', () => {
    expect(projectAttentionBadge(2, 1)).toEqual({ count: 3, tone: 'action' });
    expect(projectAttentionBadge(2, 0)).toEqual({ count: 2, tone: 'unread' });
    expect(projectAttentionBadge(0, 0)).toEqual({ count: 0, tone: null });
  });

  it('empty input → empty maps', () => {
    expect(unreadCountByProject([])).toEqual({});
    expect(awaitingInputCountByProject([])).toEqual({});
  });
});
