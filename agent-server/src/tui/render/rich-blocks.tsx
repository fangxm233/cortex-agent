import React from 'react';
import { Box, Text } from 'ink';
import { InlineMarkdown } from './inline-markdown.js';
import type { RichBlock as RichBlockType } from '../../platform/tui/protocol.js';

interface RichBlocksProps {
  blocks: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

/** Render a RichBlock[] array into Ink elements */
export function RichBlocks({ blocks }: RichBlocksProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <RichBlockItem key={i} block={block} />
      ))}
    </Box>
  );
}

function RichBlockItem({ block }: { block: Record<string, unknown> }): React.JSX.Element | null {
  switch (block.type) {
    case 'markdown':
      return <InlineMarkdown text={String(block.text ?? '')} />;

    case 'section':
      return <InlineMarkdown text={String(block.text ?? '')} />;

    case 'context':
      return <InlineMarkdown text={String(block.text ?? '')} dimColor />;

    case 'divider':
      return <Text dimColor>{'─'.repeat(40)}</Text>;

    case 'actions':
      // Action buttons were never interactive in the TUI (Slack-only). They are
      // replaced by `/` slash commands in the input box, so render nothing here
      // rather than a row of inert `[Resume] [New] [New (quiet)]` labels.
      return null;

    default:
      return <InlineMarkdown text={String((block as any).text ?? '')} />;
  }
}
