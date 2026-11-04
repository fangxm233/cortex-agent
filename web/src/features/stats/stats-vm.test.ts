import { describe, expect, it } from 'vitest';
import type { StatsQuotaPeriod, StatsSeries, StatsTotals, StatsUsage } from '@cortex-agent/ui-contract';
import { en, zh } from '@/i18n';
import {
  accountFromKey, accountKey, barIndexAt, buildKpis, buildSessionRow, cacheHitRate, dimensionSeries, formatCost,
  formatShare, formatTick, formatTokens, hiddenMask, keyLabel, labelStride, legendItems, lineIndexAt, lineLayout,
  niceTicks, pointDelta, quotaRows, rankRows, relativeDelta, roundedTopPath, showMore, slotColor, sparkPaths,
  stackLayout, toggleId, tooltipRows, typeSeries, usageSeries, windowLabel, type ChartFrame,
} from './stats-vm';

const DAY = 86_400_000;
// Midnight UTC: the day buckets' midpoints fall on Oct 5–7 in every zone within ±11h.
const T0 = Date.UTC(2026, 9, 5);

function totals(over: Partial<StatsTotals> = {}): StatsTotals {
  const base = { input: 100, output: 50, cacheWrite: 200, cacheRead: 700, runs: 3, requests: 9, costUsd: 1.5, ...over };
  return { ...base, total: base.input + base.output + base.cacheWrite + base.cacheRead };
}

function usage(over: Partial<StatsUsage> = {}): StatsUsage {
  const buckets = [0, 1, 2].map((i) => ({ start: T0 + i * DAY, ...totals({ cacheRead: 700 * (i + 1) }) }));
  const series: StatsSeries[] = [
    { key: 'claude-opus', folded: 0, colorSlot: 0, total: 3000, values: [900, 1000, 1100] },
    { key: null, folded: 3, colorSlot: null, total: 60, values: [10, 20, 30] },
  ];
  return {
    window: { range: '7d', page: 0, bucket: 'day', start: T0, end: T0 + 3 * DAY, hasOlder: true },
    totals: totals(), previous: totals({ output: 25 }), buckets,
    series: { model: series, project: [], source: [] },
    groups: { model: [], project: [], source: [] },
    sessions: [], sessionCount: 0, runs: { model: [], source: [] }, projects: [],
    ...over,
  };
}

const FRAME: ChartFrame = { width: 444, height: 200, left: 44, right: 0, top: 10, bottom: 20 };

describe('number formatting', () => {
  it('compacts token counts to three significant figures', () => {
    expect(formatTokens(412)).toBe('412');
    expect(formatTokens(7_812)).toBe('7.81k');
    expect(formatTokens(66_400_000)).toBe('66.4M');
    expect(formatTokens(849_000_000)).toBe('849M');
    expect(formatTokens(12_900_000_000)).toBe('12.9B');
    expect(formatTokens(9_000_000)).toBe('9M');
  });

  it('promotes a value that rounds up to the next unit', () => {
    expect(formatTokens(999_960)).toBe('1M');
    expect(formatTokens(999_999_999)).toBe('1B');
  });

  it('formats money, shares and ticks', () => {
    expect(formatCost(7672.6)).toBe('$7,673');
    expect(formatCost(186.2)).toBe('$186');
    expect(formatCost(3.456)).toBe('$3.46');
    expect(formatShare(882, 1000)).toBe('88.2%');
    expect(formatShare(1, 10_000)).toBe('<0.1%');
    expect(formatShare(0, 10)).toBe('0%');
    expect(formatShare(5, 0)).toBe('0%');
    expect(formatTick(1_500_000_000, false)).toBe('1.5B');
    expect(formatTick(0, false)).toBe('0');
    expect(formatTick(2.5, false)).toBe('2.5');
    expect(formatTick(200, true)).toBe('200');
  });
});

describe('deltas and rates', () => {
  it('compares with the previous period, one decimal under 10%', () => {
    expect(relativeDelta(237, 100)).toEqual({ direction: 'up', text: '137%' });
    expect(relativeDelta(95.2, 100)).toEqual({ direction: 'down', text: '4.8%' });
    expect(relativeDelta(10, null)).toBeNull();
    expect(relativeDelta(10, 0)).toBeNull();
  });

  it('reports a rate change in points', () => {
    expect(pointDelta(0.978, 0.97, en)).toEqual({ direction: 'up', text: '0.8 pt' });
    expect(pointDelta(0.5, 0.6, zh)?.text).toBe('10.0 个百分点');
    expect(pointDelta(null, 0.5, en)).toBeNull();
  });

  it('computes the cache hit rate over the whole prompt', () => {
    expect(cacheHitRate({ input: 100, cacheWrite: 200, cacheRead: 700, output: 999 })).toBe(0.7);
    expect(cacheHitRate({ input: 0, cacheWrite: 0, cacheRead: 0, output: 5 })).toBeNull();
  });
});

describe('colour', () => {
  it('follows the server slot and greys out the rest', () => {
    expect(slotColor(0)).toBe('var(--viz-1)');
    expect(slotColor(7)).toBe('var(--viz-8)');
    expect(slotColor(8)).toBe('var(--viz-other)');
    expect(slotColor(null)).toBe('var(--viz-other)');
  });

  it('keeps token kinds on fixed slots and the remainder grey', () => {
    const kinds = typeSeries(usage().buckets, en);
    expect(kinds.map((s) => [s.id, s.color])).toEqual([
      ['cacheRead', 'var(--viz-1)'], ['cacheWrite', 'var(--viz-2)'], ['input', 'var(--viz-3)'], ['output', 'var(--viz-4)'],
    ]);
    const models = dimensionSeries(usage().series.model, 'model', en);
    expect(models.map((s) => [s.id, s.name, s.color])).toEqual([
      ['claude-opus', 'claude-opus', 'var(--viz-1)'], ['__rest', '3 others', 'var(--viz-other)'],
    ]);
  });
});

describe('series and legend', () => {
  it('sums the type series from the buckets', () => {
    const kinds = usageSeries(usage(), 'type', en);
    expect(kinds[0].values).toEqual([700, 1400, 2100]);
    expect(kinds[0].total).toBe(4200);
  });

  it('names sources and the folded remainder in the UI language', () => {
    expect(keyLabel('source', 'background', 0, zh)).toBe('后台续跑');
    expect(keyLabel('source', 'mystery', 0, en)).toBe('mystery');
    expect(keyLabel('model', null, 10, zh)).toBe('其他 10 项');
  });

  it('toggles series and lists the visible ones by value in a tooltip', () => {
    const series = dimensionSeries(usage().series.model, 'model', en);
    const hidden = toggleId(new Set(), '__rest');
    expect(hiddenMask(series, hidden)).toEqual([false, true]);
    expect(toggleId(hidden, '__rest').size).toBe(0);
    expect(tooltipRows(series, new Set(), 1).map((r) => [r.id, r.value])).toEqual([['claude-opus', 1000], ['__rest', 20]]);
    expect(tooltipRows(series, hidden, 1).map((r) => r.id)).toEqual(['claude-opus']);
    const items = legendItems(series, hidden, 3060, formatTokens);
    expect(items[1]).toMatchObject({ id: '__rest', share: '2.0%', value: '60', hidden: true });
  });
});

describe('scales', () => {
  it('picks round steps and a top at or above the max', () => {
    expect(niceTicks(1_280_000_000)).toEqual([0, 500_000_000, 1_000_000_000, 1_500_000_000]);
    expect(niceTicks(5_200)).toEqual([0, 2_000, 4_000, 6_000]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(1000)).toEqual([0, 250, 500, 750, 1000]);
  });

  it('never gives counts a fractional step', () => {
    expect(niceTicks(3, true)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(2, true)).toEqual([0, 1, 2]);
    expect(niceTicks(290, true)).toEqual([0, 100, 200, 300]);
  });

  it('thins axis labels to fit', () => {
    expect(labelStride(30, 8)).toBe(4);
    expect(labelStride(7, 8)).toBe(1);
    expect(labelStride(24, 0)).toBe(24);
  });
});

describe('stacked bar geometry', () => {
  const values = [[600, 0], [400, 200]];

  it('stacks segments with a 2px gap and rounds only the top one', () => {
    const layout = stackLayout(values, [false, false], FRAME, 2);
    expect(layout.scale.ticks).toEqual([0, 250, 500, 750, 1000]);
    const [first] = layout.columns;
    expect(first.segments).toHaveLength(2);
    const [bottom, top] = first.segments;
    expect(bottom.y - (top.y + top.height)).toBeCloseTo(2);
    expect(bottom.y + bottom.height).toBeCloseTo(180);
    expect([bottom.top, top.top]).toEqual([false, true]);
    expect(layout.columns[1].segments.map((s) => s.series)).toEqual([1]);
  });

  it('caps the bar width and centres it in the slot', () => {
    const column = stackLayout(values, [false, false], FRAME, 2).columns[0];
    expect(column.slotWidth).toBe(200);
    expect(column.width).toBe(24);
    expect(column.x).toBe(44 + 88);
  });

  it('rescales when a series is hidden', () => {
    const layout = stackLayout(values, [false, true], FRAME, 2);
    expect(layout.scale.max).toBe(600);
    expect(layout.columns[0].segments).toHaveLength(1);
    expect(layout.columns[0].segments[0].top).toBe(true);
  });

  it('draws a rounded top and a square base', () => {
    expect(roundedTopPath(0, 10, 20, 50)).toBe('M0,60V14Q0,10 4,10H16Q20,10 20,14V60Z');
    expect(roundedTopPath(0, 10, 20, 2)).toBe('M0,12V12Q0,10 2,10H18Q20,10 20,12V12Z');
  });

  it('maps a pointer to a bucket inside the plot only', () => {
    expect(barIndexAt(44, FRAME, 2)).toBe(0);
    expect(barIndexAt(250, FRAME, 2)).toBe(1);
    expect(barIndexAt(10, FRAME, 2)).toBeNull();
    expect(barIndexAt(444, FRAME, 2)).toBeNull();
  });
});

describe('line geometry', () => {
  it('spreads points edge to edge and snaps the crosshair to the nearest one', () => {
    const layout = lineLayout([[0, 5, 10], [3, 3, 3]], [false, false], FRAME, 3);
    expect(layout.xs).toEqual([44, 244, 444]);
    expect(layout.lines[0].points.split(' ')[2]).toBe('444.0,10.0');
    expect(lineIndexAt(140, FRAME, 3)).toBe(0);
    expect(lineIndexAt(150, FRAME, 3)).toBe(1);
    expect(lineIndexAt(9999, FRAME, 3)).toBe(2);
  });

  it('drops a hidden line', () => {
    const layout = lineLayout([[0, 5, 10], [3, 3, 3]], [true, false], FRAME, 3);
    expect(layout.lines.map((l) => l.series)).toEqual([1]);
    expect(layout.scale.max).toBe(3);
  });
});

describe('sparkline', () => {
  it('breaks the line at a gap', () => {
    const { line, area } = sparkPaths([1, 2, null, 2], 30, 30);
    expect(line).toBe('M0,15L10,2M30,2');
    expect(area).toBe('M0,30L0,15L10,2L10,30Z');
  });
});

describe('KPIs', () => {
  it('builds four tiles with deltas against the previous period', () => {
    const kpis = buildKpis(usage(), en);
    expect(kpis.map((k) => k.id)).toEqual(['total', 'output', 'cacheHit', 'cost']);
    expect(kpis[1]).toMatchObject({ value: '50', delta: { direction: 'up', text: '100%' } });
    expect(kpis[2].value).toBe('70.0%');
    expect(kpis[2].delta).toEqual({ direction: 'up', text: '0.0 pt' });
    expect(kpis[3].value).toBe('$1.50');
  });

  it('hides every delta without a previous period', () => {
    expect(buildKpis(usage({ previous: null }), en).every((k) => k.delta === null)).toBe(true);
  });
});

describe('sessions', () => {
  it('describes a row and its split', () => {
    const row = buildSessionRow({
      ...totals(), sessionId: 'abcdef123456', label: null, projectId: 'alap', mainModel: 'claude-opus', lastAt: T0,
      models: [{ key: 'claude-opus', colorSlot: 0, total: 1050 }],
      sources: [{ key: 'chat', colorSlot: 0, total: 1000 }, { key: 'cacheRefresh', colorSlot: 2, total: 50 }],
    }, 10_500, T0 + 5 * DAY, 'zh', zh);
    expect(row).toMatchObject({ label: 'abcdef12', sub: 'alap · claude-opus', tokens: '1.05k', share: '10.0%', cost: '$1.50' });
    expect(row.kinds.map((k) => [k.id, k.amount])).toEqual([['cacheRead', 700], ['cacheWrite', 200], ['input', 100], ['output', 50]]);
    expect(row.sources.map((s) => s.name)).toEqual(['对话', '缓存保温']);
    expect(row.lastActive).toBe('5天前');
  });

  it('shows six more rows per press, up to the total', () => {
    expect(showMore(6, 50)).toBe(12);
    expect(showMore(48, 50)).toBe(50);
  });
});

describe('quota windows', () => {
  const period: StatsQuotaPeriod = {
    windowType: 'five_hour', start: Date.UTC(2026, 10, 4, 2, 12), end: Date.UTC(2026, 10, 4, 7, 12),
    peakUtilization: 0.8, lastObservedAt: 0,
    breakdown: [{ key: 'background', colorSlot: 1, share: 0.25 }, { key: 'chat', colorSlot: 0, share: 0.75 }],
  };

  it('splits the peak across sources, largest first', () => {
    const [row] = quotaRows([period], 'fiveHour', 'en', en);
    expect(row).toMatchObject({ percent: 80, percentText: '80.0%', severity: 'warning' });
    expect(row.breakdown.map((b) => [b.name, b.value])).toEqual([['Chat', '60.0%'], ['Background', '20.0%']]);
  });

  it('round-trips an account key', () => {
    expect(accountFromKey(accountKey({ provider: 'anthropic', route: 'school' }))).toEqual({ provider: 'anthropic', route: 'school' });
    expect(accountFromKey(accountKey({ provider: 'anthropic', route: null }))).toEqual({ provider: 'anthropic', route: null });
  });
});

describe('ranking', () => {
  it('scales bars to the top entry', () => {
    const rows = rankRows([{ name: 'Bash', count: 44_531, colorSlot: 0 }, { name: 'Read', count: 11_132, colorSlot: null }], 'en-US');
    expect(rows.map((r) => [r.count, Math.round(r.width), r.color])).toEqual([
      ['44,531', 100, 'var(--viz-1)'], ['11,132', 25, 'var(--viz-other)'],
    ]);
  });
});

describe('period label', () => {
  it('names the first and last day of the page', () => {
    const label = windowLabel(usage().window, 'en-US');
    expect(label).toMatch(/Oct 5/);
    expect(label).toMatch(/7/);
  });
});
