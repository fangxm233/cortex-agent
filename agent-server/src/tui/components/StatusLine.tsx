import React from 'react';
import { Box, Text } from 'ink';
import type { WsState } from '../ws-client.js';

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

/** Full keyboard-shortcut list, revealed by typing '?' on an empty input. */
const SHORTCUTS =
  'Ctrl+D Dashboard · Ctrl+N Notifications · Ctrl+P Projects · Ctrl+L Clear · '
  + '↑/↓ History · PgUp/PgDn Scroll · Ctrl+T Text-select mode (stops wheel) · Ctrl+C Cancel (×2 Exit) · / Commands';

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
        <Text dimColor>{SHORTCUTS}</Text>
      </Text>
    );
  }

  return (
    <Box justifyContent="space-between" width="100%" flexShrink={0}>
      <Box>
        {status ? <Text color={color}>{status}{' — '}</Text> : null}
        {dashboardActive
          ? <Text dimColor>Press Ctrl+D to return to the input</Text>
          : <Text dimColor>? for shortcuts</Text>}
      </Box>
      <Box>
        {!mouseCapture ? <Text color="cyan">🖱 select · </Text> : null}
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
  if (state === 'reconnecting') return '⟳ Reconnecting...';
  if (state === 'connecting') return '⟳ Connecting...';
  if (state === 'disconnected') return '○ Disconnected — press R to retry, Ctrl+C to exit';
  return null;
}

function getStatusColor(state: WsState, errorMessage?: string | null): string {
  if (errorMessage) return 'red';
  if (state === 'reconnecting' || state === 'connecting') return 'yellow';
  if (state === 'disconnected') return 'red';
  return 'green';
}
