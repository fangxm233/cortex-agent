import type { SessionTotals } from '@cortex-agent/ui-contract';
import { formatElapsed } from './transcript-vm';
import { formatUsd } from '@/lib/format';

// The composer status line has always answered "what is happening right now": the CURRENT turn's
// elapsed time, and the LAST run's turns and cost. That is the wrong number for "what has this
// conversation cost me" — a session with 13 runs showed the 13th. This module supplies the other
// half, never replacing it: `summary` renders beside the run segment, `rows` back the detail
// modal/sheet where the per-part breakdown (incl. the subagent share) is spelled out.

const DASH = '—';

export interface SessionStatsCopy {
  /** Prefix that marks the second segment as whole-session, e.g. `会话` / `session`. */
  scope: string;
  turnsUnit: string;
  runsUnit: string;
  /** Detail-row labels. */
  runsLabel: string;
  turnsLabel: string;
  activeLabel: string;
  spanLabel: string;
  costLabel: string;
  subagentLabel: string;
}

export interface SessionStatsRow {
  key: 'runs' | 'turns' | 'active' | 'span' | 'cost' | 'subagent';
  label: string;
  value: string;
}

export interface SessionStatsView {
  /** One line: `会话 3h 12m · 512 轮 · $48.20`. */
  summary: string;
  rows: SessionStatsRow[];
}

/** Wall-clock lifetime of the session, which is NOT the sum of its runs — most of a long session is
 *  the user thinking between turns. Shown in the detail only, so the two times cannot be confused
 *  at a glance. Negative/garbage stamps yield null rather than a nonsense duration. */
export function sessionSpanMs(
  createdAt: string | null | undefined,
  lastUsedAt: string | null | undefined,
): number | null {
  if (!createdAt || !lastUsedAt) return null;
  const from = Date.parse(createdAt);
  const to = Date.parse(lastUsedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const span = to - from;
  return span >= 0 ? span : null;
}

/**
 * Build both renderings. Returns null when the session has no totals at all (never ran, or an older
 * server that does not send the field) — callers then render nothing rather than a row of dashes.
 */
export function sessionStatsView(
  totals: SessionTotals | null | undefined,
  spanMs: number | null,
  copy: SessionStatsCopy,
): SessionStatsView | null {
  if (!totals) return null;
  const activeText = formatElapsed(totals.activeMs);
  const turnsText = `${totals.turns} ${copy.turnsUnit}`;
  const costText = totals.costUsd == null ? DASH : formatUsd(totals.costUsd);
  const rows: SessionStatsRow[] = [
    { key: 'runs', label: copy.runsLabel, value: `${totals.runs} ${copy.runsUnit}` },
    { key: 'turns', label: copy.turnsLabel, value: turnsText },
    { key: 'active', label: copy.activeLabel, value: activeText },
    { key: 'span', label: copy.spanLabel, value: spanMs == null ? DASH : formatElapsed(spanMs) },
    { key: 'cost', label: copy.costLabel, value: costText },
  ];
  // The subagent row appears only when children actually ran: on a session that never delegated it
  // would just be a permanent `—` inviting the reader to wonder what they are missing.
  if (totals.subagentCostUsd != null) {
    rows.push({ key: 'subagent', label: copy.subagentLabel, value: formatUsd(totals.subagentCostUsd) });
  }
  return {
    summary: [`${copy.scope} ${activeText}`, turnsText, costText].join(' · '),
    rows,
  };
}
