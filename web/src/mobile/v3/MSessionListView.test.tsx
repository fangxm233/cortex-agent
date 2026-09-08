// input:  session rows, SessionInfo status facts, and list copy
// output: run-state row styling and card-geometry regressions
// pos:    Verifies the mobile session row's conditional run treatment
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { MSessionListView, type MSessionListCopy } from './MSessionListView';
import { buildSessionGroups } from './m-session-list-vm';

const copy: MSessionListCopy = {
  title: '会话', today: '今天', yesterday: '昨天', earlier: '更早', empty: '暂无会话',
};

// Neutral placeholder session (守则11 — no real project names / ids).
function sess(over: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: 's1', backendSessionId: null, name: 'morning review', projectId: 'nimbus',
    backend: 'claude', kind: 'local', origin: 'direct',
    createdAt: '2026-07-15T09:00:00Z', lastUsedAt: '2026-07-15T09:00:00Z',
    resumable: true, label: null, profileName: null, running: false, backgroundRunning: false,
    awaitingInput: false, numTurns: null, costUsd: null, unread: false, scheduleId: null,
    ...over, commissionId: over.commissionId ?? null,
  };
}

function markup(sessions: SessionInfo[]): string {
  const now = Date.parse('2026-07-15T12:00:00Z');
  return renderToStaticMarkup(
    <MSessionListView
      groups={buildSessionGroups(sessions, now)}
      sessions={sessions}
      copy={copy}
      onOpen={() => {}}
      onNew={() => {}}
    />,
  );
}

const RUN_EDGE = 'box-shadow:inset 2px 0 0 var(--m-run)';

describe('MSessionListView row', () => {
  it('marks running and background-held rows with the layout-free run edge', () => {
    expect(markup([sess({ running: true, numTurns: 28 })])).toContain(RUN_EDGE);
    expect(markup([sess({ running: true, backgroundRunning: true })])).toContain(RUN_EDGE);
  });

  it('leaves idle and awaiting rows without the run edge', () => {
    expect(markup([sess({})])).not.toContain(RUN_EDGE);
    expect(markup([sess({ running: true, awaitingInput: true })])).not.toContain(RUN_EDGE);
  });

  // Unread is an independent axis: an unread row that is not running must stay unmarked, and the
  // amber「需要你」dot must survive an awaiting row that is also technically running.
  it('keeps unread and awaiting semantics independent of the run treatment', () => {
    expect(markup([sess({ unread: true })])).not.toContain(RUN_EDGE);
    expect(markup([sess({ unread: true })])).toContain('aria-label="unread"');
    expect(markup([sess({ running: true, awaitingInput: true })])).toContain('var(--m-amber)');
  });

  it('colours the status line with the accent only while live', () => {
    expect(markup([sess({ running: true, numTurns: 28 })])).toContain('color:var(--m-run)">running · 28 turns');
    expect(markup([sess({})])).toContain('color:var(--m-muted)">空闲');
    expect(markup([sess({ running: true, awaitingInput: true })])).toContain('color:var(--m-muted)">等待操作');
  });

  // The refinement is colour + corner only: the two-line card keeps its padding, and the run edge
  // is an inset shadow precisely so a live row occupies the same box as an idle one.
  it('keeps the two-line card geometry identical across states', () => {
    for (const s of [sess({}), sess({ running: true, numTurns: 3 }), sess({ awaitingInput: true })]) {
      const html = markup([s]);
      expect(html).toContain('border-radius:9px;padding:12px 13px');
      expect(html).toContain('margin-top:4px');
    }
  });
});
