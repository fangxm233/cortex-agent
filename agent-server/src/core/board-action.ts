// Board vocabulary shared by the board_open tool, the transcript and the live event stream: what a
// board_open call did, carried on its tool row so the chat can show it as a board card.

/** What a successful `board_open` call did, carried by its tool row (any tool-name prefix). */
export interface BoardActionRef {
  op: 'open';
  boardId: string;
  title: string;
  /** True when the call created the board; false when it attached to an existing one. */
  created: boolean;
}

/** Whether a tool call is `board_open`, whatever server prefix the backend put on it. */
export function isBoardOpenTool(toolName: string): boolean {
  const raw = toolName.split('__').at(-1)?.split('.').at(-1) ?? toolName;
  return raw === 'board_open';
}

const CREATED = 'Created';
const ATTACHED = 'Attached to';

/** The first line of a successful board_open result. Its shape is what
 *  {@link boardActionFromToolResult} reads back, so the two live together. */
export function boardOpenedHeadline(board: { id: string; title: string; created: boolean }): string {
  return `${board.created ? CREATED : ATTACHED} board "${board.title}" (${board.id}).`;
}

// The headline, then the directory line that always follows it. The title is matched greedily up to
// the last `" (<id>).` before that line, so a title holding quotes or parentheses still parses.
const HEADLINE = new RegExp(`^(${CREATED}|${ATTACHED}) board "([\\s\\S]*)" \\(([^\\s()]+)\\)\\.\\nBoard directory: `);

/** The board action a successful board_open result reports, or null when the text is not one. */
export function boardActionFromToolResult(content: string): BoardActionRef | null {
  const match = HEADLINE.exec(content);
  if (!match) return null;
  return { op: 'open', boardId: match[3], title: match[2], created: match[1] === CREATED };
}
