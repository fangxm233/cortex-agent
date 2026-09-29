import React from 'react';
import { Box } from 'ink';
import { Dashboard } from './Dashboard.js';
import type { DashState } from '../hooks/useDashboardData.js';
import type { MutateResult } from '../hooks/useMutate.js';

interface SidePanelProps {
  /** Whether the dashboard currently owns the keyboard (focus zone === 'dashboard'). */
  active: boolean;
  sendFrame: (frame: any) => void;
  projectId: string | null;
  dashState: DashState;
  onRegisterSubscription: (queryId: string, tab: string) => void;
  onUnregisterSubscription: (queryId: string) => void;
  activeTab: string;
  onSetActiveTab: (tab: string) => void;
  onMutate?: (op: string, args: Record<string, unknown>) => Promise<MutateResult>;
  /** Close the panel (Esc while the dashboard owns the keyboard). */
  onClose?: () => void;
}

export function SidePanel({
  active,
  sendFrame,
  projectId,
  dashState,
  onRegisterSubscription,
  onUnregisterSubscription,
  activeTab,
  onSetActiveTab,
  onMutate,
  onClose,
}: SidePanelProps): React.JSX.Element {
  // No marginLeft: the parent row centers this panel horizontally (App.tsx wraps the row in
  // justifyContent="center"). Width stays fixed so the dashboard reads as a centered card.
  return (
    <Box width={44} borderStyle="single" borderDimColor flexShrink={0}>
      <Dashboard
        active={active}
        sendFrame={sendFrame}
        projectId={projectId}
        dashState={dashState}
        onRegisterSubscription={onRegisterSubscription}
        onUnregisterSubscription={onUnregisterSubscription}
        activeTab={activeTab}
        onSetActiveTab={onSetActiveTab}
        mutate={onMutate}
        onClose={onClose}
      />
    </Box>
  );
}
