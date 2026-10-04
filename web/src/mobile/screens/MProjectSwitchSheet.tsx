import { MBottomSheet, MGroup, MC } from '@/mobile/ui/kit';
import type { MProjectSwitchRow } from './m-project-vm';
import { useVocabOptional } from '@/i18n';
import { NewProjectRow, SwitchRow } from './MProjectSwitchRows';
import { useProjectSwitchSheetRows } from './useMProjectSwitch';

export interface MProjectSwitchSheetViewProps {
  current: MProjectSwitchRow | null;
  others: MProjectSwitchRow[];
  onPick: (id: string) => void;
  onNewProject: () => void;
  onClose: () => void;
}

export function MProjectSwitchSheetView({ current, others, onPick, onNewProject, onClose }: MProjectSwitchSheetViewProps) {
  const copy = useVocabOptional();
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ padding: '0 2px 8px', fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>
        {copy.projSwitch}
      </div>
      <MGroup inset={58}>
        {current && <SwitchRow key={current.id} row={current} current onSwitch={onClose} />}
        {others.map((row) => <SwitchRow key={row.id} row={row} onSwitch={onPick} />)}
        <NewProjectRow onClick={onNewProject} />
      </MGroup>
    </MBottomSheet>
  );
}

/** The 会话 header's project switcher: picking a project rescopes the list in place. */
export function MProjectSwitchSheet({ currentProjectId, onPick, onNewProject, onClose }: {
  currentProjectId: string | null;
  onPick: (id: string) => void;
  onNewProject: () => void;
  onClose: () => void;
}) {
  const { current, others } = useProjectSwitchSheetRows(currentProjectId);
  return <MProjectSwitchSheetView current={current} others={others}
    onPick={onPick} onNewProject={onNewProject} onClose={onClose} />;
}
