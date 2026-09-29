import React, { useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { NotificationEntry } from '../hooks/useNotifications.js';
import { t } from '../../core/i18n.js';

interface NotificationsProps {
  notifications: Map<string, NotificationEntry>;
  ids: string[];
  onMarkRead: (id: string) => void;
  onClose: () => void;
  /** Called when user selects a notification from detail view. Triggers session switch. */
  onSelect?: (notif: NotificationEntry) => void;
}

export function NotificationsModal({
  notifications,
  ids,
  onMarkRead,
  onClose,
  onSelect,
}: NotificationsProps): React.JSX.Element {
  const [selectedIdx, setSelectedIdx] = React.useState(0);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);

  useInput((input, key) => {
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

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold>{t('tui.notif.title')}</Text>
      <Box flexDirection="column" marginTop={1}>
        {ids.length === 0 ? (
          <Text dimColor>{t('tui.notif.empty')}</Text>
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
                  <Text dimColor>{t('tui.notif.detailHint')}</Text>
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
        <Text dimColor>{t('tui.notif.hint')}</Text>
      </Box>
    </Box>
  );
}
