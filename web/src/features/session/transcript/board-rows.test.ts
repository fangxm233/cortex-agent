import { describe, expect, it } from 'vitest';
import type { SessionTranscript, TranscriptMessage } from '@cortex-agent/ui-contract';
import { boardActionFromResult, boardActionOf } from './board-rows';
import { liveToMessage } from './live-message';
import { assistantTurnCopyTargets, buildTranscriptRows, rewindStats, type ChatRow } from './transcript-vm';

const day = (min: number): string => new Date(Date.UTC(2026, 9, 13, 16, min)).toISOString();
function msg(over: Partial<TranscriptMessage>): TranscriptMessage {
  return { type: 'assistant', text: null, toolName: null, toolInput: null, ts: day(0), elapsedMs: null, ...over };
}
const OPEN = 'mcp__cortex-core__board_open';
const opened = (boardId: string, title: string, created: boolean, min: number) =>
  msg({ type: 'tool', toolName: OPEN, toolInput: `{"title":"${title}"}`, ts: day(min), boardAction: { op: 'open', boardId, title, created } });
const legacy = (content: string, min: number, isError = false) =>
  msg({ type: 'tool', toolName: OPEN, toolInput: '{"board":"x"}', ts: day(min), debug: { toolResult: { content, isError } } });
const tool = (name: string, min: number) => msg({ type: 'tool', toolName: name, toolInput: 'x', ts: day(min) });

function rows(messages: TranscriptMessage[]): ChatRow[] {
  const transcript: SessionTranscript = { sessionId: 's', turns: [{ turnIndex: 0, messages }] };
  return buildTranscriptRows(transcript, [], { now: new Date(day(0)) }).filter((r) => r.kind !== 'divider');
}

describe('boardActionOf', () => {
  it('reads the structured board action the server stamps on the row', () => {
    expect(boardActionOf(opened('b1', 'Survey', true, 1))).toEqual({ boardId: 'b1', title: 'Survey', created: true, ts: day(1) });
    expect(boardActionOf(opened('b1', 'Survey', false, 1))?.created).toBe(false);
  });

  it('falls back to the first line of an older row\'s result', () => {
    const dir = '\nBoard directory: /ctx/boards/survey';
    expect(boardActionFromResult(`Created board "Survey" (b1).${dir}`)).toEqual({ boardId: 'b1', title: 'Survey', created: true });
    expect(boardActionFromResult(`Attached to board "Survey" (b1).${dir}`)).toEqual({ boardId: 'b1', title: 'Survey', created: false });
    expect(boardActionFromResult(`Reopened board "Survey" (b1).${dir}`)).toEqual({ boardId: 'b1', title: 'Survey', created: false });
    expect(boardActionFromResult('Created board "A "quoted" (draft)" (b2).')).toEqual({ boardId: 'b2', title: 'A "quoted" (draft)', created: true });
    expect(boardActionOf(legacy(`Created board "Survey" (b1).${dir}`, 2))).toMatchObject({ boardId: 'b1', created: true });
  });

  it('ignores failed calls, unreadable results, results it cannot see, and other tools', () => {
    expect(boardActionOf(legacy('board_open failed: no board "x"', 2, true))).toBeNull();
    expect(boardActionOf(legacy('something else', 2))).toBeNull();
    expect(boardActionOf(msg({ type: 'tool', toolName: OPEN, toolInput: '{"title":"x"}' }))).toBeNull();
    expect(boardActionOf(tool('Read', 1))).toBeNull();
  });
});

describe('board rows in the chat', () => {
  it('lifts a board_open call out of the tool run into a row of its own', () => {
    const list = rows([msg({ type: 'user', text: 'go', ts: day(0) }), tool('Read', 1), opened('b1', 'Survey', true, 2), tool('Bash', 3), tool('Bash', 4)]);
    expect(list.map((r) => r.kind)).toEqual(['user', 'tools', 'board-action', 'tools']);
    expect(list[2]).toEqual({ kind: 'board-action', action: { boardId: 'b1', title: 'Survey', created: true, ts: day(2) } });
    expect((list[3] as Extract<ChatRow, { kind: 'tools' }>).count).toBe(2);
  });

  it('counts as a tool call for a rewind and carries the turn\'s copy when it ends the turn', () => {
    const list = rows([msg({ type: 'user', text: 'go', ts: day(0) }), msg({ type: 'assistant', text: 'Opening.', ts: day(1) }), opened('b1', 'Survey', false, 2)]);
    expect(rewindStats(list, 0)).toEqual({ replies: 1, toolCalls: 1 });
    expect(assistantTurnCopyTargets(list).get(2)).toBe('Opening.');
  });

  it('keeps the board action on a live row', () => {
    const live = liveToMessage({ sessionId: 's', role: 'tool', text: '', toolName: OPEN, toolInput: '{}', ts: day(5),
      boardAction: { op: 'open', boardId: 'b9', title: 'Live', created: true } });
    expect(boardActionOf(live)).toMatchObject({ boardId: 'b9', created: true });
  });
});
