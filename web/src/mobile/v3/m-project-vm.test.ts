import { describe, it, expect } from 'vitest';
import type { ThreadInfo, ProjectConduitInfo, CostSummary } from '@cortex-agent/ui-contract';
import {
  threadCountsForProject,
  onlineMachineCount,
  buildProjectSwitchRows,
  pendingApprovalCounts,
} from './m-project-vm';

// Neutral placeholder fixtures (守则11 — nimbus / atlas / orchard, no real project ids).
function thread(over: Partial<ThreadInfo>): ThreadInfo {
  return {
    id: 't1',
    templateName: 'x',
    currentStep: null,
    status: 'running',
    projectId: 'nimbus',
    createdAt: '2026-07-15T09:00:00Z',
    updatedAt: '2026-07-15T09:00:00Z',
    totalSteps: 1,
    artifactPath: null,
    ...over,
  };
}

function project(id: string): ProjectConduitInfo {
  return { id, kind: 'general', contextDir: '/x/' + id, hasMission: false, conduits: {} };
}

describe('threadCountsForProject', () => {
  it('counts running and waiting separately, scoped to the project (real ThreadInfo.status)', () => {
    const threads = [
      thread({ projectId: 'nimbus', status: 'running' }),
      thread({ projectId: 'nimbus', status: 'running' }),
      thread({ projectId: 'nimbus', status: 'waiting' }),
      thread({ projectId: 'atlas', status: 'running' }),
      thread({ projectId: 'nimbus', status: 'completed' }),
    ];
    // `running` counts ACTIVE threads (running + waiting) to match the desktop sibling
    // `runningCountByProject` (workbench/project-menu): 2 running + 1 waiting = 3 active;
    // `waiting` is additionally reported on its own.
    expect(threadCountsForProject(threads, 'nimbus')).toEqual({ running: 3, waiting: 1 });
  });

  it('returns zeros for a null current project (no fabrication)', () => {
    expect(threadCountsForProject([thread({})], null)).toEqual({ running: 0, waiting: 0 });
  });
});

describe('onlineMachineCount', () => {
  it('counts only machines with online=true (MachineInfo.online)', () => {
    expect(onlineMachineCount([{ online: true }, { online: false }, { online: true }])).toBe(2);
  });

  it('is 0 for an empty list', () => {
    expect(onlineMachineCount([])).toBe(0);
  });
});

describe('pendingApprovalCounts', () => {
  it('buckets pending entries by projectId, null → global, ignores decided entries', () => {
    const entries = [
      { status: 'pending' as const, projectId: 'atlas' },
      { status: 'pending' as const, projectId: 'atlas' },
      { status: 'pending' as const, projectId: null },
      { status: 'approved' as const, projectId: 'atlas' },
      { status: 'rejected' as const, projectId: null },
    ];
    expect(pendingApprovalCounts(entries)).toEqual({
      byProject: { atlas: 2 },
      global: 1,
      total: 3,
    });
  });

  it('is all-zero for an empty list', () => {
    expect(pendingApprovalCounts([])).toEqual({ byProject: {}, global: 0, total: 0 });
  });
});

describe('buildProjectSwitchRows', () => {
  const projects = [project('nimbus'), project('atlas'), project('orchard')];
  const threads = [thread({ projectId: 'atlas', status: 'running' })];
  const byProject: CostSummary['byProject'] = {
    atlas: { today: 0.87, week: 1, month: 2, total: 3 },
  };

  it('drops the current project and carries real initials, running count, today $', () => {
    const rows = buildProjectSwitchRows(projects, 'nimbus', threads, byProject);
    expect(rows.map((r) => r.id)).toEqual(['atlas', 'orchard']);
    expect(rows.find((r) => r.id === 'atlas')).toMatchObject({
      running: 1,
      todayCost: 0.87,
      initials: 'AT',
    });
    // orchard has no cost bucket → honest null, no fabricated $0.
    expect(rows.find((r) => r.id === 'orchard')).toMatchObject({ running: 0, todayCost: null });
  });

  it('todayCost is null for every row when the global byProject map is absent', () => {
    const rows = buildProjectSwitchRows(projects, 'nimbus', threads, undefined);
    expect(rows.every((r) => r.todayCost === null)).toBe(true);
  });

  it('carries the per-project unread count and defaults to 0 when absent', () => {
    const rows = buildProjectSwitchRows(projects, 'nimbus', threads, byProject, { orchard: 3 });
    expect(rows.find((r) => r.id === 'orchard')?.unread).toBe(3);
    expect(rows.find((r) => r.id === 'atlas')?.unread).toBe(0);
  });

  it('adds unread + action counts and lets action win the badge tone', () => {
    const rows = buildProjectSwitchRows(
      projects,
      'nimbus',
      threads,
      byProject,
      { orchard: 2, atlas: 1 },
      {},
      { orchard: 1 },
    );
    expect(rows.find((r) => r.id === 'orchard')).toMatchObject({
      unread: 2,
      actionRequired: 1,
      badgeCount: 3,
      badgeTone: 'action',
    });
    expect(rows.find((r) => r.id === 'atlas')).toMatchObject({
      unread: 1,
      actionRequired: 0,
      badgeCount: 1,
      badgeTone: 'unread',
    });
  });

  it('orders rows by most recent activity (parity with the desktop LeftRail)', () => {
    // orchard was active more recently than atlas → orchard sorts ahead despite trailing in the list.
    const activity = {
      atlas: Date.parse('2026-07-14T00:00:00'),
      orchard: Date.parse('2026-07-16T00:00:00'),
    };
    const rows = buildProjectSwitchRows(projects, 'nimbus', threads, byProject, {}, activity);
    expect(rows.map((r) => r.id)).toEqual(['orchard', 'atlas']);
  });

  it('unread no longer drives ordering (recency does) — badge still carried', () => {
    // orchard has unread but atlas is the more recently active → atlas stays ahead.
    const activity = { atlas: Date.parse('2026-07-16T00:00:00') };
    const rows = buildProjectSwitchRows(projects, 'nimbus', threads, byProject, { orchard: 2 }, activity);
    expect(rows.map((r) => r.id)).toEqual(['atlas', 'orchard']);
    expect(rows.find((r) => r.id === 'orchard')?.unread).toBe(2);
  });

  it('preserves projects.list order when no activity is known (back-compat)', () => {
    const rows = buildProjectSwitchRows(projects, 'nimbus', threads, byProject, {});
    expect(rows.map((r) => r.id)).toEqual(['atlas', 'orchard']);
  });

  it('folds per-project pending approvals into the badge with the action tone', () => {
    // orchard: 0 unread + 0 session actions + 2 pending approvals → amber badge of 2.
    const rows = buildProjectSwitchRows(
      projects,
      'nimbus',
      threads,
      byProject,
      {},
      {},
      {},
      { orchard: 2 },
    );
    expect(rows.find((r) => r.id === 'orchard')).toMatchObject({
      actionRequired: 2,
      badgeCount: 2,
      badgeTone: 'action',
    });
    expect(rows.find((r) => r.id === 'atlas')?.badgeCount).toBe(0);
  });
});
