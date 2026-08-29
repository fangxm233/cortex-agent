// input:  CommissionInfo/SessionInfo fixtures
// output: commission row membership, rollup, ordering and title-fallback tests
// pos:    Verifies the COMMISSION rail-section view model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import type { CommissionInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { buildCommissionRows, commissionSessionIds, unreadCommissionCount } from './commission-rail';

const NOW = Date.parse('2026-07-16T12:00:00');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let seq = 0;
const session = (overrides: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    sessionId: 's' + ++seq,
    projectId: 'atlas',
    name: 'cortex-' + seq,
    label: 'session ' + seq,
    createdAt: ago(DAY),
    lastUsedAt: ago(HOUR),
    origin: 'direct',
    commissionId: null,
    ...overrides,
  }) as SessionInfo;

const commission = (id: string, overrides: Partial<CommissionInfo> = {}): CommissionInfo =>
  ({
    id,
    projectId: 'atlas',
    slug: 'slug-' + id,
    title: 'commission ' + id,
    status: 'active',
    createdAt: ago(DAY),
    updatedAt: ago(HOUR),
    closedAt: null,
    closeNote: null,
    ...overrides,
  }) as CommissionInfo;

describe('buildCommissionRows', () => {
  it('claims only sessions whose commissionId matches, latest first', () => {
    const older = session({ commissionId: 'c1', lastUsedAt: ago(5 * HOUR) });
    const newer = session({ commissionId: 'c1', lastUsedAt: ago(MIN) });
    const other = session({ commissionId: 'c2' });
    const loose = session();

    const rows = buildCommissionRows([commission('c1')], [older, newer, other, loose]);

    expect(rows).toHaveLength(1);
    expect(rows[0].sessions.map((s) => s.sessionId)).toEqual([newer.sessionId, older.sessionId]);
    expect(rows[0].latest?.sessionId).toBe(newer.sessionId);
  });

  it('orders by member activity and falls back to updatedAt when a commission has no sessions', () => {
    const rows = buildCommissionRows(
      [
        commission('stale', { updatedAt: ago(3 * DAY) }),
        commission('fresh', { updatedAt: ago(MIN) }),
        commission('worked', { updatedAt: ago(2 * DAY) }),
      ],
      [session({ commissionId: 'worked', lastUsedAt: ago(10 * MIN) })],
    );

    // 'fresh' has no sessions but a recent registry stamp; 'worked' is ranked by its session.
    expect(rows.map((r) => r.commissionId)).toEqual(['fresh', 'worked', 'stale']);
  });

  it('ranks every open commission above every closed one', () => {
    const rows = buildCommissionRows(
      [
        commission('done', { status: 'done', updatedAt: ago(MIN) }),
        commission('abandoned', { status: 'abandoned', updatedAt: ago(MIN) }),
        commission('open', { status: 'active', updatedAt: ago(10 * DAY) }),
      ],
      [],
    );

    expect(rows[0].commissionId).toBe('open');
  });

  it('falls back to the slug when a commission has a blank title', () => {
    const rows = buildCommissionRows([commission('c1', { title: '   ' })], []);
    expect(rows[0].title).toBe('slug-c1');
  });

  it('reports claimed session ids and unread row count', () => {
    const a = session({ commissionId: 'c1', unread: true });
    const b = session({ commissionId: 'c2' });
    const rows = buildCommissionRows([commission('c1'), commission('c2')], [a, b]);

    expect([...commissionSessionIds(rows)].sort()).toEqual([a.sessionId, b.sessionId].sort());
    expect(unreadCommissionCount(rows)).toBe(1);
  });
});
