import { describe, expect, it } from 'vitest';
import { recordTurnMessage, takeTurnMessage, type BufferedTurnMessage } from './turn-buffer';

describe('turn-buffer', () => {
  it('keeps only the latest assistant message per session (newest wins)', () => {
    const buf = new Map<string, BufferedTurnMessage>();
    recordTurnMessage(buf, 's1', { text: 'first', ts: 't1' });
    recordTurnMessage(buf, 's1', { text: 'second', ts: 't2' });
    expect(takeTurnMessage(buf, 's1')).toEqual({ text: 'second', ts: 't2' });
  });

  it('take clears the buffer so a second take returns null', () => {
    const buf = new Map<string, BufferedTurnMessage>();
    recordTurnMessage(buf, 's1', { text: 'x', ts: 't' });
    expect(takeTurnMessage(buf, 's1')).toEqual({ text: 'x', ts: 't' });
    expect(takeTurnMessage(buf, 's1')).toBeNull();
  });

  it('returns null when nothing was buffered for the session', () => {
    const buf = new Map<string, BufferedTurnMessage>();
    expect(takeTurnMessage(buf, 'missing')).toBeNull();
  });

  it('buffers sessions independently', () => {
    const buf = new Map<string, BufferedTurnMessage>();
    recordTurnMessage(buf, 's1', { text: 'a', ts: 't1' });
    recordTurnMessage(buf, 's2', { text: 'b', ts: 't2' });
    expect(takeTurnMessage(buf, 's1')).toEqual({ text: 'a', ts: 't1' });
    // taking s1 must not disturb s2
    expect(takeTurnMessage(buf, 's2')).toEqual({ text: 'b', ts: 't2' });
  });
});
