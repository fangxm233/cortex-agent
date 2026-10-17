import { describe, expect, it } from 'vitest';
import type { SessionTranscript, TranscriptMessage } from '@cortex-agent/ui-contract';
import {
  assistantTurnCopyTargets, buildTranscriptRows, liveToMessage, regenNoteIndexes, rewindStats,
  type LiveSessionMessage,
} from './transcript-vm';

const ts = '2026-07-07T07:42:00.000Z';
const message = (type: TranscriptMessage['type'], text: string): TranscriptMessage => ({
  type, text, ts, elapsedMs: null, toolName: type === 'tool' ? text : null, toolInput: null,
});
function rows(messages: TranscriptMessage[], tail: LiveSessionMessage[] = []) {
  const transcript: SessionTranscript = { sessionId: 's', turns: [{
    turnIndex: 0, messages,
  }] };
  return buildTranscriptRows(transcript, tail, { running: true }).filter((row) => row.kind !== 'divider');
}

describe('thinking transcript rows', () => {
  it('keeps thinking and assistant previews alongside each other before pending input', () => {
    const built = buildTranscriptRows({ sessionId: 's', turns: [] }, [], {
      thinkingText: 'first\nlatest', streamingText: 'answer', pendingUser: [{ text: 'next', ts }],
    });
    expect(built).toMatchObject([
      { kind: 'thinking', text: 'first\nlatest', preview: true },
      { kind: 'assistant', text: 'answer', preview: true },
      { kind: 'user', text: 'next', pending: true },
    ]);
  });
  it('keeps isolated thinking separate from assistant prose', () => {
    expect(rows([message('thinking', 'consider\nmore'), message('assistant', 'answer')]))
      .toMatchObject([{ kind: 'thinking', text: 'consider\nmore' }, { kind: 'assistant', text: 'answer' }]);
  });

  it.each([
    ['thinking', 'tool', 'thinking', 'tool', 'thinking'],
    ['tool', 'thinking', 'tool'],
    ['thinking', 'tool'],
    ['tool', 'thinking'],
  ] as const)('keeps adjacent thinking/tool entries in order without splitting: %j', (...types) => {
    const built = rows(types.map((type, index) => message(type, `${index}`)));
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ kind: 'tools', count: types.filter((type) => type === 'tool').length });
    if (built[0].kind !== 'tools') throw new Error('Expected tool group');
    expect(built[0].calls.map((call) => call.thinking ? 'thinking' : 'tool')).toEqual(types);
  });

  it('does not split image tool runs with thinking', () => {
    const image = { ...message('tool', 'read'), attachments: [{ type: 'image' as const, name: 'a.png', path: 'a.png', size: 4, mimeType: 'image/png' }] };
    const built = rows([image, message('thinking', 'inspect'), { ...image, toolInput: 'b.png' }]);
    expect(built).toMatchObject([{ kind: 'tools', count: 2, calls: [{}, { thinking: true }, {}] }]);
  });

  it('does not close a legacy running subagent or split its buffered tools', () => {
    const built = rows([
      { ...message('tool', 'Agent'), subagentId: 'child' },
      { ...message('tool', 'read'), subagentId: 'child' },
      message('thinking', 'main consideration'),
      { ...message('tool', 'bash'), subagentId: 'child' },
    ]);
    expect(built[0]).toMatchObject({ kind: 'subagent', status: 'running', toolCount: 2,
      children: [{ kind: 'tools', count: 2 }] });
    const lastThinking = rows([
      { ...message('tool', 'Agent'), subagentId: 'child' }, message('thinking', 'still considering'),
    ]);
    expect(lastThinking[0]).toMatchObject({ kind: 'subagent', status: 'running' });
  });

  it('deduplicates history and live thinking by block identity', () => {
    const live: LiveSessionMessage = { sessionId: 's', role: 'thinking', text: 'consider', blockId: 'b', ts };
    expect(liveToMessage(live)).toMatchObject({ type: 'thinking', text: 'consider', blockId: 'b' });
    expect(rows([{ ...message('thinking', 'consider'), blockId: 'b' }], [{ ...live, ts: '2026-07-07T07:42:01.000Z' }]))
      .toHaveLength(1);
  });

  it('excludes thinking from copy targets, rewind counts and regeneration notes', () => {
    const built = rows([
      { ...message('user', 'edited'), edited: { originalText: 'old', originalTs: ts } },
      message('thinking', 'private'), message('assistant', 'answer'), message('thinking', 'after'),
    ]);
    expect([...assistantTurnCopyTargets(built)]).toEqual([[2, 'answer']]);
    expect(rewindStats(built, 0)).toEqual({ replies: 1, toolCalls: 0 });
    expect([...regenNoteIndexes(built)]).toEqual([2]);
    const grouped = rows([message('user', 'q'), message('tool', 'read'), message('thinking', 'private')]);
    expect(rewindStats(grouped, 0)).toEqual({ replies: 0, toolCalls: 1 });
  });
});
