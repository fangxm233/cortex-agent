import { useMemo, type CSSProperties } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useVocabOptional } from '@/i18n';
import { TeamRosterPanel, TeamSummaryLabel, WorkerDotStack } from '@/features/team/TeamRoster';
import { teamRoster } from '@/features/team/worker-roster';
import { MBottomSheet, MC } from '@/mobile/ui/kit';

// Team mode on mobile: a lead's chat floats one summary row under its header; tapping it opens the
// team list in a sheet. A worker opens from the sheet.

/** Sits in the chat's measured header stack, under the header pill; the transcript clears it. */
const ROW: CSSProperties = {
  flex: 'none', height: 40, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 9,
  padding: '0 12px 0 14px', border: 0, borderRadius: 'var(--r-card)', cursor: 'pointer', fontFamily: 'inherit',
  textAlign: 'left', background: MC.glass, backdropFilter: MC.glassFilter, WebkitBackdropFilter: MC.glassFilter,
  boxShadow: '0 0 0 1px var(--proto-line), var(--shadow-chrome-float)',
};

export function hasActiveWorker(workers: SessionInfo[] | undefined): boolean {
  return teamRoster(workers ?? []).active.length > 0;
}

export function MTeamRow({ workers, onOpen }: { workers: SessionInfo[]; onOpen: () => void }): JSX.Element {
  const L = useVocabOptional();
  const { active } = useMemo(() => teamRoster(workers), [workers]);
  return (
    <button type="button" data-team-row="" aria-label={L.wbTeamWorkers} onClick={onOpen} style={ROW}>
      <WorkerDotStack workers={active} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex' }}><TeamSummaryLabel active={active} /></span>
      <span aria-hidden="true" style={{ flex: 'none', fontSize: 18, lineHeight: 1, color: MC.muted }}>›</span>
    </button>
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
