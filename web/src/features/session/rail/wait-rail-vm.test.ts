import { describe, expect, it } from 'vitest';
import type { WaitpointInfo } from '@cortex-agent/ui-contract';
import { waitRailViewModel } from './wait-rail-vm';

const T0 = Date.UTC(2026, 8, 18, 10, 0, 0);

function wp(overrides: Partial<WaitpointInfo> = {}): WaitpointInfo {
  return {
    id: 'wp_1', label: 'train-arm2', intent: 'wait for the run', state: 'armed',
    emitFrom: { kind: 'local' },
    quorum: { need: 1, got: 0, members: [] },
    failFast: true, fires: 0, maxSignals: 1,
    createdAt: T0, expiresAt: T0 + 3 * 3600_000,
    signals: [],
    delivery: { pending: false, attempts: 0, lastError: null, lastAt: null },
    wakesLastHour: 0, wakeLimit: 12, rateLimited: false,
    ...overrides,
  };
}

describe('waitRailViewModel', () => {
  it('renders nothing when the session is waiting on nothing', () => {
    expect(waitRailViewModel([], T0, 'en')).toBeNull();
    expect(waitRailViewModel(null, T0, 'en')).toBeNull();
    expect(waitRailViewModel(undefined, T0, 'en')).toBeNull();
  });

  it('headlines the most urgent waitpoint (the server sends them expiry-first)', () => {
    const vm = waitRailViewModel([wp({ label: 'soon', expiresAt: T0 + 60_000 }), wp({ id: 'wp_2', label: 'later' })], T0, 'en');
    expect(vm?.count).toBe(2);
    expect(vm?.headline).toBe('waiting on 2 signals · soon · expires in 1m');
  });

  it('uses the singular for one waitpoint', () => {
    expect(waitRailViewModel([wp()], T0, 'en')?.headline).toBe('waiting on 1 signal · train-arm2 · expires in 3h');
  });

  it('speaks Chinese', () => {
    expect(waitRailViewModel([wp()], T0, 'zh')?.headline).toBe('等 1 个信号 · train-arm2 · 3 小时后过期');
  });

  // ── progress: the quorum rules that are easy to render as a lie ──────────────

  it('shows no fraction for a single-signal waitpoint', () => {
    expect(waitRailViewModel([wp()], T0, 'en')?.rows[0].progress).toBeNull();
  });

  it('shows a fraction once more than one report is required', () => {
    const vm = waitRailViewModel([wp({ quorum: { need: 3, got: 2, members: ['a', 'b', 'c'] } })], T0, 'en');
    expect(vm?.rows[0].progress).toBe('2/3 reported');
  });

  it('reports anonymous reporters that outnumber the declared members', () => {
    // got counts reporter KEYS: three anonymous signals with members[] empty.
    const vm = waitRailViewModel([wp({ quorum: { need: 3, got: 3, members: [] } })], T0, 'en');
    expect(vm?.rows[0].progress).toBe('3/3 reported');
  });

  it('marks fail-fast only when a fraction could otherwise look wrong', () => {
    expect(waitRailViewModel([wp({ failFast: true })], T0, 'en')?.rows[0].failFast).toBe(false);
    const multi = waitRailViewModel([wp({ failFast: true, quorum: { need: 3, got: 1, members: [] } })], T0, 'en');
    expect(multi?.rows[0].failFast).toBe(true);
  });

  it('disambiguates a mailbox whose progress counter resets after each fire', () => {
    expect(waitRailViewModel([wp()], T0, 'en')?.rows[0].mailbox).toBeNull();
    const box = waitRailViewModel([wp({ maxSignals: 5, fires: 2 })], T0, 'en');
    expect(box?.rows[0].mailbox).toBe('fire 3/5');
  });

  // ── time ────────────────────────────────────────────────────────────────────

  it('flags an expiry inside ten minutes as urgent', () => {
    expect(waitRailViewModel([wp({ expiresAt: T0 + 9 * 60_000 })], T0, 'en')?.rows[0].urgent).toBe(true);
    expect(waitRailViewModel([wp({ expiresAt: T0 + 11 * 60_000 })], T0, 'en')?.rows[0].urgent).toBe(false);
  });

  it('says overdue rather than a negative duration', () => {
    const row = waitRailViewModel([wp({ expiresAt: T0 - 1000 })], T0, 'en')?.rows[0];
    expect(row?.ttl).toBe('overdue');
    expect(row?.urgent).toBe(true);
  });

  // ── the three silent failures ───────────────────────────────────────────────

  it('shouts when the wake limit has latched — signals no longer wake the session', () => {
    const vm = waitRailViewModel([wp({ rateLimited: true, wakesLastHour: 12 })], T0, 'en');
    const badges = vm!.rows[0].badges;
    expect(badges[0].key).toBe('rate-limit');
    expect(badges[0].tone).toBe('danger');
    // The quota badge is suppressed: the rate-limit badge already says it louder.
    expect(badges.some((b) => b.key === 'quota')).toBe(false);
  });

  it('surfaces a stuck delivery with its error in the tooltip', () => {
    const vm = waitRailViewModel([wp({ delivery: { pending: true, attempts: 3, lastError: 'conduit closed', lastAt: T0 } })], T0, 'en');
    const badge = vm!.rows[0].badges.find((b) => b.key === 'delivery');
    expect(badge?.text).toBe('delivery retrying · 3 attempts');
    expect(badge?.title).toBe('conduit closed');
  });

  it('does not cry wolf on a first delivery attempt still in flight', () => {
    const vm = waitRailViewModel([wp({ delivery: { pending: true, attempts: 1, lastError: null, lastAt: T0 } })], T0, 'en');
    expect(vm!.rows[0].badges).toEqual([]);
  });

  it('warns as the hourly wake budget runs out', () => {
    expect(waitRailViewModel([wp({ wakesLastHour: 9, wakeLimit: 12 })], T0, 'en')!.rows[0].badges).toEqual([]);
    const near = waitRailViewModel([wp({ wakesLastHour: 10, wakeLimit: 12 })], T0, 'en');
    expect(near!.rows[0].badges[0].text).toBe('10/12 wakes this hour');
  });

  // ── signals ─────────────────────────────────────────────────────────────────

  it('carries the signal log through verbatim, as data', () => {
    const vm = waitRailViewModel([wp({
      signals: [{ at: T0, status: 'progress', member: 'arm2', message: 'epoch 3', source: 'device:cluster' }],
    })], T0, 'en');
    const s = vm!.rows[0].signals[0];
    expect(s.status).toBe('progress');
    expect(s.who).toBe('arm2');
    expect(s.message).toBe('epoch 3');
    expect(s.source).toBe('device:cluster');
  });

  it('names the device a remote signal is expected from', () => {
    const vm = waitRailViewModel([wp({ emitFrom: { kind: 'device', device: 'cluster' } })], T0, 'en');
    expect(vm!.rows[0].device).toBe('cluster');
    expect(waitRailViewModel([wp()], T0, 'en')!.rows[0].device).toBeNull();
  });
});
