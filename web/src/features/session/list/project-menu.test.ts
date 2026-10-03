import { describe, it, expect } from 'vitest';
import {
  unreadCountByProject,
  awaitingInputCountByProject,
  projectAttentionBadge,
} from './project-menu';

describe('per-project tallies — prototype-named ids', () => {
  it('treat constructor / __proto__ / toString as ordinary project ids', () => {
    const s = (projectId: string) => ({ projectId, unread: true, awaitingInput: true }) as never;
    expect(unreadCountByProject([s('constructor')])['constructor']).toBe(1);
    expect(awaitingInputCountByProject([s('__proto__')])['__proto__']).toBe(1);
    expect(unreadCountByProject([])['toString']).toBeUndefined();
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
});
