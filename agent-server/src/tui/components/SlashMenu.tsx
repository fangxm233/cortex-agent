import React from 'react';
import { Box, Text } from 'ink';
import type { SlashCommand } from '../slash-commands.js';
import { t } from '../../core/i18n.js';

interface SlashMenuProps {
  commands: SlashCommand[];
  selectedIndex: number;
}

export function SlashMenu({ commands, selectedIndex }: SlashMenuProps): React.JSX.Element {
  if (commands.length === 0) {
    return (
      <Box borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor>{t('tui.slashMenu.noMatch')}</Text>
      </Box>
    );
  }
  // Pad the command column so descriptions line up.
  const width = Math.max(...commands.map(c => c.name.length)) + 1;
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      {commands.map((c, i) => {
        const focused = i === selectedIndex;
        const label = `/${c.name}`.padEnd(width + 1);
        return (
          <Box key={c.name}>
            <Text color={focused ? 'cyan' : undefined}>{focused ? '▸ ' : '  '}</Text>
            <Text color={focused ? 'cyan' : undefined} bold={focused}>{label}</Text>
            <Text dimColor>{c.description}</Text>
          </Box>
        );
      })}
      <Box marginTop={0}>
        <Text dimColor>{t('tui.slashMenu.hint')}</Text>
      </Box>
    </Box>
  );
}
