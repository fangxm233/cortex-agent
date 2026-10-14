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
      s('w-run', { teamLeadId: 'lead', workerName: 'run', running: true }),
      s('lead', { running: true, awaitingInput: true }),
    ];
    const summary = boardSummary(sessions);
    expect(summary.shown.map((x) => x.sessionId)).toEqual(['lead', 'w-run', 'w-idle']);
    expect(summary.pending.map((x) => x.sessionId)).toEqual(['lead']);
  });

  it('never counts a worker as waiting on the user: its questions go to the lead', () => {
    const asking = s('w-ask', { teamLeadId: 'lead', workerName: 'ask', running: true, awaitingInput: true });
    expect(boardSummary([s('lead'), asking]).pending).toEqual([]);
  });
});

describe('boardFlagTone', () => {
  it('is amber while anyone waits on the user, else accent', () => {
    expect(boardFlagTone(1)).toBe('ask');
    expect(boardFlagTone(0)).toBe('active');
  });
});
