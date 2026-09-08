import { describe, expect, it } from 'vitest';
import { canGoBack, canGoForward, recordEntry, type NavStack } from './navigation-history';

const at = (route: string, projectId: string | null, sessionId: string | null) => ({ route, projectId, sessionId });
const stackOf = (entries: NavStack['entries'], index = entries.length - 1): NavStack => ({ entries, index });

describe('recordEntry', () => {
  it('ignores an unchanged tuple', () => {
    const stack = stackOf([at('/workbench', 'p1', 's1')]);
    expect(recordEntry(stack, at('/workbench', 'p1', 's1'))).toBe(stack);
  });

  it('pushes a session switch even though the route is unchanged', () => {
    const stack = stackOf([at('/workbench', 'p1', 's1')]);
    const next = recordEntry(stack, at('/workbench', 'p1', 's2'));
    expect(next.entries).toHaveLength(2);
    expect(next.index).toBe(1);
  });

  it('replaces rather than pushes when the session merely resolves from null', () => {
    const stack = stackOf([at('/workbench', 'p1', null)]);
    const next = recordEntry(stack, at('/workbench', 'p1', 's1'));
    expect(next.entries).toEqual([at('/workbench', 'p1', 's1')]);
    expect(next.index).toBe(0);
  });

  it('pushes when the session changes between two non-null values', () => {
    const stack = stackOf([at('/workbench', 'p1', 's1')]);
    expect(recordEntry(stack, at('/workbench', 'p1', null)).entries).toHaveLength(2);
  });

  it('truncates forward history on a new navigation', () => {
    const stack = stackOf(
      [at('/workbench', 'p1', 's1'), at('/overview', 'p1', 's1'), at('/memory', 'p1', 's1')],
      0,
    );
    const next = recordEntry(stack, at('/skills', 'p1', 's1'));
    expect(next.entries).toEqual([at('/workbench', 'p1', 's1'), at('/skills', 'p1', 's1')]);
    expect(next.index).toBe(1);
  });

  it('treats a project switch as a navigation', () => {
    const stack = stackOf([at('/workbench', 'p1', 's1')]);
    expect(recordEntry(stack, at('/workbench', 'p2', 's1')).entries).toHaveLength(2);
  });
});

describe('canGoBack / canGoForward', () => {
  const entries = [at('/a', null, null), at('/b', null, null), at('/c', null, null)];
  it('reports both directions from the middle', () => {
    expect(canGoBack(stackOf(entries, 1))).toBe(true);
    expect(canGoForward(stackOf(entries, 1))).toBe(true);
  });
  it('reports no back at the start and no forward at the end', () => {
    expect(canGoBack(stackOf(entries, 0))).toBe(false);
    expect(canGoForward(stackOf(entries, 2))).toBe(false);
  });
});
