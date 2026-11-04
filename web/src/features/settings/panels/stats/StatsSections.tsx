import type { StatsRange } from '@cortex-agent/ui-contract';
import { RANGE_LABEL, STATS_RANGES, type StatsController } from '@/features/stats';
import { SSegmented } from '@/features/settings/ui/settings-kit';
import { useVocab } from '@/i18n';
import { QuotaSection } from './StatsQuota';
import { RunsSection, ToolsSection } from './StatsActivity';
import { SessionsSection, type StatsSessionTarget } from './StatsSessions';
import { KpiTiles, TokenUsageSection } from './StatsUsageSections';
import { StatsQueryState, StatsSelect, type StatsVariant } from './stats-ui';

export type { StatsSessionTarget } from './StatsSessions';
export type { StatsVariant } from './stats-ui';

// The project picker's value for "every project".
const ALL_PROJECTS = '';

/** The page-wide filters: project and range. They scope every section below them. */
export function StatsFilters({ controller, variant }: { controller: StatsController; variant: StatsVariant }) {
  const L = useVocab();
  const known = controller.usage.data?.projects ?? [];
  const projects = controller.projectId && !known.includes(controller.projectId) ? [...known, controller.projectId] : known;
  return (
    <>
      <StatsSelect variant={variant} label={L.statsProject} dataAttr="data-stats-project"
        value={controller.projectId ?? ALL_PROJECTS}
        options={[{ value: ALL_PROJECTS, label: L.statsAllProjects }, ...[...projects].sort().map((p) => ({ value: p, label: p }))]}
        onChange={(value) => controller.setProjectId(value || null)} />
      <SSegmented<StatsRange> value={controller.range} ariaLabel={L.statsRange} dataAttr="data-stats-range"
        onChange={controller.setRange}
        options={STATS_RANGES.map((range) => ({ id: range, label: L[RANGE_LABEL[range]] }))} />
    </>
  );
}

/** Every section of the page, top to bottom: KPIs, token usage, top sessions, quota windows,
 *  tool activity and run activity. */
export function StatsSections(props: {
  controller: StatsController;
  variant: StatsVariant;
  onOpenSession: (target: StatsSessionTarget) => void;
}) {
  const { controller, variant } = props;
  const refreshing = controller.usage.refreshing;
  return (
    <div className="stats-page" data-stats-variant={variant}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--settings-section-gap, 20px)', minWidth: 0 }}>
      <StatsQueryState query={controller.usage}>
        {(usage) => (
          <>
            <KpiTiles usage={usage} variant={variant} />
            <TokenUsageSection usage={usage} variant={variant} refreshing={refreshing} onPage={controller.setPage} />
            <SessionsSection usage={usage} now={controller.now} variant={variant} onOpenSession={props.onOpenSession} />
          </>
        )}
      </StatsQueryState>
      <QuotaSection query={controller.quota} variant={variant} onSelectAccount={controller.setAccount} />
      <ToolsSection query={controller.tools} kind={controller.toolKind} onKind={controller.setToolKind} variant={variant} />
      {controller.usage.data ? <RunsSection usage={controller.usage.data} variant={variant} refreshing={refreshing} /> : null}
    </div>
  );
}
