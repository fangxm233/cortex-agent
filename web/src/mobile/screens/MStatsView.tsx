import type { StatsController } from '@/features/stats';
import { StatsFilters, StatsSections, type StatsSessionTarget } from '@/features/settings/panels/stats/StatsSections';
import { useVocab } from '@/i18n';
import { MSET_INSET, MSettingsBody, MSettingsFrame, MSettingsHeader } from './MSettingsControls';

export interface MStatsViewProps {
  controller: StatsController;
  onBack: () => void;
  onOpenSession: (target: StatsSessionTarget) => void;
}

/** The Stats page stacked for a phone: filters on top, then every section full width. */
export function MStatsView({ controller, onBack, onOpenSession }: MStatsViewProps) {
  const L = useVocab();
  return (
    <MSettingsFrame label="1l-st stats" header={<MSettingsHeader onBack={onBack}><span>{L.stNavStats}</span></MSettingsHeader>}>
      <MSettingsBody>
        <div data-stats-filters style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: `0 ${MSET_INSET}px` }}>
          <StatsFilters controller={controller} variant="mobile" />
        </div>
        <div style={{ padding: `0 ${MSET_INSET}px` }}>
          <StatsSections controller={controller} variant="mobile" onOpenSession={onOpenSession} />
        </div>
      </MSettingsBody>
    </MSettingsFrame>
  );
}
