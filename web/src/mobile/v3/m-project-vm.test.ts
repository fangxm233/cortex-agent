import { describe, it, expect } from 'vitest';
import type { ThreadInfo, ProjectConduitInfo, CostSummary } from '@cortex-agent/ui-contract';
import { threadCountsForProject, onlineMachineCount, buildProjectSwitchRows } from './m-project-vm';

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
    expect(threadCountsForProject(threads, 'nimbus')).toEqual({ running: 2, waiting: 1 });
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
});
