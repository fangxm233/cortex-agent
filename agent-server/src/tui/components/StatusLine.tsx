import React from 'react';
import { Box, Text } from 'ink';
import type { WsState } from '../ws-client.js';
import { t } from '../../core/i18n.js';

interface StatusLineProps {
  connectionState: WsState;
  errorMessage?: string | null;
  projectId?: string | null;
  queuedCount?: number;
  notificationCount?: number;
  /** When true the whole bottom line shows the full shortcut list instead of the hint + badges. */
  showShortcuts?: boolean;
  /** When the dashboard owns the keyboard, the left hint becomes "Ctrl+D to return" (not the
   *  '? for shortcuts' tip), so the input box no longer needs its own intrusive return line. */
  dashboardActive?: boolean;
  /** Whether mouse capture (wheel scroll) is on. When off the mouse is free for text selection. */
  mouseCapture?: boolean;
}

// Memoized (React.memo below): all props are primitives, so App re-renders driven by unrelated
// state (turn-status ticks, drag-selection, toasts) skip reconciling the status bar entirely.
function StatusLineImpl({
  connectionState,
  errorMessage,
  projectId,
  queuedCount = 0,
  notificationCount = 0,
  showShortcuts = false,
  dashboardActive = false,
  mouseCapture = true,
}: StatusLineProps): React.JSX.Element {
  const status = getConnectionStatus(connectionState, errorMessage);
  const color = getStatusColor(connectionState, errorMessage);

  // Shortcuts overlay: the whole bottom line becomes the key list. Any key dismisses it.
  if (showShortcuts) {
    return (
      <Text>
        {status ? <Text color={color}>{status}{' — '}</Text> : null}
        <Text dimColor>{t('tui.status.shortcuts')}</Text>
      </Text>
    );
  }

  return (
    <Box justifyContent="space-between" width="100%" flexShrink={0}>
      <Box>
        {status ? <Text color={color}>{status}{' — '}</Text> : null}
        {dashboardActive
          ? <Text dimColor>{t('tui.status.returnHint')}</Text>
          : <Text dimColor>{t('tui.status.shortcutsHint')}</Text>}
      </Box>
      <Box>
        {!mouseCapture ? <Text color="cyan">{t('tui.status.selectMode')}</Text> : null}
        {projectId ? <Text dimColor>{projectId}</Text> : null}
        {queuedCount > 0 ? <Text color="yellow"> · ⏳ {queuedCount}</Text> : null}
        {notificationCount > 0 ? <Text color="yellow"> · 🔔 {notificationCount}</Text> : null}
      </Box>
    </Box>
  );
}

export const StatusLine = React.memo(StatusLineImpl);

/** Connection status text, or null when connected normally (nothing to show). */
function getConnectionStatus(state: WsState, errorMessage?: string | null): string | null {
  if (errorMessage) return `⚠ ${errorMessage}`;
  if (state === 'reconnecting') return t('tui.status.reconnecting');
  if (state === 'connecting') return t('tui.status.connecting');
  if (state === 'disconnected') return t('tui.status.disconnected');
  return null;
}

function getStatusColor(state: WsState, errorMessage?: string | null): string {
  if (errorMessage) return 'red';
  if (state === 'reconnecting' || state === 'connecting') return 'yellow';
  if (state === 'disconnected') return 'red';
  return 'green';
}
