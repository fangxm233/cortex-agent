// input:  src/tui/hooks/useDashboardData.js (pure state helpers)
// output: Tests — query/render/subscribe/unsubscribe lifecycle
// pos:    Verifies dashboard data management for each tab

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  _handleQueryResult, _handleEvent,
  _createPendingQuery, _clearPendingQuery,
  EMPTY_DASH_STATE, TAB_SCOPES,
  type TabName,
} from '../../src/tui/hooks/useDashboardData.js';
import type { UiQueryResult, UiEvent } from '../../src/platform/tui/protocol.js';

// ── Fixtures ──

const THREADS_DATA = [
  { id: 't1', templateName: 'test', status: 'running', projectId: 'p1', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z', currentStep: null, totalSteps: 0, artifactPath: null },
];

const TASKS_DATA = [
  { id: 'task1', text: 'Do something', project: 'p1', status: 'open', priority: 'high', actionable: true, claimedBy: null, blockedBy: null, dependsOn: [], plan: null, template: 'default' },
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
    'dash-threads',
    TAB_SCOPES,
    makeQueryResult('threads', 'dash-threads', THREADS_DATA),
  );

  assert.equal(state.tabs.threads.data.length, 1);
  assert.equal((state.tabs.threads.data[0] as { id: string }).id, 't1');
  assert.equal(state.tabs.threads.loading, false);
  assert.equal(state.tabs.threads.error, null);
  assert.ok(typeof state.tabs.threads.lastUpdated === 'number');
});

test('_handleQueryResult with error sets error state', () => {
  const state = _handleQueryResult(
    EMPTY_DASH_STATE,
    'dash-threads',
    TAB_SCOPES,
    makeQueryResult('threads', 'dash-threads', null, false),
  );

  assert.equal(state.tabs.threads.loading, false);
  assert.equal(state.tabs.threads.error, 'failed');
  assert.equal(state.tabs.threads.data.length, 0);
});

test('_handleQueryResult with non-array (object) data wraps in array', () => {
  const costSummary = { totalCost: 42.5, monthlyCost: 100.0, dailyCost: 5.0, models: { 'gpt-4': 30.0 }, budgetRemaining: 957.5 };
  const state = _handleQueryResult(
    EMPTY_DASH_STATE,
    'dash-cost',
    TAB_SCOPES,
    makeQueryResult('cost', 'dash-cost', costSummary),
  );

  assert.equal(Array.isArray(state.tabs.cost.data), true);
  assert.equal(state.tabs.cost.data.length, 1);
  assert.equal((state.tabs.cost.data[0] as { totalCost: number }).totalCost, 42.5);
  assert.equal(state.tabs.cost.loading, false);
  assert.equal(state.tabs.cost.error, null);
});

test('_handleQueryResult with null data produces empty array', () => {
  const state = _handleQueryResult(
    EMPTY_DASH_STATE,
    'dash-threads',
    TAB_SCOPES,
    makeQueryResult('threads', 'dash-threads', null),
  );

  assert.equal(Array.isArray(state.tabs.threads.data), true);
  assert.equal(state.tabs.threads.data.length, 0);
});

test('_handleQueryResult with unknown id is no-op', () => {
  const state = _handleQueryResult(
    EMPTY_DASH_STATE,
    'dash-threads',
    TAB_SCOPES,
    makeQueryResult('threads', 'unknown-id', THREADS_DATA),
  );

  // State unchanged — no tab matched this query id
  assert.equal(state.tabs.threads.data.length, 0);
});

test('_handleEvent refreshes tab on matching event', () => {
  // Simulate a tab having an active subscription
  const activeSubs = new Map<string, TabName>();
  activeSubs.set('dash-threads', 'threads');

  const state = _handleEvent(
    EMPTY_DASH_STATE,
    activeSubs,
    makeUiEvent('dash-threads', 'thread.created'),
  );

  // The tab should be marked as needing refresh (loading = true or stale flag)
  // For now, events just set loading = true (trigger re-fetch on next render)
  assert.equal(state.tabs.threads.loading, true);
  assert.equal(state.tabs.threads.error, null);
});

test('_handleEvent with unknown subscription id is no-op', () => {
  const activeSubs = new Map<string, TabName>();
  activeSubs.set('dash-threads', 'threads');

  const state = _handleEvent(
    EMPTY_DASH_STATE,
    activeSubs,
    makeUiEvent('dash-unknown', 'thread.created'),
  );

  // No tab should be affected
  assert.equal(state.tabs.threads.loading, false);
});

test('_createPendingQuery and _clearPendingQuery manage pending state', () => {
  let state = EMPTY_DASH_STATE;

  // Create pending query for threads
  state = _createPendingQuery(state, 'threads');
  assert.equal(state.pendingQueries.has('threads'), true);

  // Create pending for tasks
  state = _createPendingQuery(state, 'tasks');
  assert.equal(state.pendingQueries.has('tasks'), true);
  assert.equal(state.pendingQueries.has('threads'), true);

  // Clear threads
  state = _clearPendingQuery(state, 'threads');
  assert.equal(state.pendingQueries.has('threads'), false);
  assert.equal(state.pendingQueries.has('tasks'), true);
});
