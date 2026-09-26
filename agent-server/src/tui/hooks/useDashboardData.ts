import { useState, useCallback } from 'react';
import type { UiQueryResult, UiEvent } from '../../platform/tui/protocol.js';

// ── Types ──

export interface TabData {
  data: unknown[];
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
}

export type TabName = 'threads' | 'tasks' | 'schedules' | 'executions' | 'cost';

export interface DashState {
  tabs: Record<TabName, TabData>;
  pendingQueries: Set<string>; // tab names with in-flight queries
}

const INITIAL_TAB: TabData = { data: [], loading: false, error: null, lastUpdated: null };

export const EMPTY_DASH_STATE: DashState = {
  tabs: {
    threads: { ...INITIAL_TAB },
    tasks: { ...INITIAL_TAB },
    schedules: { ...INITIAL_TAB },
    executions: { ...INITIAL_TAB },
    cost: { ...INITIAL_TAB },
  },
  pendingQueries: new Set(),
};

export const TAB_SCOPES: Record<TabName, { queryId: string; events: string[] }> = {
  threads: { queryId: 'dash-threads', events: ['thread.created', 'thread.completed', 'thread.transitioned', 'thread.failed'] },
  tasks: { queryId: 'dash-tasks', events: ['task.claimed', 'task.unclaimed', 'task.completed', 'task.dispatched', 'task.blocked', 'task.unblocked'] },
  schedules: { queryId: 'dash-schedules', events: ['scheduler.tick'] },
  executions: { queryId: 'dash-executions', events: ['agent.started', 'agent.completed', 'agent.failed', 'agent.superseded'] },
  cost: { queryId: 'dash-cost', events: ['agent.completed'] },
};

// ── Pure state helpers (exported for testing) ──

export function _createPendingQuery(prev: DashState, tab: TabName): DashState {
  const pending = new Set(prev.pendingQueries);
  pending.add(tab);
  return { ...prev, pendingQueries: pending };
}

export function _clearPendingQuery(prev: DashState, tab: TabName): DashState {
  const pending = new Set(prev.pendingQueries);
  pending.delete(tab);
  return { ...prev, pendingQueries: pending };
}

export function _handleQueryResult(
  prev: DashState,
  queryId: string,
  scopes: Record<string, { queryId: string; events: string[] }>,
  frame: UiQueryResult,
): DashState {
  // Only accept frames that echo our query id
  if (frame.id !== queryId) return prev;

  // Find which tab this queryId maps to
  const tabEntry = Object.entries(scopes).find(([, s]) => s.queryId === queryId);
  if (!tabEntry) return prev;

  const tab = tabEntry[0] as TabName;

  if (frame.ok) {
    const data = Array.isArray(frame.data) ? frame.data : (frame.data != null ? [frame.data] : []);
    const tabs = {
      ...prev.tabs,
      [tab]: { data, loading: false, error: null, lastUpdated: Date.now() },
    };
    const pending = new Set(prev.pendingQueries);
    pending.delete(tab);
    return { tabs, pendingQueries: pending };
  } else {
    const tabs = {
      ...prev.tabs,
      [tab]: { data: [], loading: false, error: (frame as any).error?.message ?? 'Unknown error', lastUpdated: null },
    };
    const pending = new Set(prev.pendingQueries);
    pending.delete(tab);
    return { tabs, pendingQueries: pending };
  }
}

export function _handleEvent(
  prev: DashState,
  activeSubscriptions: Map<string, TabName>,
  frame: UiEvent,
): DashState {
  // Find which tab this subscription id maps to
  const tab = activeSubscriptions.get(frame.id);
  if (!tab) return prev;

  // Mark the tab as needing a refresh (set loading to trigger re-fetch)
  const tabs = {
    ...prev.tabs,
    [tab]: { ...prev.tabs[tab], loading: true },
  };
  return { ...prev, tabs };
}

// ── Hook ──

export function useDashboardData(): {
  state: DashState;
  dispatch: (frame: UiQueryResult | UiEvent) => void;
  markPending: (tab: TabName) => void;
  registerSubscription: (queryId: string, tab: TabName) => void;
  unregisterSubscription: (queryId: string) => void;
  activeSubscriptions: Map<string, TabName>;
} {
  const [state, setState] = useState<DashState>(EMPTY_DASH_STATE);
  const [activeSubscriptions] = useState(() => new Map<string, TabName>());

  const dispatch = useCallback((frame: UiQueryResult | UiEvent) => {
    if (frame.type === 'ui.queryResult') {
      setState(prev => _handleQueryResult(prev, frame.id, TAB_SCOPES, frame as UiQueryResult));
    } else if (frame.type === 'ui.event') {
      setState(prev => _handleEvent(prev, activeSubscriptions, frame as UiEvent));
    }
  }, [activeSubscriptions]);

  const markPending = useCallback((tab: TabName) => {
    setState(prev => _createPendingQuery(prev, tab));
  }, []);

  const registerSubscription = useCallback((queryId: string, tab: TabName) => {
    activeSubscriptions.set(queryId, tab);
  }, [activeSubscriptions]);

  const unregisterSubscription = useCallback((queryId: string) => {
    activeSubscriptions.delete(queryId);
  }, [activeSubscriptions]);

  return {
    state,
    dispatch,
    markPending,
    registerSubscription,
    unregisterSubscription,
    activeSubscriptions,
  };
}
