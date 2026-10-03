import { describe, it, expect } from 'vitest';
import { activeTabId, isTabRoute, tabBadge } from './mobile-tabs';

describe('activeTabId (v3)', () => {
  it('resolves each tab path to its own id', () => {
    expect(activeTabId('/m/sessions')).toBe('sessions');
    expect(activeTabId('/m/project')).toBe('project');
  });

  it('maps drill-in sub-screens to their origin tab', () => {
    expect(activeTabId('/m/session/s_abcd')).toBe('sessions');
    expect(activeTabId('/m/session/s_abcd/plan/request-1')).toBe('sessions');
    expect(activeTabId('/m/approvals')).toBe('project');
    expect(activeTabId('/m/notes')).toBe('project');
    expect(activeTabId('/m/memory')).toBe('project');
    expect(activeTabId('/m/machines')).toBe('project');
    expect(activeTabId('/m/settings')).toBe('project');
    expect(activeTabId('/m/settings/accounts')).toBe('project');
    expect(activeTabId('/m/settings/hooks')).toBe('project');
    expect(activeTabId('/m/daemon')).toBe('project');
  });

  it('defaults to sessions for an unknown path (catch-all lands there)', () => {
    expect(activeTabId('/workbench')).toBe('sessions');
    expect(activeTabId('/')).toBe('sessions');
  });
});

describe('isTabRoute (v3)', () => {
  it('is true for the tab paths (and their sub-paths)', () => {
    expect(isTabRoute('/m/sessions')).toBe(true);
    expect(isTabRoute('/m/project')).toBe(true);
    expect(isTabRoute('/m/project/x')).toBe(true);
  });

  it('is false for the drill-in sub-screens (Tab bar hidden)', () => {
    expect(isTabRoute('/m/session/s_x')).toBe(false);
    expect(isTabRoute('/m/approvals')).toBe(false);
    expect(isTabRoute('/m/notes')).toBe(false);
    expect(isTabRoute('/m/memory')).toBe(false);
    expect(isTabRoute('/m/machines')).toBe(false);
    expect(isTabRoute('/m/settings')).toBe(false);
    expect(isTabRoute('/m/settings/accounts')).toBe(false);
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

  it('never decorates the sessions tab', () => {
    expect(tabBadge('sessions', { needsYouCount: 9 })).toEqual({});
  });
});
