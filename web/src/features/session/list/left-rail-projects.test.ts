import { describe, it, expect } from 'vitest';
import type { ProjectConduitInfo, SessionInfo } from '@cortex-agent/ui-contract';
import {
  lastActivityByProject,
  sortProjectsByActivity,
} from './left-rail-projects';

const project = (id: string): ProjectConduitInfo => ({
  id,
  kind: 'research',
  contextDir: '/x/' + id,
  hasMission: true,
  conduits: {},
});

const session = (projectId: string, lastUsedAt: string): SessionInfo =>
  ({
    sessionId: 's_' + Math.random().toString(36).slice(2),
    projectId,
    lastUsedAt,
    createdAt: lastUsedAt,
  }) as SessionInfo;

describe('lastActivityByProject', () => {
  it('keeps the max effective timestamp per project', () => {
    const map = lastActivityByProject([
      session('a', '2026-07-14T08:00:00'),
      session('a', '2026-07-15T09:30:00'),
      session('b', '2026-07-10T00:00:00'),
    ]);
    expect(map.a).toBe(Date.parse('2026-07-15T09:30:00'));
    expect(map.b).toBe(Date.parse('2026-07-10T00:00:00'));
  });

  it('empty input → empty map; unparseable timestamps are skipped', () => {
    expect(lastActivityByProject([])).toEqual({});
    expect(lastActivityByProject([session('a', 'not-a-date')])).toEqual({});
  });
});

describe('sortProjectsByActivity', () => {
  const projects = [project('a'), project('b'), project('c'), project('d')];

  it('orders by most recent activity (descending)', () => {
    const activity = {
      a: Date.parse('2026-07-10T00:00:00'),
      b: Date.parse('2026-07-15T00:00:00'),
      c: Date.parse('2026-07-12T00:00:00'),
      d: Date.parse('2026-07-16T00:00:00'),
    };
    expect(sortProjectsByActivity(projects, activity).map((p) => p.id)).toEqual(['d', 'b', 'c', 'a']);
  });

  it('sinks projects with no known activity to the bottom, keeping their incoming order (stable)', () => {
    const activity = { c: Date.parse('2026-07-12T00:00:00'), a: Date.parse('2026-07-15T00:00:00') };
    // a (latest) then c, then the unknowns b,d in their original relative order.
    expect(sortProjectsByActivity(projects, activity).map((p) => p.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('empty activity map → incoming order preserved verbatim (never NaN-shuffled)', () => {
    expect(sortProjectsByActivity(projects, {}).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
