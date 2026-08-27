import { describe, it, expect } from 'vitest';
import type { ProjectConduitInfo, SessionInfo } from '@cortex-agent/ui-contract';
import {
  lastActivityByProject,
  projectIndexFromKey,
  relativeAge,
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

const NOW = Date.parse('2026-07-16T12:00:00');

describe('relativeAge', () => {
  it('collapses a span into one compact unit, never a negative one', () => {
    expect(relativeAge(NOW - 30_000, NOW)).toBe('now');
    expect(relativeAge(NOW - 5 * 60_000, NOW)).toBe('5m');
    expect(relativeAge(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(relativeAge(NOW - 2 * 86_400_000, NOW)).toBe('2d');
    expect(relativeAge(NOW + 60_000, NOW)).toBe('now');
  });
});

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

  it('does not mutate the input array', () => {
    const input = [project('x'), project('y')];
    const before = input.map((p) => p.id);
    sortProjectsByActivity(input, { y: 1 });
    expect(input.map((p) => p.id)).toEqual(before);
  });
});

describe('projectIndexFromKey', () => {
  it('maps digit keys 1–9 to list indices 0–8', () => {
    expect(projectIndexFromKey('1')).toBe(0);
    expect(projectIndexFromKey('9')).toBe(8);
  });

  it('rejects everything else', () => {
    expect(projectIndexFromKey('0')).toBeNull();
    expect(projectIndexFromKey('a')).toBeNull();
    expect(projectIndexFromKey('10')).toBeNull();
  });
});
