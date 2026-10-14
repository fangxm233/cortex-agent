import type { TranscriptMessage } from '@cortex-agent/ui-contract';

// A board_open call in the chat: it leaves the tool-chip run and becomes a row of its own — a card
// for a board the call created, one line for a board it attached to. The server stamps the row with
// `boardAction`; history written before that field carries only the call's result, which reaches
// the client only when the server runs with debugging on, so older rows are recognised when they
// can be and otherwise stay ordinary tool calls.

export interface BoardActionView {
  boardId: string;
  /** The title the call reported; the live title wins once the board loads. */
  title: string;
  /** True when the call created the board; false when it attached to an existing one. */
  created: boolean;
  ts: string | null;
}

export type BoardActionRow = { kind: 'board-action'; action: BoardActionView };

/** Whether a tool call is `board_open`, whatever server prefix the backend put on it. */
export function isBoardOpenTool(toolName: string | null | undefined): boolean {
  return (toolName?.split('__').at(-1)?.split('.').at(-1) ?? '') === 'board_open';
}

// The first line of a board_open result: `Created board "<title>" (<id>).`, `Attached to board …`,
// or the `Reopened board …` older servers wrote. The title runs to the last `" (<id>).`.
const HEADLINE = /^(Created|Attached to|Reopened) board "(.*)" \(([^\s()]+)\)\.\s*$/;

/** The board a result reports, from its first line; null when it is not a board_open headline. */
export function boardActionFromResult(content: string): Omit<BoardActionView, 'ts'> | null {
  const match = HEADLINE.exec(content.split('\n', 1)[0] ?? '');
  if (!match) return null;
  return { boardId: match[3]!, title: match[2]!, created: match[1] === 'Created' };
}

/** What a board_open tool row did; null for every other row and for a failed call. */
export function boardActionOf(m: TranscriptMessage): BoardActionView | null {
  if (m.type !== 'tool') return null;
  const ts = m.ts ?? null;
  const b = m.boardAction;
  if (b) return { boardId: b.boardId, title: b.title, created: b.created, ts };
  if (!isBoardOpenTool(m.toolName)) return null;
  const result = m.debug?.toolResult;
  if (!result || result.isError) return null;
  const parsed = boardActionFromResult(result.content);
  return parsed ? { ...parsed, ts } : null;
}
