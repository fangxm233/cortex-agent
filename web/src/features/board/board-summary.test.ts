import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { boardFlagTone, boardSummary } from './board-summary';

const s = (sessionId: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ sessionId, teamLeadId: null, workerName: null, workerRetiredAt: null, running: false, awaitingInput: false, ...over }) as SessionInfo;

describe('boardSummary', () => {
  it('orders leads first, workers by attention, and drops retired workers', () => {
    const sessions = [
      s('w-idle', { teamLeadId: 'lead', workerName: 'idle' }),
      s('w-gone', { teamLeadId: 'lead', workerName: 'gone', workerRetiredAt: 1 }),
      s('w-ask', { teamLeadId: 'lead', workerName: 'ask', awaitingInput: true }),
      s('lead', { running: true }),
    ];
    const summary = boardSummary(sessions);
    expect(summary.shown.map((x) => x.sessionId)).toEqual(['lead', 'w-ask', 'w-idle']);
    expect(summary.pending.map((x) => x.sessionId)).toEqual(['w-ask']);
    expect(summary.live).toBe(2);
  });
});

describe('boardFlagTone', () => {
  it('is amber while anyone waits on the user, accent while open, muted once closed', () => {
    expect(boardFlagTone('active', 1)).toBe('ask');
    expect(boardFlagTone('done', 2)).toBe('ask');
    expect(boardFlagTone('active', 0)).toBe('active');
    expect(boardFlagTone('done', 0)).toBe('closed');
    expect(boardFlagTone('abandoned', 0)).toBe('closed');
  });
});
