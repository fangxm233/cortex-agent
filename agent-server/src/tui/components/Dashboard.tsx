import React, { useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { TAB_SCOPES } from '../hooks/useDashboardData.js';
import type { TabName, DashState } from '../hooks/useDashboardData.js';
import { DashboardThreadsTab } from './DashboardThreadsTab.js';
import { DashboardTasksTab } from './DashboardTasksTab.js';
import { DashboardSchedulesTab } from './DashboardSchedulesTab.js';
import { DashboardExecutionsTab } from './DashboardExecutionsTab.js';
import { DashboardCostTab } from './DashboardCostTab.js';
import type { MutateResult } from '../hooks/useMutate.js';
import { t } from '../../core/i18n.js';

// ── Types ──

export interface DashboardTabInfo {
  key: TabName;
  label: string;
}

// Labels are getters so the tab bar follows the active locale (not the one at module load).
function tab(key: TabName): DashboardTabInfo {
  return { key, get label() { return t(`tui.dash.tab.${key}`); } };
}

export const DASHBOARD_TABS: DashboardTabInfo[] = [
  tab('threads'),
  tab('tasks'),
  tab('schedules'),
  tab('executions'),
  tab('cost'),
];

interface DashboardProps {
  /** Whether the dashboard owns the keyboard (focus zone === 'dashboard'). */
  active: boolean;
  sendFrame: (frame: any) => void;
  mutate?: (op: string, args: Record<string, unknown>) => Promise<MutateResult>;
  projectId: string | null;
  dashState: DashState;
  onMarkPending: (tab: string) => void;
  onRegisterSubscription: (queryId: string, tab: string) => void;
  onUnregisterSubscription: (queryId: string) => void;
  activeTab: string;
  onSetActiveTab: (tab: string) => void;
  /** Close the panel (Esc while the dashboard owns the keyboard, mirrors the Ctrl+D toggle). */
  onClose?: () => void;
}

// ── Tab content renderer ──

function TabContent({
  tab,
  active,
  sendFrame,
  mutate,
  projectId,
  dashState,
  onMarkPending,
  onRegisterSubscription,
  onUnregisterSubscription,
}: {
  tab: TabName;
  active: boolean;
  sendFrame: (frame: any) => void;
  mutate?: (op: string, args: Record<string, unknown>) => Promise<MutateResult>;
  projectId: string | null;
  dashState: DashState;
  onMarkPending: (tab: string) => void;
  onRegisterSubscription: (queryId: string, tab: string) => void;
  onUnregisterSubscription: (queryId: string) => void;
}): React.JSX.Element {
  const initialQuerySent = useRef(false);

  // The parent (App) hands us fresh callback / sendFrame identities on every render.
  // Holding them in refs lets the query/subscribe effect depend only on
  // [tab, projectId], so it never re-fires (and re-subscribes) merely because the
  // parent re-rendered. Without this the effect cleaned up + re-ran every render,
  // each run calling onMarkPending → setState → re-render → infinite loop (the
  // Ctrl+D render storm that pegged a CPU core at ~95% with "Maximum update depth
  // exceeded").
  const sendFrameRef = useRef(sendFrame);
  sendFrameRef.current = sendFrame;
  const onMarkPendingRef = useRef(onMarkPending);
  onMarkPendingRef.current = onMarkPending;
  const onRegisterSubscriptionRef = useRef(onRegisterSubscription);
  onRegisterSubscriptionRef.current = onRegisterSubscription;
  const onUnregisterSubscriptionRef = useRef(onUnregisterSubscription);
  onUnregisterSubscriptionRef.current = onUnregisterSubscription;

  // Initial query + subscribe (runs once per tab mount)
  React.useEffect(() => {
    const scope = TAB_SCOPES[tab];
    if (!scope) return;

    const queryId = scope.queryId;

    if (!initialQuerySent.current) {
      initialQuerySent.current = true;

      // Send query for initial data
      sendFrameRef.current({ type: 'ui.query', id: queryId, scope: tab === 'cost' ? 'cost.summary' : `${tab}.list`, params: projectId ? { projectId } : {} });
      onMarkPendingRef.current(tab);

      // Subscribe to events
      sendFrameRef.current({ type: 'ui.subscribe', id: queryId, filter: { events: scope.events, projectId } });
      onRegisterSubscriptionRef.current(queryId, tab);
    }

    // Cleanup on unmount
    return () => {
      sendFrameRef.current({ type: 'ui.unsubscribe', id: queryId });
      onUnregisterSubscriptionRef.current(queryId);
      initialQuerySent.current = false;
    };
  }, [tab, projectId]);

  // Re-fetch when loading is triggered by a subscription event
  React.useEffect(() => {
    const scope = TAB_SCOPES[tab];
    if (!scope || !initialQuerySent.current) return;

    if (dashState.tabs[tab].loading) {
      sendFrameRef.current({ type: 'ui.query', id: scope.queryId, scope: tab === 'cost' ? 'cost.summary' : `${tab}.list`, params: projectId ? { projectId } : {} });
      onMarkPendingRef.current(tab);
    }
  }, [dashState.tabs[tab].loading, tab, projectId]);

  switch (tab) {
    case 'threads':
      return <DashboardThreadsTab data={dashState.tabs.threads} mutate={mutate} active={active} />;
    case 'tasks':
      return <DashboardTasksTab data={dashState.tabs.tasks} mutate={mutate} projectId={projectId ?? undefined} active={active} />;
    case 'schedules':
      return <DashboardSchedulesTab data={dashState.tabs.schedules} mutate={mutate!} active={active} />;
    case 'executions':
      return <DashboardExecutionsTab data={dashState.tabs.executions} mutate={mutate} active={active} />;
    case 'cost':
      return <DashboardCostTab data={dashState.tabs.cost} />;
    default:
      return <Text dimColor>{t('tui.dash.unknownTab')}</Text>;
  }
}

// ── Component ──

export function Dashboard({
  active,
  sendFrame,
  mutate,
  projectId,
  dashState,
  onMarkPending,
  onRegisterSubscription,
  onUnregisterSubscription,
  activeTab,
  onSetActiveTab,
  onClose,
}: DashboardProps): React.JSX.Element {
  useInput((_input, key) => {
    if (key.escape) {
      onClose?.();
      return;
    }
    if (key.tab) {
      const currentIdx = DASHBOARD_TABS.findIndex(t => t.key === activeTab);
      const nextIdx = (currentIdx + 1) % DASHBOARD_TABS.length;
      onSetActiveTab(DASHBOARD_TABS[nextIdx].key);
    }
  }, { isActive: active });

  return (
    <Box flexDirection="column" width="100%">
      {/* Tab bar — single compact line. Per-tab borders overflowed the 40-wide
          side panel and wrapped labels into unreadable fragments ("Execu/tions");
          render plain labels separated by spaces, active tab in reverse video. */}
      <Box>
        {DASHBOARD_TABS.map((t, i) => (
          <React.Fragment key={t.key}>
            {i > 0 ? <Text dimColor> </Text> : null}
            <Text bold={t.key === activeTab} inverse={t.key === activeTab}>{t.label}</Text>
          </React.Fragment>
        ))}
      </Box>

      {/* Tab content */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <TabContent
          tab={activeTab as TabName}
          active={active}
          sendFrame={sendFrame}
          mutate={mutate}
          projectId={projectId}
          dashState={dashState}
          onMarkPending={onMarkPending}
          onRegisterSubscription={onRegisterSubscription}
          onUnregisterSubscription={onUnregisterSubscription}
        />
      </Box>
    </Box>
  );
}
