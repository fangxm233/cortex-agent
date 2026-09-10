// input:  cached transcripts and delta responses
// output: merge, truncate and bail-out regressions
// pos:    Client transcript-delta specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import type { SessionTranscript, TranscriptMessage } from '@cortex-agent/ui-contract';
import { flattenTurns, groupRows, mergeTranscriptDelta } from './transcript-delta';

function message(text: string): TranscriptMessage {
  return { type: 'assistant', text, toolName: null, toolInput: null, ts: '2026-09-09T00:00:00.000Z', elapsedMs: null };
}

const cached: SessionTranscript = {
  sessionId: 's1',
  cursor: 'e1:2',
  turns: [
    { turnIndex: 0, messages: [message('one'), message('answer one')] },
    { turnIndex: 1, messages: [message('two')] },
  ],
};

describe('transcript delta merge', () => {
  it('returns a whole response untouched', () => {
    const whole: SessionTranscript = { sessionId: 's1', turns: [{ turnIndex: 0, messages: [message('fresh')] }], cursor: 'e1:9' };
    expect(mergeTranscriptDelta(cached, whole)).toBe(whole);
  });

  it('overwrites a changed row and appends a new one, keeping turn grouping', () => {
    const merged = mergeTranscriptDelta(cached, {
      sessionId: 's1',
      turns: [],
      cursor: 'e1:5',
      delta: {
        total: 4,
        changed: [
          { index: 1, turnIndex: 0, message: message('answer one, expanded') },
          { index: 3, turnIndex: 1, message: message('answer two') },
        ],
      },
    });
    expect(merged!.turns.map((turn) => [turn.turnIndex, turn.messages.map((m) => m.text)])).toEqual([
      [0, ['one', 'answer one, expanded']],
      [1, ['two', 'answer two']],
    ]);
    expect(merged!.cursor).toBe('e1:5');
    expect(merged!.delta).toBeUndefined();
  });

  it('drops rows past the reported total, which is how a rewind shortens the transcript', () => {
    const merged = mergeTranscriptDelta(cached, {
      sessionId: 's1', turns: [], cursor: 'e1:6',
      delta: { total: 1, changed: [] },
    });
    expect(merged!.turns).toEqual([{ turnIndex: 0, messages: [expect.objectContaining({ text: 'one' })] }]);
  });

  it('bails out instead of inventing rows it was never sent', () => {
    // No cached transcript to fold onto.
    expect(mergeTranscriptDelta(undefined, { sessionId: 's1', turns: [], delta: { total: 1, changed: [] } })).toBeNull();
    // A gap: index 5 with only 3 rows cached would leave holes at 3 and 4.
    expect(mergeTranscriptDelta(cached, {
      sessionId: 's1', turns: [],
      delta: { total: 6, changed: [{ index: 5, turnIndex: 2, message: message('orphan') }] },
    })).toBeNull();
    // A total larger than what the merge can account for.
    expect(mergeTranscriptDelta(cached, { sessionId: 's1', turns: [], delta: { total: 9, changed: [] } })).toBeNull();
  });

  it('round-trips turns through the flat form', () => {
    expect(groupRows(flattenTurns(cached.turns))).toEqual(cached.turns);
  });
});
