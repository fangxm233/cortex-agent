// input:  protocol types + ports types
// output: buildTranscriptReplay — pure synchronous formatter, TranscriptData → TranscriptReplay | null
// pos:    TUI adapter — replays prior chat messages as TranscriptReplay frames
//         ZERO @store/@domain/@orch imports (see ports.ts for boundary types)

import type {
  ChatPost,
  ChatUpdate,
  InteractivePost,
  TranscriptReplay,
} from '../../tui/protocol.js';
import type { MessageRef } from '../../types.js';
import type { TranscriptData } from './ports.js';

/**
 * Build a TranscriptReplay frame from transcript data.
 * Pure synchronous formatter — no store/IO dependencies.
 * Returns null when there are no replayable items.
 */
export function buildTranscriptReplay(
  data: TranscriptData,
): TranscriptReplay | null {
  const { sessionId, messages } = data;

  const items: Array<ChatPost | ChatUpdate | InteractivePost> = [];
  let seq = 0;

  messages.forEach((msg, i) => {
    const ref: MessageRef = {
      conduit: sessionId,
      messageId: `${sessionId}-${i}`,
      threadId: null,
    };
    if (msg.role === 'tool') {
      // Tool calls render as a dim context line, mirroring the live display. Lead with a space so
      // the `·` marker is indented one column instead of sitting flush against the left edge.
      const label = msg.toolName ? ` · ${msg.toolName}${msg.toolInput ? `  ${msg.toolInput}` : ''}` : ' · tool';
      items.push({ type: 'chat.post', ref, content: { text: '', richBlocks: [{ type: 'context', text: label }] as any }, seq: ++seq });
    } else if (msg.role === 'user') {
      items.push({ type: 'chat.post', ref, content: { text: `**You:** ${msg.text}` }, seq: ++seq });
    } else {
      items.push({ type: 'chat.post', ref, content: { text: msg.text }, seq: ++seq });
    }
  });

  if (items.length === 0) return null;

  return {
    type: 'transcript.replay',
    sessionId,
    items,
    seqStart: 1,
    seqEnd: seq,
    isCatchUp: true,
  };
}
