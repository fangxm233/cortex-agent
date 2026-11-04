import { useState } from 'react';
import type { StatsToolKind, StatsTools, StatsUsage } from '@cortex-agent/ui-contract';
import {
  axisLabel, bucketTitle, dimensionSeries, formatCount, intlLocale, Legend, legendItems, LineChart, rankRows, toggleId,
  TOOL_KIND_LABEL, toolSeries, windowStarts, type ChartSeries, type RunsBy, type StatsQuery,
} from '@/features/stats';
import { SSegmented } from '@/features/settings/ui/settings-kit';
import { fmt, useLang, useVocab } from '@/i18n';
import { StatsCard, StatsFigure, StatsHeading, StatsNote, StatsQueryState, type StatsVariant } from './stats-ui';

const TOOL_KINDS: readonly StatsToolKind[] = ['tool', 'skill', 'mcp'];

/** A count line chart with its legend; legend entries hide and show lines. */
function CountChart(props: {
  series: ChartSeries[];
  starts: number[];
  bucket: 'hour' | 'day';
  whole: number;
  unit: string;
  ariaLabel: string;
  variant: StatsVariant;
}) {
  const locale = intlLocale(useLang());
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const format = (n: number) => fmt(props.unit, { n: formatCount(n, locale) });
  return (
    <>
      <LineChart series={props.series} hidden={hidden} ariaLabel={props.ariaLabel} format={format}
        height={props.variant === 'mobile' ? 160 : 180}
        labels={props.starts.map((start) => axisLabel(start, props.bucket, locale))}
        titles={props.starts.map((start) => bucketTitle(start, props.bucket, locale))} />
      <Legend items={legendItems(props.series, hidden, props.whole, format)} onToggle={(id) => setHidden(toggleId(hidden, id))} />
    </>
  );
}

function Ranking({ tools }: { tools: StatsTools }) {
  const L = useVocab();
  const locale = intlLocale(useLang());
  return (
    <div data-stats-ranking>
      <div className="stats-rank-title">{L.statsRanking}</div>
      <div className="stats-rank">
        {rankRows(tools.ranking, locale).map((row) => (
          <div key={row.name} className="stats-rank-item" data-stats-rank={row.name}>
            <span title={row.name}>{row.name}</span>
            <span>{row.count}</span>
            <div><i style={{ width: `${row.width}%`, background: row.color }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolsBody({ tools, variant }: { tools: StatsTools; variant: StatsVariant }) {
  const L = useVocab();
  const locale = intlLocale(useLang());
  if (!tools.ready) return <StatsNote data-stats-tools-pending>{L.statsLoading}</StatsNote>;
  if (tools.total === 0) return <StatsNote data-stats-empty>{L.statsNoCalls}</StatsNote>;
  const series = toolSeries(tools.series);
  return (
    <div className="stats-tools" data-variant={variant}>
      <div style={{ minWidth: 0 }}>
        <StatsFigure value={formatCount(tools.total, locale)}
          caption={fmt(L.statsCallsCaption, { n: formatCount(tools.distinct, locale) })} />
        {/* Keyed by kind: a switch starts with every line shown. */}
        <CountChart key={tools.kind} series={series} starts={windowStarts(tools.window)} bucket={tools.window.bucket}
          whole={tools.total} unit={L.statsCalls} ariaLabel={L.statsToolActivity} variant={variant} />
      </div>
      <Ranking tools={tools} />
    </div>
  );
}

export function ToolsSection(props: {
  query: StatsQuery<StatsTools>;
  kind: StatsToolKind;
  onKind: (kind: StatsToolKind) => void;
  variant: StatsVariant;
}) {
  const L = useVocab();
  return (
    <section data-stats-section="tools">
      <StatsHeading title={L.statsToolActivity}>
        <SSegmented value={props.kind} ariaLabel={L.statsToolKind} dataAttr="data-stats-tool-kind" onChange={props.onKind}
          options={TOOL_KINDS.map((kind) => ({ id: kind, label: L[TOOL_KIND_LABEL[kind]] }))} />
      </StatsHeading>
      <StatsCard dim={props.query.refreshing}>
        <StatsQueryState query={props.query}>{(tools) => <ToolsBody tools={tools} variant={props.variant} />}</StatsQueryState>
      </StatsCard>
    </section>
  );
}

export function RunsSection({ usage, variant, refreshing }: { usage: StatsUsage; variant: StatsVariant; refreshing: boolean }) {
  const L = useVocab();
  const locale = intlLocale(useLang());
  const [by, setBy] = useState<RunsBy>('model');
  const series = dimensionSeries(usage.runs[by], by, L);
  return (
    <section data-stats-section="runs">
      <StatsHeading title={L.statsRunActivity}>
        <SSegmented value={by} ariaLabel={L.statsRunsBy} dataAttr="data-stats-runs-by" onChange={setBy}
          options={[{ id: 'model', label: L.statsByModel }, { id: 'source', label: L.statsBySource }]} />
      </StatsHeading>
      <StatsCard dim={refreshing}>
        <StatsFigure value={formatCount(usage.totals.runs, locale)}
          caption={fmt(L.statsRunsCaption, { n: formatCount(usage.totals.requests, locale) })} />
        {usage.totals.runs === 0 ? <StatsNote data-stats-empty>{L.statsNoRuns}</StatsNote> : (
          <CountChart key={by} series={series} starts={usage.buckets.map((b) => b.start)} bucket={usage.window.bucket}
            whole={usage.totals.runs} unit={L.statsRunCount} ariaLabel={L.statsRunActivity} variant={variant} />
        )}
      </StatsCard>
    </section>
  );
}
