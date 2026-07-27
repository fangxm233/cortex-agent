import { describe, it, expect } from 'vitest';
import type { ProjectConduitInfo, ThreadInfo } from '@cortex-agent/ui-contract';
import {
  runningCountByProject,
  unreadCountByProject,
  awaitingInputCountByProject,
  projectAttentionBadge,
  buildSwitchList,
  switchRowMeta,
  projMenuSubLabel,
} from './project-menu';

const thread = (projectId: string, status: ThreadInfo['status']): ThreadInfo => ({
  id: 't_' + Math.random().toString(36).slice(2),
  templateName: 'coder-review',
  currentStep: null,
  status,
  projectId,
  createdAt: '2026-07-06T00:00:00Z',
  updatedAt: '2026-07-06T00:00:00Z',
  totalSteps: 1,
  artifactPath: null,
});

const project = (id: string): ProjectConduitInfo => ({
  id,
  kind: 'research',
  contextDir: '/x/' + id,
  hasMission: true,
  conduits: {},
});

describe('runningCountByProject', () => {
  it('counts only running + waiting threads, grouped by projectId', () => {
    const counts = runningCountByProject([
      thread('a', 'running'),
      thread('a', 'waiting'),
      thread('a', 'completed'),
      thread('b', 'running'),
      thread('c', 'failed'),
    ]);
    expect(counts).toEqual({ a: 2, b: 1 });
  });

  it('returns an empty map for no active threads', () => {
    expect(runningCountByProject([thread('a', 'completed')])).toEqual({});
  });
});

describe('switchRowMeta', () => {
  it('shows the running count when > 0, else idle', () => {
    expect(switchRowMeta(2)).toBe('2 running');
    expect(switchRowMeta(1)).toBe('1 running');
    expect(switchRowMeta(0)).toBe('idle');
  });
});

describe('buildSwitchList', () => {
  it('excludes the active project and maps real running counts, order preserved', () => {
    const rows = buildSwitchList(
      [project('nimbus'), project('cortex-self'), project('beacon')],
      'cortex-self',
      { nimbus: 2 },
    );
    expect(rows).toEqual([
      { id: 'nimbus', running: 2, isRunning: true, meta: '2 running', unread: 0 },
      { id: 'beacon', running: 0, isRunning: false, meta: 'idle', unread: 0 },
    ]);
  });

  it('keeps every project when there is no active project', () => {
    const rows = buildSwitchList([project('a'), project('b')], null, {});
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('projMenuSubLabel', () => {
  it('formats plural threads + cost', () => {
    expect(projMenuSubLabel(2, 4.21)).toBe('2 threads running · $4.21 today');
  });

  it('uses singular for one thread', () => {
    expect(projMenuSubLabel(1, 0.3)).toBe('1 thread running · $0.30 today');
  });

  it('omits cost when unknown', () => {
    expect(projMenuSubLabel(0, undefined)).toBe('0 threads running');
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

  it('empty input → empty maps', () => {
    expect(unreadCountByProject([])).toEqual({});
    expect(awaitingInputCountByProject([])).toEqual({});
  });
});

describe('buildSwitchList unread ordering', () => {
  const proj = (id: string) => ({ id }) as never;

  it('sorts projects with unread sessions first (stable within halves) and carries the count', () => {
    const rows = buildSwitchList(
      [proj('a'), proj('b'), proj('c'), proj('d')],
      null,
      {},
      { b: 2, d: 1 },
    );
    expect(rows.map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(rows.map((r) => r.unread)).toEqual([2, 1, 0, 0]);
  });

  it('without unread counts the projects.list order is preserved (back-compat)', () => {
    const rows = buildSwitchList([proj('a'), proj('b')], null, { b: 1 });
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows.map((r) => r.unread)).toEqual([0, 0]);
  });
});
