import { describe, expect, it } from 'vitest';
import type { UsageWindowRecord } from '../../../src/domain/costs/usage-window-history.js';
import { aggregateQuotaWindows, spanOf, type QuotaLedgerRow, type QuotaWindowsInput } from '../../../src/domain/stats/quota-windows.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-04T05:42:00Z');

function record(over: Partial<UsageWindowRecord> = {}): UsageWindowRecord {
  return {
    provider: 'anthropic', route: null, windowType: 'five_hour', resetsAt: NOW + HOUR, peakUtilization: 0.4,
    firstObservedAt: NOW - 3 * HOUR, lastObservedAt: NOW, horizonMs: 4 * HOUR, ...over,
  };
}

function input(over: Partial<QuotaWindowsInput> = {}): QuotaWindowsInput {
  return {
    records: [], ledger: [], sourceSlots: new Map([['chat', 0], ['subagent', 1]]),
    labelOf: (provider, route) => (route ? `${provider} (${route})` : provider),
    query: { provider: null, route: null }, now: NOW, ...over,
  };
}

describe('spanOf', () => {
  it('maps window types to the two tables', () => {
    expect(spanOf({ windowType: 'five_hour', horizonMs: 0 })?.span).toBe('fiveHour');
    expect(spanOf({ windowType: 'seven_day', horizonMs: 0 })?.span).toBe('weekly');
    expect(spanOf({ windowType: 'seven_day_overage_included', horizonMs: 0 })?.span).toBe('weekly');
    expect(spanOf({ windowType: 'codex_secondary', horizonMs: 0 })?.span).toBe('weekly');
    expect(spanOf({ windowType: 'codex_primary', horizonMs: 4 * HOUR })).toEqual({ span: 'fiveHour', durationMs: 5 * HOUR });
    expect(spanOf({ windowType: 'codex_primary', horizonMs: 3 * DAY })).toEqual({ span: 'weekly', durationMs: 7 * DAY });
    expect(spanOf({ windowType: 'model_scoped', horizonMs: 0 })).toBeNull();
  });
});

describe('aggregateQuotaWindows', () => {
  it('is empty before anything was recorded', () => {
    expect(aggregateQuotaWindows(input())).toEqual({ accounts: [], account: null, periods: { fiveHour: [], weekly: [] }, recordingSince: null });
  });

  it('lists accounts, picks the requested one and sorts periods newest first', () => {
    const records = [
      record({ resetsAt: NOW - 4 * HOUR, peakUtilization: 0.9, firstObservedAt: NOW - 8 * HOUR }),
      record(),
      record({ windowType: 'seven_day', resetsAt: NOW + 2 * DAY, horizonMs: 6 * DAY }),
      record({ route: 'school', resetsAt: NOW + 2 * HOUR }),
      record({ provider: 'openai-codex', windowType: 'codex_primary', resetsAt: NOW + 3 * HOUR }),
    ];
    const result = aggregateQuotaWindows(input({ records }));
    expect(result.accounts.map((a) => [a.provider, a.route, a.label])).toEqual([
      ['anthropic', null, 'anthropic'], ['anthropic', 'school', 'anthropic (school)'], ['openai-codex', null, 'openai-codex'],
    ]);
    expect(result.account?.route).toBeNull();
    expect(result.periods.fiveHour.map((p) => p.end)).toEqual([NOW + HOUR, NOW - 4 * HOUR]);
    expect(result.periods.fiveHour[0]).toMatchObject({ windowType: 'five_hour', start: NOW - 4 * HOUR, peakUtilization: 0.4, lastObservedAt: NOW });
    expect(result.periods.weekly).toEqual([expect.objectContaining({ windowType: 'seven_day', start: NOW + 2 * DAY - 7 * DAY })]);
    expect(result.recordingSince).toBe(NOW - 8 * HOUR);
    const school = aggregateQuotaWindows(input({ records, query: { provider: 'anthropic', route: 'school' } }));
    expect(school.account?.route).toBe('school');
    expect(school.periods.fiveHour.map((p) => p.end)).toEqual([NOW + 2 * HOUR]);
    expect(aggregateQuotaWindows(input({ records, query: { provider: 'nope', route: null } })).account?.provider).toBe('anthropic');
  });

  it('splits each period by source with cost-weighted shares of the account’s own rows', () => {
    const ledger: QuotaLedgerRow[] = [
      { at: NOW - HOUR, provider: 'anthropic', route: null, source: 'chat', cost: 3 },
      { at: NOW - 2 * HOUR, provider: 'anthropic', route: null, source: 'subagent', cost: 1 },
      { at: NOW - 2 * HOUR, provider: 'anthropic', route: null, source: 'scheduled', cost: 0 },
      { at: NOW - 5 * HOUR, provider: 'anthropic', route: null, source: 'chat', cost: 50 },
      { at: NOW - HOUR, provider: 'anthropic', route: 'school', source: 'chat', cost: 99 },
    ];
    const result = aggregateQuotaWindows(input({ records: [record(), record({ resetsAt: NOW - 10 * HOUR })], ledger }));
    expect(result.periods.fiveHour[0]!.breakdown).toEqual([
      { key: 'chat', colorSlot: 0, share: 0.75 }, { key: 'subagent', colorSlot: 1, share: 0.25 },
    ]);
    expect(result.periods.fiveHour[1]!.breakdown).toEqual([]);
  });

  it('caps each table at 50 periods and ignores periods past the retention', () => {
    const records = Array.from({ length: 60 }, (_, i) => record({ resetsAt: NOW - i * 5 * HOUR }));
    records.push(record({ windowType: 'seven_day', resetsAt: NOW - 91 * DAY }));
    const result = aggregateQuotaWindows(input({ records }));
    expect(result.periods.fiveHour).toHaveLength(50);
    expect(result.periods.weekly).toEqual([]);
  });
});
