import { useMemo } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useVocabOptional } from '@/i18n';
import { TeamRosterPanel, WorkerDotStack } from '@/features/team/TeamRoster';
import { teamRoster, teamSummaryText } from '@/features/team/worker-roster';
import { ActivityChip, CHIP_COUNT } from '@/features/session/rail/ActivityChip';
import { MBottomSheet } from '@/mobile/ui/kit';

// Team mode on mobile: a lead's chat carries its team as one capsule above the composer; tapping it
// opens the team list in a sheet. A worker opens from the sheet.

const CHIP_DOTS = 3;

export function hasActiveWorker(workers: SessionInfo[] | undefined): boolean {
  return teamRoster(workers ?? []).active.length > 0;
}

/** A few of the workers' dots and how many there are. */
export function MTeamChip({ workers, onOpen }: { workers: SessionInfo[]; onOpen: () => void }): JSX.Element {
  const L = useVocabOptional();
  const { active } = useMemo(() => teamRoster(workers), [workers]);
  return (
    <ActivityChip data="team" label={`${L.wbTeamWorkers} · ${teamSummaryText(active, L)}`} floating onClick={onOpen}>
      <WorkerDotStack workers={active.slice(0, CHIP_DOTS)} />
      <span style={CHIP_COUNT}>{active.length}</span>
    </ActivityChip>
  );
}

export function MTeamSheet({ workers, onOpen, onClose }: {
  workers: SessionInfo[];
  onOpen: (sessionId: string) => void;
  onClose: () => void;
}): JSX.Element {
  const roster = useMemo(() => teamRoster(workers), [workers]);
  return (
    <MBottomSheet onClose={onClose}>
      <div data-team-sheet="">
        <TeamRosterPanel roster={roster} touch onOpen={onOpen} />
      </div>
    </MBottomSheet>
  );
}
