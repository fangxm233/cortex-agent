import { describe, it, expect } from 'vitest';
import type { ProjectConduitInfo, SessionInfo } from '@cortex-agent/ui-contract';
import {
  buildProjectRailRows,
  relativeAge,
  lastActivityByProject,
  projectShortLabel,
  projectIndexFromKey,
  clampProjectsZoneHeight,
  PROJECTS_ZONE_DEFAULT_H,
  PROJECTS_ZONE_MIN_H,
  PROJECTS_ZONE_MAX_H,
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
  it('formats minutes / hours / days from the elapsed span', () => {
    expect(relativeAge(NOW - 5 * 60_000, NOW)).toBe('5m');
    expect(relativeAge(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(relativeAge(NOW - 3 * 86_400_000, NOW)).toBe('3d');
  });

  it('clamps sub-minute spans to "now" and never goes negative', () => {
    expect(relativeAge(NOW - 10_000, NOW)).toBe('now');
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

describe('projectShortLabel', () => {
  it('echoes the first two dash segments (design "quad-nav" from quad-nav-sim2real)', () => {
    expect(projectShortLabel('quad-nav-sim2real')).toBe('quad-nav');
  });

  it('keeps ids with two or fewer segments verbatim', () => {
    expect(projectShortLabel('cortex-self')).toBe('cortex-self');
    expect(projectShortLabel('nimbus')).toBe('nimbus');
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

describe('clampProjectsZoneHeight', () => {
  it('passes through in-range heights and clamps out-of-range ones', () => {
    expect(clampProjectsZoneHeight(PROJECTS_ZONE_DEFAULT_H)).toBe(PROJECTS_ZONE_DEFAULT_H);
    expect(clampProjectsZoneHeight(10)).toBe(PROJECTS_ZONE_MIN_H);
    expect(clampProjectsZoneHeight(9999)).toBe(PROJECTS_ZONE_MAX_H);
  });

  it('non-finite input falls back to the design default (322)', () => {
    expect(PROJECTS_ZONE_DEFAULT_H).toBe(322);
    expect(clampProjectsZoneHeight(Number.NaN)).toBe(PROJECTS_ZONE_DEFAULT_H);
  });
});

describe('buildProjectRailRows', () => {
  const projects = [project('quad-nav-sim2real'), project('tactile'), project('lab-ops'), project('paper-pipeline')];

  it('preserves projects.list order (22a position stability — no unread hoisting)', () => {
    const rows = buildProjectRailRows(projects, 'lab-ops', {}, { 'paper-pipeline': 3 }, {}, NOW);
    expect(rows.map((r) => r.id)).toEqual([
      'quad-nav-sim2real',
      'tactile',
      'lab-ops',
      'paper-pipeline',
    ]);
  });

  it('marks the active row and carries initials + counts', () => {
    const rows = buildProjectRailRows(
      projects,
      'quad-nav-sim2real',
      { 'quad-nav-sim2real': 2, 'lab-ops': 1 },
      { tactile: 1 },
      {},
      NOW,
    );
    expect(rows[0]).toMatchObject({ id: 'quad-nav-sim2real', active: true, initials: 'QN', running: 2 });
    expect(rows[1]).toMatchObject({ active: false, running: 0, unread: 1 });
    expect(rows[2]).toMatchObject({ running: 1 });
  });

  it('assigns ⌘1–⌘9 hotkeys by list order, none past the ninth', () => {
    const many = Array.from({ length: 11 }, (_, i) => project('p' + i));
    const rows = buildProjectRailRows(many, null, {}, {}, {}, NOW);
    expect(rows[0].hotkey).toBe('⌘1');
    expect(rows[8].hotkey).toBe('⌘9');
    expect(rows[9].hotkey).toBeNull();
  });

  it('idle rows (no running/unread badge) trail with the last-activity age instead of the hotkey (design "3d" row)', () => {
    const activity = { 'paper-pipeline': NOW - 3 * 86_400_000 };
    const rows = buildProjectRailRows(projects, 'quad-nav-sim2real', { 'lab-ops': 1 }, {}, activity, NOW);
    const pp = rows[3];
    expect(pp.running).toBe(0);
    expect(pp.unread).toBe(0);
    expect(pp.idleAge).toBe('3d');
    // badge rows keep the hotkey; the idle-age row shows age INSTEAD (mock rows TR/LO vs PP)
    expect(rows[2].idleAge).toBeNull();
    expect(rows[2].hotkey).toBe('⌘3');
  });

  it('idle rows with no known activity show neither age nor badges', () => {
    const rows = buildProjectRailRows([project('fresh')], null, {}, {}, {}, NOW);
    expect(rows[0].idleAge).toBeNull();
    expect(rows[0].running).toBe(0);
  });
});
