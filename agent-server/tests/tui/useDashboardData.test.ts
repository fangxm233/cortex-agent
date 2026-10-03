import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  _handleQueryResult, _handleEvent,
  EMPTY_DASH_STATE,
  type TabName,
} from '../../src/tui/hooks/useDashboardData.js';
import type { UiQueryResult, UiEvent } from '../../src/platform/tui/protocol.js';

// ── Fixtures ──

const SCHEDULES_DATA = [
  { id: 's1', type: 'interval', message: 'check status', projectId: 'p1', paused: false, nextRun: '2024-01-01T00:00:00Z' },
];

// ── Helpers ──

function makeQueryResult(tab: string, id: string, data: unknown, ok = true): UiQueryResult {
  if (ok) {
    return { type: 'ui.queryResult', id, ok: true, data } as UiQueryResult;
  }
  return { type: 'ui.queryResult', id, ok: false, error: { code: 'error', message: 'failed' } } as UiQueryResult;
}

function makeUiEvent(subscribeId: string, eventType: string): UiEvent {
  return {
    type: 'ui.event',
    id: subscribeId,
    event: { type: eventType, ts: '2024-01-01T00:00:00Z', payload: {} },
    seq: 1,
  } as UiEvent;
}

// ── Tests ──

test('_handleQueryResult stores data for a tab', () => {
  const state = _handleQueryResult(
    EMPTY_DASH_STATE,
    makeQueryResult('schedules', 'dash-schedules', SCHEDULES_DATA),
  );

  assert.equal(state.tabs.schedules.data.length, 1);
  assert.equal((state.tabs.schedules.data[0] as { id: string }).id, 's1');
  assert.equal(state.tabs.schedules.loading, false);
  assert.equal(state.tabs.schedules.error, null);
  assert.ok(typeof state.tabs.schedules.lastUpdated === 'number');
});

test('_handleQueryResult with error sets error state', () => {
  const state = _handleQueryResult(
    EMPTY_DASH_STATE,
    makeQueryResult('schedules', 'dash-schedules', null, false),
  );

  assert.equal(state.tabs.schedules.loading, false);
  assert.equal(state.tabs.schedules.error, 'failed');
  assert.equal(state.tabs.schedules.data.length, 0);
});

test('_handleQueryResult with non-array (object) data wraps in array', () => {
  const costSummary = { totalCost: 42.5, monthlyCost: 100.0, dailyCost: 5.0, models: { 'gpt-4': 30.0 }, budgetRemaining: 957.5 };
  const state = _handleQueryResult(
    EMPTY_DASH_STATE,
    makeQueryResult('cost', 'dash-cost', costSummary),
  );

  assert.equal(Array.isArray(state.tabs.cost.data), true);
  assert.equal(state.tabs.cost.data.length, 1);
  assert.equal((state.tabs.cost.data[0] as { totalCost: number }).totalCost, 42.5);
  assert.equal(state.tabs.cost.loading, false);
  assert.equal(state.tabs.cost.error, null);
});

test('_handleQueryResult with unknown id is no-op', () => {
  const state = _handleQueryResult(
    EMPTY_DASH_STATE,
    makeQueryResult('schedules', 'unknown-id', SCHEDULES_DATA),
  );

  // State unchanged — no tab matched this query id
  assert.equal(state, EMPTY_DASH_STATE);
});

test('_handleEvent refreshes tab on matching event', () => {
  // Simulate a tab having an active subscription
  const activeSubs = new Map<string, TabName>();
  activeSubs.set('dash-schedules', 'schedules');

  const state = _handleEvent(
    EMPTY_DASH_STATE,
    activeSubs,
    makeUiEvent('dash-schedules', 'scheduler.tick'),
  );

  // The tab should be marked as needing refresh (loading = true or stale flag)
  // For now, events just set loading = true (trigger re-fetch on next render)
  assert.equal(state.tabs.schedules.loading, true);
  assert.equal(state.tabs.schedules.error, null);
});
