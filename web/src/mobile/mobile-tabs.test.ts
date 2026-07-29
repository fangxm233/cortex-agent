// input:  mobile route paths and badge counts
// output: tab mapping including project-notes drill routes
// pos:    Tests the mobile tab navigation model
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import { activeTabId, isTabRoute, tabBadge } from './mobile-tabs';

describe('activeTabId (v3)', () => {
  it('resolves each tab path to its own id', () => {
    expect(activeTabId('/m/sessions')).toBe('sessions');
    expect(activeTabId('/m/threads')).toBe('threads');
    expect(activeTabId('/m/tasks')).toBe('tasks');
    expect(activeTabId('/m/project')).toBe('project');
  });

  it('maps drill-in sub-screens to their origin tab', () => {
    expect(activeTabId('/m/session/s_abcd')).toBe('sessions');
    expect(activeTabId('/m/thread/thr_abcd')).toBe('threads');
    expect(activeTabId('/m/task/T-041')).toBe('tasks');
    expect(activeTabId('/m/approvals')).toBe('project');
    expect(activeTabId('/m/notes')).toBe('project');
    expect(activeTabId('/m/memory')).toBe('project');
    expect(activeTabId('/m/machines')).toBe('project');
    expect(activeTabId('/m/settings')).toBe('project');
    expect(activeTabId('/m/settings/hooks')).toBe('project');
    expect(activeTabId('/m/daemon')).toBe('project');
  });

  it('defaults to sessions for an unknown path (catch-all lands there)', () => {
    expect(activeTabId('/workbench')).toBe('sessions');
    expect(activeTabId('/')).toBe('sessions');
  });
});

describe('isTabRoute (v3)', () => {
  it('is true for the 4 tab paths (and their sub-paths)', () => {
    expect(isTabRoute('/m/sessions')).toBe(true);
    expect(isTabRoute('/m/threads')).toBe(true);
    expect(isTabRoute('/m/tasks')).toBe(true);
    expect(isTabRoute('/m/project')).toBe(true);
    expect(isTabRoute('/m/threads/x')).toBe(true);
  });

  it('is false for the drill-in sub-screens (Tab bar hidden)', () => {
    expect(isTabRoute('/m/session/s_x')).toBe(false);
    expect(isTabRoute('/m/thread/thr_x')).toBe(false);
    expect(isTabRoute('/m/task/T-1')).toBe(false);
    expect(isTabRoute('/m/approvals')).toBe(false);
    expect(isTabRoute('/m/notes')).toBe(false);
    expect(isTabRoute('/m/memory')).toBe(false);
    expect(isTabRoute('/m/machines')).toBe(false);
    expect(isTabRoute('/m/settings')).toBe(false);
    expect(isTabRoute('/m/settings/hooks')).toBe(false);
    expect(isTabRoute('/m/daemon')).toBe(false);
  });

  it('is false for the index / unknown paths', () => {
    expect(isTabRoute('/')).toBe(false);
    expect(isTabRoute('/workbench')).toBe(false);
  });
});

describe('tabBadge (v3)', () => {
  it('shows the amber 需要你 count on the project tab when > 0', () => {
    expect(tabBadge('project', { needsYouCount: 2 })).toEqual({ count: 2 });
  });

  it('shows no badge on the project tab when the count is 0', () => {
    expect(tabBadge('project', { needsYouCount: 0 })).toEqual({});
  });

  it('never decorates sessions / threads / tasks tabs', () => {
    expect(tabBadge('sessions', { needsYouCount: 9 })).toEqual({});
    expect(tabBadge('threads', { needsYouCount: 9 })).toEqual({});
    expect(tabBadge('tasks', { needsYouCount: 9 })).toEqual({});
  });
});
