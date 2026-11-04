import { beforeAll, describe, expect, it } from 'vitest';
import type { CostEntry } from '../../../src/domain/costs/cost-tracker.js';
import { foldSource } from '../../../src/domain/stats/keys.js';
import { aggregateUsage, usageRow, type SessionLookup, type UsageRow } from '../../../src/domain/stats/usage.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-11-03 22:42 America/Denver (MST).
const NOW = Date.parse('2026-11-04T05:42:00Z');

beforeAll(() => { process.env.TZ = 'America/Denver'; });

function entry(over: Partial<CostEntry> & { at: number }): CostEntry {
  const { at, ...rest } = over;
  return {
    timestamp: new Date(at).toISOString(), project: 'p1', trigger: 'user', cost_usd: 1, num_turns: null,
    duration_s: null, backend: 'claude', mode: 'plan', source: 'estimate', input_tokens: 10, output_tokens: 20,
    cache_creation_tokens: 30, cache_read_tokens: 40, provider_requests: 2, session_id: 's1', model: 'm1', ...rest,
  };
}

function rows(entries: CostEntry[]): UsageRow[] {
  return entries.map((e) => usageRow(e)!);
}

const noSessions: SessionLookup = () => null;
const q = (over: Partial<{ range: '24h' | '7d' | '30d' | '90d'; page: number; projectId: string | null }> = {}) => (
  { range: '30d' as const, page: 0, projectId: null, ...over });

describe('foldSource', () => {
  it('folds ledger triggers into display sources', () => {
    expect(foldSource('user')).toBe('chat');
    expect(foldSource('user:bg-continuation')).toBe('background');
    expect(foldSource('subagent:bg-continuation')).toBe('background');
    expect(foldSource('subagent')).toBe('subagent');
    expect(foldSource('scheduled')).toBe('scheduled');
    expect(foldSource('cache-refresh')).toBe('cacheRefresh');
    expect(foldSource('manual-compact')).toBe('compact');
    expect(foldSource('task-dispatch')).toBe('other');
    expect(foldSource('unknown')).toBe('other');
  });
});

describe('usageRow', () => {
  it('reads legacy rows without cache fields or model as zeros and unknown', () => {
    const row = usageRow({ ...entry({ at: NOW }), cache_creation_tokens: undefined, cache_read_tokens: null, model: undefined, provider_requests: null, cost_usd: null })!;
    expect(row).toMatchObject({ cacheWrite: 0, cacheRead: 0, model: 'unknown', requests: 0, cost: 0, input: 10, output: 20 });
    expect(usageRow({ ...entry({ at: NOW }), timestamp: 'garbage' })).toBeNull();
  });
});

describe('aggregateUsage', () => {
  it('totals the period and compares with the period before', () => {
    const data = rows([
      entry({ at: NOW - HOUR }),
      entry({ at: NOW - 2 * DAY, output_tokens: 100 }),
      entry({ at: NOW - 40 * DAY }),
      entry({ at: NOW - 100 * DAY }),
    ]);
    const usage = aggregateUsage(data, q(), NOW, noSessions);
    expect(usage.totals).toEqual({ input: 20, output: 120, cacheWrite: 60, cacheRead: 80, total: 280, runs: 2, requests: 4, costUsd: 2 });
    expect(usage.previous?.runs).toBe(1);
    expect(usage.buckets).toHaveLength(30);
    expect(usage.buckets.reduce((n, b) => n + b.runs, 0)).toBe(2);
    expect(usage.buckets[29]!.runs).toBe(1);
  });

  it('drops previous when the period before starts outside the retention', () => {
    const usage = aggregateUsage(rows([entry({ at: NOW - HOUR })]), q({ range: '90d' }), NOW, noSessions);
    expect(usage.previous).toBeNull();
    expect(usage.window.hasOlder).toBe(true);
    expect(aggregateUsage([], q({ range: '30d', page: 2 }), NOW, noSessions).previous).toBeNull();
    expect(aggregateUsage([], q({ range: '30d', page: 1 }), NOW, noSessions).previous).not.toBeNull();
  });

  it('pages back whole periods', () => {
    const data = rows([entry({ at: NOW - HOUR }), entry({ at: NOW - 31 * DAY })]);
    const page1 = aggregateUsage(data, q({ page: 1 }), NOW, noSessions);
    expect(page1.totals.runs).toBe(1);
    expect(page1.window.end).toBe(aggregateUsage(data, q(), NOW, noSessions).window.start);
  });

  it('filters by project everywhere except the project list and colour slots', () => {
    const data = rows([
      entry({ at: NOW - HOUR, project: 'big', input_tokens: 1000, model: 'mBig' }),
      entry({ at: NOW - HOUR, project: 'small', input_tokens: 1, model: 'mSmall' }),
    ]);
    const all = aggregateUsage(data, q(), NOW, noSessions);
    const small = aggregateUsage(data, q({ projectId: 'small' }), NOW, noSessions);
    expect(small.totals.runs).toBe(1);
    expect(small.projects).toEqual(['big', 'small']);
    expect(small.groups.model.map((g) => g.key)).toEqual(['mSmall']);
    // mSmall keeps its slot (rank 1 over the whole ledger) under the filter.
    expect(small.groups.model[0]!.colorSlot).toBe(1);
    expect(all.groups.model.map((g) => [g.key, g.colorSlot])).toEqual([['mBig', 0], ['mSmall', 1]]);
    expect(small.groups.project).toEqual([expect.objectContaining({ key: 'small', colorSlot: 1 })]);
  });

  it('colour slots come from the 90-day ledger, not the period', () => {
    const data = rows([
      entry({ at: NOW - 50 * DAY, model: 'old', input_tokens: 1_000_000 }),
      entry({ at: NOW - HOUR, model: 'new' }),
    ]);
    const week = aggregateUsage(data, q({ range: '7d' }), NOW, noSessions);
    expect(week.series.model).toEqual([expect.objectContaining({ key: 'new', colorSlot: 1 })]);
  });

  it('series keep the top 6 keys and fold the rest; runs keep the top 5 without remainder', () => {
    const data = rows(Array.from({ length: 9 }, (_, i) => entry({ at: NOW - HOUR, model: `m${i}`, input_tokens: 1000 - i * 10 })));
    const usage = aggregateUsage(data, q({ range: '24h' }), NOW, noSessions);
    const series = usage.series.model;
    expect(series).toHaveLength(7);
    expect(series.slice(0, 6).map((s) => s.key)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
    expect(series[6]).toMatchObject({ key: null, folded: 3, colorSlot: null });
    expect(series[6]!.total).toBe(3 * 90 + 940 + 930 + 920);
    expect(series[6]!.values).toHaveLength(24);
    expect(series.map((s) => s.colorSlot).slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(usage.groups.model).toHaveLength(9);
    expect(usage.groups.model[8]).toMatchObject({ key: 'm8', colorSlot: null });
    expect(usage.groups.model[7]).toMatchObject({ key: 'm7', colorSlot: 7 });
    expect(usage.runs.model).toHaveLength(5);
    expect(usage.runs.model.every((s) => s.key !== null && s.total === 1)).toBe(true);
    expect(usage.runs.source).toEqual([expect.objectContaining({ key: 'chat', total: 9, colorSlot: 0 })]);
  });

  it('no remainder series when every key fits', () => {
    const usage = aggregateUsage(rows([entry({ at: NOW - HOUR })]), q(), NOW, noSessions);
    expect(usage.series.source).toHaveLength(1);
    expect(usage.series.source[0]).toMatchObject({ key: 'chat', folded: 0 });
  });

  it('ranks sessions, resolves labels and falls back to the ledger project', () => {
    const data = rows([
      entry({ at: NOW - 3 * HOUR, session_id: 'a', model: 'mx', input_tokens: 500, project: 'pa' }),
      entry({ at: NOW - 2 * HOUR, session_id: 'a', model: 'my', input_tokens: 5, trigger: 'subagent', project: 'pa' }),
      entry({ at: NOW - HOUR, session_id: 'b', input_tokens: 1, project: 'pb' }),
      entry({ at: NOW - HOUR, session_id: null }),
    ]);
    const lookup: SessionLookup = (id) => (id === 'a' ? { label: 'Session A', projectId: 'registry-project' } : null);
    const usage = aggregateUsage(data, q(), NOW, lookup);
    expect(usage.sessionCount).toBe(2);
    expect(usage.sessions.map((s) => s.sessionId)).toEqual(['a', 'b']);
    const [a, b] = usage.sessions;
    expect(a).toMatchObject({ label: 'Session A', projectId: 'registry-project', mainModel: 'mx', lastAt: NOW - 2 * HOUR, runs: 2 });
    expect(a!.models.map((m) => m.key)).toEqual(['mx', 'my']);
    expect(a!.sources.map((s) => s.key)).toEqual(['chat', 'subagent']);
    expect(b).toMatchObject({ label: null, projectId: 'pb' });
  });

  it('keeps the top 50 sessions', () => {
    const data = rows(Array.from({ length: 60 }, (_, i) => entry({ at: NOW - HOUR, session_id: `s${i}`, input_tokens: i })));
    const usage = aggregateUsage(data, q(), NOW, noSessions);
    expect(usage.sessions).toHaveLength(50);
    expect(usage.sessions[0]!.sessionId).toBe('s59');
    expect(usage.sessionCount).toBe(60);
  });

  it('ignores rows past the retention even when the file still holds them', () => {
    const usage = aggregateUsage(rows([entry({ at: NOW - 91 * DAY, project: 'gone' })]), q({ range: '90d' }), NOW, noSessions);
    expect(usage.projects).toEqual([]);
    expect(usage.totals.runs).toBe(0);
  });
});
