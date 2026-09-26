import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { computeFocusWindow } from '../logic.js';

/** Max session rows shown at once — the list is windowed around the selection so a long
 *  session history can't overflow the terminal (Ink can't clear rows scrolled past the
 *  top, which left permanent ghost rows and hid the header/nav hint). */
const PICKER_MAX_VISIBLE = 12;

export interface ResumableSession {
  sessionId: string;
  name: string;
  projectId: string;
  label: string | null;
}

interface SessionPickerProps {
  sessions: ResumableSession[];
  onSelect: (sessionId: string, projectId: string) => void;
  onCancel: () => void;
}

export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps): React.JSX.Element {
  const [selectedIdx, setSelectedIdx] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.upArrow) {
      setSelectedIdx(prev => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIdx(prev => Math.min(sessions.length - 1, prev + 1));
      return;
    }

    if (key.return) {
      const selected = sessions[selectedIdx];
      if (selected) {
        onSelect(selected.sessionId, selected.projectId);
      }
      return;
    }
  });

  if (sessions.length === 0) {
    return <Text dimColor>No resumable sessions</Text>;
  }

  const { start, end, hiddenAbove, hiddenBelow } = computeFocusWindow(
    sessions.length, selectedIdx, PICKER_MAX_VISIBLE,
  );

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Select a session to resume ({sessions.length}):</Text>
      <Box flexDirection="column" marginTop={1}>
        {hiddenAbove > 0 ? <Text dimColor>  ↑ {hiddenAbove} more above</Text> : null}
        {sessions.slice(start, end).map((s, vi) => {
          const i = start + vi;
          return (
            <Box key={s.sessionId} marginBottom={0}>
              <Text>{i === selectedIdx ? '▶' : ' '}</Text>
              <Text> </Text>
              <Text bold={i === selectedIdx}>{s.name}</Text>
              <Text dimColor> ({s.projectId})</Text>
              {s.label ? <Text dimColor> — {s.label}</Text> : null}
            </Box>
          );
        })}
        {hiddenBelow > 0 ? <Text dimColor>  ↓ {hiddenBelow} more below</Text> : null}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate · Enter resume · Esc fresh session</Text>
      </Box>
    </Box>
  );
}
