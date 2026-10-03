import { describe, it, expect } from 'vitest';
import type { ProjectConduitInfo, CostSummary } from '@cortex-agent/ui-contract';
import {
  onlineMachineCount,
  buildProjectSwitchRows,
  pendingApprovalCounts,
} from './m-project-vm';

// Neutral placeholder fixtures (守则11 — nimbus / atlas / orchard, no real project ids).
function project(id: string): ProjectConduitInfo {
  return { id, kind: 'general', contextDir: '/x/' + id, hasMission: false, conduits: {} };
}

describe('onlineMachineCount', () => {
  it('counts only machines with online=true (MachineInfo.online)', () => {
    expect(onlineMachineCount([{ online: true }, { online: false }, { online: true }])).toBe(2);
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
    });
  });
});

describe('pendingApprovalCounts — prototype-named ids', () => {
  it('counts a project id that names an Object.prototype member like any other', () => {
    const counts = pendingApprovalCounts([{ status: 'pending' as const, projectId: 'constructor' }]);
    expect(counts.byProject['constructor']).toBe(1);
    expect(counts.byProject['toString']).toBeUndefined();
  });
});

describe('buildProjectSwitchRows', () => {
  const projects = [project('nimbus'), project('atlas'), project('orchard')];
  const byProject: CostSummary['byProject'] = {
    atlas: { today: 0.87, week: 1, month: 2, total: 3 },
  };

  it('drops the current project and carries today $', () => {
    const rows = buildProjectSwitchRows(projects, 'nimbus', byProject);
    expect(rows.map((r) => r.id)).toEqual(['atlas', 'orchard']);
    expect(rows.find((r) => r.id === 'atlas')).toMatchObject({ todayCost: 0.87 });
    // orchard has no cost bucket → honest null, no fabricated $0.
    expect(rows.find((r) => r.id === 'orchard')).toMatchObject({ todayCost: null });
  });

  it('carries the per-project unread count and defaults to 0 when absent', () => {
    const rows = buildProjectSwitchRows(projects, 'nimbus', byProject, { orchard: 3 });
    expect(rows.find((r) => r.id === 'orchard')).toMatchObject({ badgeCount: 3, badgeTone: 'unread' });
    expect(rows.find((r) => r.id === 'atlas')).toMatchObject({ badgeCount: 0, badgeTone: null });
  });

  it('adds unread + action counts and lets action win the badge tone', () => {
    const rows = buildProjectSwitchRows(
      projects,
      'nimbus',
      byProject,
      { orchard: 2, atlas: 1 },
      {},
      { orchard: 1 },
    );
    expect(rows.find((r) => r.id === 'orchard')).toMatchObject({
      badgeCount: 3,
      badgeTone: 'action',
    });
    expect(rows.find((r) => r.id === 'atlas')).toMatchObject({
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
    const rows = buildProjectSwitchRows(projects, 'nimbus', byProject, {}, activity);
    expect(rows.map((r) => r.id)).toEqual(['orchard', 'atlas']);
  });

  it('unread no longer drives ordering (recency does) — badge still carried', () => {
    // orchard has unread but atlas is the more recently active → atlas stays ahead.
    const activity = { atlas: Date.parse('2026-07-16T00:00:00') };
    const rows = buildProjectSwitchRows(projects, 'nimbus', byProject, { orchard: 2 }, activity);
    expect(rows.map((r) => r.id)).toEqual(['atlas', 'orchard']);
    expect(rows.find((r) => r.id === 'orchard')).toMatchObject({ badgeCount: 2, badgeTone: 'unread' });
  });

  it('preserves projects.list order when no activity is known (back-compat)', () => {
    const rows = buildProjectSwitchRows(projects, 'nimbus', byProject, {});
    expect(rows.map((r) => r.id)).toEqual(['atlas', 'orchard']);
  });

  it('folds per-project pending approvals into the badge with the action tone', () => {
    // orchard: 0 unread + 0 session actions + 2 pending approvals → amber badge of 2.
    const rows = buildProjectSwitchRows(
      projects,
      'nimbus',
      byProject,
      {},
      {},
      {},
      { orchard: 2 },
    );
    expect(rows.find((r) => r.id === 'orchard')).toMatchObject({
      badgeCount: 2,
      badgeTone: 'action',
    });
    expect(rows.find((r) => r.id === 'atlas')?.badgeCount).toBe(0);
  });
});
