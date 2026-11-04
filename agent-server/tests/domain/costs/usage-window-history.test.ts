import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  UsageWindowHistory, mergeObservation, pruneRecords, windowObservations, type UsageWindowObservation, type UsageWindowRecord,
} from '../../../src/domain/costs/usage-window-history.js';
import { UsageStore, type ProviderUsage } from '../../../src/domain/costs/usage-store.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-04T05:42:00Z');

function row(over: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    provider: 'anthropic', displayName: 'Anthropic', modes: ['subscription'], billing: 'subscription', freshness: 'live',
    observedAt: NOW / 1000,
    windows: [
      { type: 'five_hour', utilization: 0.4, resetsAt: (NOW + 2 * HOUR) / 1000 },
      { type: 'seven_day', utilization: 0.1, resetsAt: (NOW + 3 * DAY) / 1000 },
      { type: 'model_scoped', utilization: 0.5, resetsAt: (NOW + DAY) / 1000 },
      { type: 'seven_day_overage_included', label: 'Fable', utilization: 0.03, resetsAt: (NOW + 3 * DAY) / 1000 },
      { type: 'five_hour', utilization: null, resetsAt: null },
    ],
    ...over,
  };
}

function obs(over: Partial<UsageWindowObservation> = {}): UsageWindowObservation {
  return { provider: 'anthropic', route: null, windowType: 'five_hour', utilization: 0.2, resetsAt: NOW + 2 * HOUR, observedAt: NOW, ...over };
}

describe('windowObservations', () => {
  it('takes subscription windows with a reading, in ms', () => {
    const list = windowObservations([row(), row({ billing: 'api' }), row({ observedAt: null }), row({ route: 'school' })]);
    expect(list.map((o) => [o.route, o.windowType])).toEqual([
      [null, 'five_hour'], [null, 'seven_day'], [null, 'seven_day_overage_included'],
      ['school', 'five_hour'], ['school', 'seven_day'], ['school', 'seven_day_overage_included'],
    ]);
    expect(list[0]).toMatchObject({ utilization: 0.4, resetsAt: NOW + 2 * HOUR, observedAt: NOW });
    expect(list[2]!.label).toBe('Fable');
  });
});

describe('mergeObservation', () => {
  it('keeps the peak and the first and last observation of one period', () => {
    const records: UsageWindowRecord[] = [];
    expect(mergeObservation(records, obs())).toBe(true);
    expect(mergeObservation(records, obs({ utilization: 0.6, observedAt: NOW + HOUR, resetsAt: NOW + 2 * HOUR + 40_000 }))).toBe(true);
    expect(mergeObservation(records, obs({ utilization: 0.5, observedAt: NOW + 30 * MIN }))).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      peakUtilization: 0.6, firstObservedAt: NOW, lastObservedAt: NOW + HOUR, resetsAt: NOW + 2 * HOUR + 40_000, horizonMs: 2 * HOUR,
    });
  });

  it('opens a new record for the next period, another account or another window type', () => {
    const records: UsageWindowRecord[] = [];
    mergeObservation(records, obs());
    mergeObservation(records, obs({ resetsAt: NOW + 7 * HOUR, observedAt: NOW + 3 * HOUR }));
    mergeObservation(records, obs({ route: 'school' }));
    mergeObservation(records, obs({ windowType: 'seven_day' }));
    expect(records).toHaveLength(4);
  });

  it('is idempotent for a re-committed reading', () => {
    const records: UsageWindowRecord[] = [];
    mergeObservation(records, obs());
    expect(mergeObservation(records, obs())).toBe(false);
  });
});

describe('pruneRecords', () => {
  it('drops periods that ended before the 90-day retention', () => {
    const records: UsageWindowRecord[] = [];
    mergeObservation(records, obs({ resetsAt: NOW - 91 * DAY, observedAt: NOW - 91 * DAY - HOUR }));
    mergeObservation(records, obs({ resetsAt: NOW - 89 * DAY, observedAt: NOW - 89 * DAY - HOUR }));
    expect(pruneRecords(records, NOW).map((r) => r.resetsAt)).toEqual([NOW - 89 * DAY]);
  });
});

describe('UsageWindowHistory', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-windows-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('batches writes and reloads what it wrote', async () => {
    const filePath = path.join(dir, 'data', 'usage-windows.json');
    const history = new UsageWindowHistory({ filePath, now: () => NOW, writeDelayMs: 60_000 });
    history.observe([row()]);
    history.observe([row({ observedAt: NOW / 1000 + 60, windows: [{ type: 'five_hour', utilization: 0.7, resetsAt: (NOW + 2 * HOUR) / 1000 }] })]);
    expect(await history.list()).toHaveLength(3);
    await expect(fs.access(filePath)).rejects.toThrow();
    await history.flush();
    const reloaded = await new UsageWindowHistory({ filePath, now: () => NOW }).list();
    expect(reloaded.find((r) => r.windowType === 'five_hour')).toMatchObject({ peakUtilization: 0.7, lastObservedAt: NOW + 60_000 });
  });

  it('never lets a failed write reach the caller', async () => {
    const blocker = path.join(dir, 'file');
    await fs.writeFile(blocker, 'x');
    const history = new UsageWindowHistory({ filePath: path.join(blocker, 'usage-windows.json'), now: () => NOW, writeDelayMs: 0 });
    expect(() => history.observe([row()])).not.toThrow();
    await history.flush();
    expect(await history.list()).toHaveLength(3);
  });

  it('is fed by the usage store on both header updates and polled commits', async () => {
    const observed: ProviderUsage[][] = [];
    let stored: ProviderUsage[] = [];
    const store = new UsageStore({ load: async () => stored, save: async (records) => { stored = records; } }, { observe: (rows) => observed.push([...rows]) });
    await store.update(row());
    await store.commit([row({ route: 'school' })]);
    expect(observed.map((rows) => rows.map((r) => r.route ?? null))).toEqual([[null], ['school']]);
  });

  it('a malformed row or an unwritable file cannot break the usage store', async () => {
    const history = new UsageWindowHistory({ filePath: path.join(dir, 'missing', '\0bad'), now: () => NOW, writeDelayMs: 0 });
    expect(() => history.observe([{ ...row(), windows: null as unknown as ProviderUsage['windows'] }])).not.toThrow();
    const store = new UsageStore({ load: async () => [], save: async () => {} }, history);
    await expect(store.update(row())).resolves.toBeUndefined();
    await expect(history.flush()).resolves.toBeUndefined();
  });
});
