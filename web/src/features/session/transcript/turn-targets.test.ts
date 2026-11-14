import { describe, expect, it } from 'vitest';
import { assistantTurnTargets, type ChatRow } from './transcript-vm';

describe('assistantTurnTargets', () => {
  it('carries the time of the last reply text with the turn text', () => {
    const rows: ChatRow[] = [
      { kind: 'user', text: 'q', ts: '2026-11-13T10:00:00Z' },
      { kind: 'assistant', text: 'one', streaming: false, ts: '2026-11-13T10:01:00Z' },
      { kind: 'tools', count: 1, calls: [{ kind: 'bash', input: 'ls' }] },
      { kind: 'assistant', text: 'two', streaming: false, ts: '2026-11-13T10:05:00Z' },
      { kind: 'tools', count: 1, calls: [{ kind: 'bash', input: 'pwd' }] },
      { kind: 'user', text: 'next' },
      { kind: 'assistant', text: 'untimed', streaming: false },
    ];
    expect([...assistantTurnTargets(rows)]).toEqual([
      [4, { text: 'one\n\ntwo', ts: '2026-11-13T10:05:00Z' }],
      [6, { text: 'untimed' }],
    ]);
  });
});
