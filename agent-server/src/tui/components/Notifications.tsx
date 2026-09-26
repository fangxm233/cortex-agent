import React, { useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { NotificationEntry } from '../hooks/useNotifications.js';

interface NotificationsProps {
  open: boolean;
  unreadCount: number;
  notifications: Map<string, NotificationEntry>;
  ids: string[];
  onMarkRead: (id: string) => void;
  onClose: () => void;
  /** Called when user selects a notification from detail view. Triggers session switch. */
  onSelect?: (notif: NotificationEntry) => void;
}

export function NotificationsBadge({ unreadCount }: { unreadCount: number }): React.JSX.Element | null {
  if (unreadCount === 0) return null;
  return <Text color="yellow">🔔 {unreadCount}</Text>;
}

export function NotificationsModal({
  open,
  notifications,
  ids,
  onMarkRead,
  onClose,
  onSelect,
}: Omit<NotificationsProps, 'unreadCount'> & { open: boolean }): React.JSX.Element | null {
  const [selectedIdx, setSelectedIdx] = React.useState(0);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);

  // Reset selection when modal opens
  React.useEffect(() => {
    if (open) {
      setSelectedIdx(0);
      setFocusedId(null);
    }
  }, [open]);

  useInput((input, key) => {
    if (!open) return;

    // Re-pressing the toggle hotkey (Ctrl+N) closes the panel, same as Esc.
    if (input === 'n' && key.ctrl) {
      onClose();
      return;
    }

    if (key.escape) {
      if (focusedId) {
        setFocusedId(null); // Back to list
      } else {
        onClose();
      }
      return;
    }

    if (key.upArrow && !focusedId) {
      setSelectedIdx(prev => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow && !focusedId) {
      setSelectedIdx(prev => Math.min(ids.length - 1, prev + 1));
      return;
    }

    if (key.return) {
      if (focusedId) {
        const selected = notifications.get(focusedId);
        if (selected && onSelect) {
          onSelect(selected);
        }
        onMarkRead(focusedId);
        setFocusedId(null);
      } else if (ids.length > 0) {
        const selected = ids[selectedIdx];
        if (selected) {
          setFocusedId(selected);
        }
      }
      return;
    }
  });

  if (!open) return null;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold>Notifications</Text>
      <Box flexDirection="column" marginTop={1}>
        {ids.length === 0 ? (
          <Text dimColor>No notifications</Text>
        ) : (
          ids.map((id, i) => {
            const notif = notifications.get(id);
            if (!notif) return null;

            if (focusedId === id) {
              // Detail view
              return (
                <Box key={id} flexDirection="column" marginBottom={1} borderStyle="single" paddingX={1}>
                  <Text bold>{notif.title}</Text>
                  <Text dimColor>{notif.kind} | {new Date(notif.ts).toLocaleTimeString()}</Text>
                  <Text>{notif.body}</Text>
                  <Text dimColor>— Press Enter to mark read, Esc to go back</Text>
                </Box>
              );
            }

            return (
              <Box key={id} marginBottom={0}>
                <Text>{i === selectedIdx ? '▶' : ' '}</Text>
                <Text> </Text>
                <Text dimColor={notif.read}>{notif.read ? '✓' : '○'}</Text>
                <Text> </Text>
                <Text bold={!notif.read} dimColor={notif.read}>
                  {String(notif.title).slice(0, 30)}{notif.title.length > 30 ? '…' : ''}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate · Enter detail · Ctrl+N/Esc close</Text>
      </Box>
    </Box>
  );
}
