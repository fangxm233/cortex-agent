import { useState } from 'react';
import type { StatsUsage } from '@cortex-agent/ui-contract';
import {
  axisLabel, bucketTitle, buildKpis, formatCount, formatTokens, GROUP_LABEL, intlLocale, isEmptyUsage, Legend,
  legendItems, Sparkline, StackedBarChart, toggleId, usageSeries, windowLabel, type StatsGroup,
} from '@/features/stats';
import { fmt, useLang, useVocab } from '@/i18n';
import { StatsCard, StatsFigure, StatsHeading, StatsNote, StatsSelect, type StatsVariant } from './stats-ui';

const GROUPS: readonly StatsGroup[] = ['type', 'model', 'project', 'source'];

export function KpiTiles({ usage, variant }: { usage: StatsUsage; variant: StatsVariant }) {
  const L = useVocab();
  return (
    <div className="stats-kpis" data-variant={variant} data-stats-kpis>
      {buildKpis(usage, L).map((kpi) => (
        <StatsCard key={kpi.id} className="stats-kpi" data-stats-kpi={kpi.id}>
          <div className="stats-kpi-label">{kpi.label}</div>
          <div className="stats-kpi-value">
            <b>{kpi.value}</b>
            {kpi.delta ? (
              <span className="stats-kpi-delta" data-stats-delta={kpi.delta.direction} title={L.statsVsPrevious}>
                {kpi.delta.direction === 'up' ? '▲' : '▼'} {kpi.delta.text}
              </span>
            ) : null}
          </div>
          <Sparkline values={kpi.spark} color={kpi.color} />
        </StatsCard>
      ))}
    </div>
  );
}

function PagerIcon({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={dir === 'left' ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} />
    </svg>
  );
}

/** The period a page covers, with ‹ › stepping one whole period back or forward. */
function PeriodRow({ usage, onPage }: { usage: StatsUsage; onPage: (page: number) => void }) {
  const L = useVocab();
  const locale = intlLocale(useLang());
  const { window } = usage;
  return (
    <div className="stats-period">
      <span className="stats-period-label" data-stats-period>{windowLabel(window, locale)}</span>
      <span className="stats-pager">
        <button type="button" className="stats-icon-button" data-stats-page="older" aria-label={L.statsEarlier} title={L.statsEarlier}
          disabled={!window.hasOlder} onClick={() => onPage(window.page + 1)}>
          <PagerIcon dir="left" />
        </button>
        <button type="button" className="stats-icon-button" data-stats-page="newer" aria-label={L.statsLater} title={L.statsLater}
          disabled={window.page === 0} onClick={() => onPage(Math.max(0, window.page - 1))}>
          <PagerIcon dir="right" />
        </button>
      </span>
    </div>
  );
}

function UsageChart({ usage, group, variant }: { usage: StatsUsage; group: StatsGroup; variant: StatsVariant }) {
  const L = useVocab();
  const locale = intlLocale(useLang());
  const [hidden, setHidden] = useState<{ group: StatsGroup; ids: Set<string> }>({ group, ids: new Set() });
  // Hidden series belong to one grouping; switching the grouping shows everything again.
  const ids = hidden.group === group ? hidden.ids : new Set<string>();
  const series = usageSeries(usage, group, L);
  const { bucket } = usage.window;
  return (
    <>
      <StackedBarChart series={series} hidden={ids} ariaLabel={L.statsTokenUsage} totalLabel={L.statsTotal}
        height={variant === 'mobile' ? 170 : 200} format={formatTokens}
        labels={usage.buckets.map((b) => axisLabel(b.start, bucket, locale))}
        titles={usage.buckets.map((b) => bucketTitle(b.start, bucket, locale))} />
      <Legend items={legendItems(series, ids, usage.totals.total, formatTokens)}
        onToggle={(id) => setHidden({ group, ids: toggleId(ids, id) })} />
    </>
  );
}

export function TokenUsageSection(props: {
  usage: StatsUsage;
  variant: StatsVariant;
  refreshing: boolean;
  onPage: (page: number) => void;
}) {
  const L = useVocab();
  const locale = intlLocale(useLang());
  const [group, setGroup] = useState<StatsGroup>('type');
  const { usage } = props;
  return (
    <section data-stats-section="usage">
      <StatsHeading title={L.statsTokenUsage}>
        <StatsSelect variant={props.variant} label={L.statsGroupBy} dataAttr="data-stats-group" value={group}
          options={GROUPS.map((g) => ({ value: g, label: L[GROUP_LABEL[g]] }))}
          onChange={(value) => setGroup(value as StatsGroup)} />
      </StatsHeading>
      <StatsCard dim={props.refreshing}>
        <PeriodRow usage={usage} onPage={props.onPage} />
        <StatsFigure value={formatTokens(usage.totals.total)}
          caption={fmt(L.statsTokensCaption, { n: formatCount(usage.totals.requests, locale) })} />
        {isEmptyUsage(usage.totals)
          ? <StatsNote data-stats-empty>{L.statsEmpty}</StatsNote>
          : <UsageChart usage={usage} group={group} variant={props.variant} />}
      </StatsCard>
    </section>
  );
}
