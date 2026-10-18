import { useMemo, type CSSProperties } from 'react';
import type { CostSummary } from '@cortex-agent/ui-contract';
import { fmt, useLang, useVocab } from '@/i18n';
import { LINK, META, SectionHead } from './overview-parts';
import {
  budgetPercent,
  dailyAverage,
  dailySeriesBars,
  forecastOverBudget,
  formatMoney,
  formatPerDay,
  seriesDayLabel,
  triggerLabel,
  triggerSlots,
  whereItGoesRows,
} from './overview-vm';

// The Overview's spend column: today's project-scoped spend against its daily budget, the last 14
// days as small bars, week / month / forecast, and where this week's money went. Every number is
// the real cost.summary for the project; with no budget the meter stays empty and the line says
// only "today" (never a made-up denominator), and a week with no spend says so in one line.

// Series colours for the where-it-goes split, in slot order (see triggerSlots): the accent at
// falling strength, then neutral ink. Mixing toward transparent (not the theme's accent-mid) keeps
// the steps apart in dark mode too, where the accent and its mid tone sit close together.
const SERIES = [
  'var(--proto-accent)',
  'color-mix(in srgb, var(--proto-accent) 45%, transparent)',
  'color-mix(in srgb, var(--proto-accent) 22%, transparent)',
  'var(--proto-faint)',
  'var(--proto-line-3)',
];

const KV_LABEL: CSSProperties = { fontSize: 12, color: 'var(--proto-muted-3)' };
const KV_VALUE: CSSProperties = { display: 'block', marginTop: 2, fontSize: 14, fontWeight: 600, color: 'var(--proto-ink)', fontVariantNumeric: 'tabular-nums' };

export function OverviewSpend({ cost, now, onAdjustBudget }: {
  cost: CostSummary | undefined;
  now: number;
  onAdjustBudget: () => void;
}): JSX.Element {
  const L = useVocab();
  const lang = useLang();
  const budgetPct = budgetPercent(cost?.today, cost?.dailyBudget);
  const bars = useMemo(() => dailySeriesBars(cost?.dailyCost), [cost?.dailyCost]);
  const avg = useMemo(() => dailyAverage(cost?.dailyCost), [cost?.dailyCost]);
  const where = useMemo(() => whereItGoesRows(cost?.byTriggerScoped), [cost?.byTriggerScoped]);
  const slots = triggerSlots(where, SERIES.length);
  const over = forecastOverBudget(cost?.forecastToday, cost?.dailyBudget);
  const todayLabel = budgetPct == null ? L.today : fmt(L.ovTodayOfBudget, { budget: formatPerDay(cost?.dailyBudget) });
  const seriesLabel = `${L.ovLast14Days} · ${L.ovAvg} ${avg == null ? '—' : formatMoney(avg)}${L.perDay}`;

  return (
    <section data-overview-spend="">
      <SectionHead
        title={L.ovSpend}
        action={
          <button type="button" className="content-text-action" data-adjust-budget="" onClick={onAdjustBudget} style={LINK}>
            {L.adjustBudget} ›
          </button>
        }
      />
      <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '2px 8px' }}>
        <span style={{ fontSize: 28, fontWeight: 620, lineHeight: 1.1, letterSpacing: '-.01em', color: 'var(--proto-ink)', fontVariantNumeric: 'tabular-nums' }}>
          {formatMoney(cost?.today)}
        </span>
        <span style={{ fontSize: 13, color: 'var(--proto-muted-3)', fontVariantNumeric: 'tabular-nums' }}>
          {todayLabel}
        </span>
      </div>
      {/* Today's share of the daily budget; an empty track when there is no budget to measure against. */}
      <div
        role="meter"
        aria-label={todayLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(budgetPct ?? 0)}
        style={{ height: 4, borderRadius: 4, background: 'var(--proto-line)', overflow: 'hidden', marginTop: 10 }}
      >
        {budgetPct != null && budgetPct > 0 && (
          <div style={{ width: `${budgetPct}%`, minWidth: 3, height: '100%', borderRadius: 4, background: 'var(--proto-accent)' }} />
        )}
      </div>

      {bars.length > 0 && (
        <>
          <div role="img" aria-label={seriesLabel} title={seriesLabel}
            style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 40, marginTop: 16 }}>
            {bars.map((bar) => (
              <i
                key={bar.date}
                data-today-bar={bar.isToday || undefined}
                title={`${seriesDayLabel(bar.date, now, lang)} · ${formatMoney(bar.cost)}`}
                style={{
                  flex: 1,
                  display: 'block',
                  height: `${bar.pct}%`,
                  minHeight: 2,
                  borderRadius: '2px 2px 0 0',
                  background: bar.isToday ? 'var(--proto-accent)' : 'var(--proto-line-4)',
                }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11.5, color: 'var(--proto-muted-3)' }}>
            <span>{seriesDayLabel(bars[0].date, now, lang)}</span>
            <span>{L.today}</span>
          </div>
        </>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginTop: 14 }}>
        <span style={KV_LABEL}>{L.ovThisWeek}<b style={KV_VALUE}>{formatMoney(cost?.week)}</b></span>
        <span style={KV_LABEL}>{L.ovThisMonth}<b style={KV_VALUE}>{formatMoney(cost?.month)}</b></span>
        <span style={KV_LABEL}>
          {L.ovForecast}
          <b data-forecast-over={over || undefined} style={{ ...KV_VALUE, color: over ? 'var(--proto-amber-text)' : 'var(--proto-ink)' }}>
            {formatMoney(cost?.forecastToday)}
          </b>
        </span>
      </div>

      <div style={{ marginTop: 16, ...KV_LABEL }}>{L.ovWhereItGoes}</div>
      {where.length === 0 ? (
        <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--proto-muted-3)' }}>{L.ovNoSpend}</div>
      ) : (
        <>
          <div aria-hidden="true" style={{ display: 'flex', gap: 2, height: 6, borderRadius: 6, overflow: 'hidden', margin: '8px 0' }}>
            {where.map((row, i) => (
              <i key={row.label} title={`${triggerLabel(row.label, L)} · ${formatMoney(row.cost)}`}
                style={{ flex: row.pct, display: 'block', background: SERIES[slots[i]] }} />
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 12, color: 'var(--proto-muted)' }}>
            {where.map((row, i) => (
              <span key={row.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: SERIES[slots[i]], flex: 'none' }} />
                {triggerLabel(row.label, L)}
                <span style={{ ...META, color: 'var(--proto-ink-3)' }}>{formatMoney(row.cost)}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
