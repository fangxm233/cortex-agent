// input:  SessionTotals fixtures and session timestamps
// output: summary/rows coverage for the whole-session statistics view model
// pos:    Session stats view-model specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { SessionTotals } from '@cortex-agent/ui-contract';
import { sessionSpanMs, sessionStatsView, type SessionStatsCopy } from './session-stats';

const COPY: SessionStatsCopy = {
  scope: 'session',
  turnsUnit: 'turns',
  runsUnit: 'runs',
  runsLabel: 'Runs',
  turnsLabel: 'Agent turns',
  activeLabel: 'Active time',
  spanLabel: 'Open since first message',
  costLabel: 'Total cost',
  subagentLabel: 'Of which subagents',
};

function totals(over: Partial<SessionTotals> = {}): SessionTotals {
  return { runs: 13, turns: 512, activeMs: 11_520_000, costUsd: 48.2, subagentCostUsd: null, ...over };
}

function valueOf(view: ReturnType<typeof sessionStatsView>, key: string): string | undefined {
  return view?.rows.find((row) => row.key === key)?.value;
}

describe('sessionStatsView', () => {
  it('summarises the whole session in one line', () => {
    const view = sessionStatsView(totals(), 3 * 24 * 3600_000, COPY)!;
    expect(view.summary).toBe('session 3h 12m · 512 turns · $48.20');
  });

  it('spells the same numbers out as detail rows', () => {
    const view = sessionStatsView(totals(), 90_000, COPY)!;
    expect(view.rows.map((row) => [row.label, row.value])).toEqual([
      ['Runs', '13 runs'],
      ['Agent turns', '512 turns'],
      ['Active time', '3h 12m'],
      ['Open since first message', '1m 30s'],
      ['Total cost', '$48.20'],
    ]);
  });

  it('adds the subagent share only when children actually ran', () => {
    expect(valueOf(sessionStatsView(totals(), null, COPY), 'subagent')).toBeUndefined();
    expect(valueOf(sessionStatsView(totals({ subagentCostUsd: 7.54 }), null, COPY), 'subagent'))
      .toBe('$7.54');
  });

  it('renders unknown cost and unknown span as —, not as zero', () => {
    const view = sessionStatsView(totals({ costUsd: null }), null, COPY)!;
    expect(view.summary).toBe('session 3h 12m · 512 turns · —');
    expect(valueOf(view, 'cost')).toBe('—');
    expect(valueOf(view, 'span')).toBe('—');
    // A real zero is a different statement and must render as money.
    expect(valueOf(sessionStatsView(totals({ costUsd: 0 }), null, COPY), 'cost')).toBe('$0.00');
  });

  it('renders nothing at all when the session has no totals', () => {
    expect(sessionStatsView(null, 1000, COPY)).toBeNull();
    expect(sessionStatsView(undefined, 1000, COPY)).toBeNull();
  });

  it('keeps a zeroed session legible rather than blank', () => {
    const view = sessionStatsView(
      { runs: 0, turns: 0, activeMs: 0, costUsd: 0.44, subagentCostUsd: 0.44 },
      null,
      COPY,
    )!;
    expect(view.summary).toBe('session 0s · 0 turns · $0.44');
  });
});

describe('sessionSpanMs', () => {
  it('measures createdAt → lastUsedAt', () => {
    expect(sessionSpanMs('2026-05-01T00:00:00Z', '2026-05-01T01:30:00Z')).toBe(5_400_000);
  });

  it('refuses missing, unparseable or reversed stamps instead of inventing a duration', () => {
    expect(sessionSpanMs(null, '2026-05-01T00:00:00Z')).toBeNull();
    expect(sessionSpanMs('2026-05-01T00:00:00Z', undefined)).toBeNull();
    expect(sessionSpanMs('not-a-date', '2026-05-01T00:00:00Z')).toBeNull();
    expect(sessionSpanMs('2026-05-02T00:00:00Z', '2026-05-01T00:00:00Z')).toBeNull();
  });
});
