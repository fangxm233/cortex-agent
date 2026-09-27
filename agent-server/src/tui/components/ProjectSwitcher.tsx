import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { t } from '../../core/i18n.js';

export interface ProjectEntry {
  id: string;
  kind?: string;
  contextDir?: string;
  hasMission?: boolean;
}

interface ProjectSwitcherProps {
  open: boolean;
  projects: ProjectEntry[];
  loading: boolean;
  error: string | null;
  onSelect: (projectId: string) => void;
  onClose: () => void;
  onRequestRefresh: () => void;
}

export function ProjectSwitcher({
  open,
  projects,
  loading,
  error,
  onSelect,
  onClose,
  onRequestRefresh,
}: ProjectSwitcherProps): React.JSX.Element | null {
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Reset selection when modal opens
  useEffect(() => {
    if (open) {
      setSelectedIdx(0);
      onRequestRefresh();
    }
  }, [open, onRequestRefresh]);

  useInput((input, key) => {
    if (!open) return;

    // Re-pressing the toggle hotkey (Ctrl+P) closes the panel, same as Esc.
    if (input === 'p' && key.ctrl) {
      onClose();
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }

    if (key.upArrow) {
      setSelectedIdx(prev => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIdx(prev => Math.min(projects.length - 1, prev + 1));
      return;
    }

    if (key.return && projects.length > 0) {
      const selected = projects[selectedIdx];
      if (selected) {
        onSelect(selected.id);
        onClose();
      }
      return;
    }
  });

  if (!open) return null;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold>{t('tui.projects.title')}</Text>

      {loading ? (
        <Text dimColor>{t('tui.projects.loading')}</Text>
      ) : error ? (
        <Text color="red">{t('tui.common.error', { message: error })}</Text>
      ) : projects.length === 0 ? (
        <Text dimColor>{t('tui.projects.empty')}</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {projects.map((proj, i) => (
            <Box key={proj.id} marginBottom={0}>
              <Text>{i === selectedIdx ? '▶' : ' '}</Text>
              <Text> </Text>
              <Text bold={i === selectedIdx}>{proj.id}</Text>
              {proj.kind ? <Text dimColor> ({proj.kind})</Text> : null}
              {proj.hasMission ? <Text color="green"> ★</Text> : null}
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>{t('tui.projects.hint')}</Text>
      </Box>
    </Box>
  );
}
