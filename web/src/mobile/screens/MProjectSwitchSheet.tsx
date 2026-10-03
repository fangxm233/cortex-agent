import { MBottomSheet, MGroup, MC } from '@/mobile/ui/kit';
import type { MProjectSwitchRow } from './m-project-vm';
import { NewProjectRow, SwitchRow, type MProjectSwitchCopy } from './MProjectSwitchRows';
import { useProjectSwitchSheetRows } from './useMProjectSwitch';

export interface MProjectSwitchSheetViewProps {
  copy: MProjectSwitchCopy;
  current: MProjectSwitchRow | null;
  others: MProjectSwitchRow[];
  onPick: (id: string) => void;
  onNewProject: () => void;
  onClose: () => void;
}

export function MProjectSwitchSheetView({ copy, current, others, onPick, onNewProject, onClose }: MProjectSwitchSheetViewProps) {
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ padding: '0 2px 8px', fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>
        {copy.switchProject}
      </div>
      <MGroup inset={58}>
        {current && <SwitchRow key={current.id} row={current} copy={copy} current onSwitch={onClose} />}
        {others.map((row) => <SwitchRow key={row.id} row={row} copy={copy} onSwitch={onPick} />)}
        <NewProjectRow copy={copy} onClick={onNewProject} />
      </MGroup>
    </MBottomSheet>
  );
}

/** The 会话 header's project switcher: picking a project rescopes the list in place. */
export function MProjectSwitchSheet({ currentProjectId, copy, onPick, onNewProject, onClose }: {
  currentProjectId: string | null;
  copy: MProjectSwitchCopy;
  onPick: (id: string) => void;
  onNewProject: () => void;
  onClose: () => void;
}) {
  const { current, others } = useProjectSwitchSheetRows(currentProjectId);
  return <MProjectSwitchSheetView copy={copy} current={current} others={others}
    onPick={onPick} onNewProject={onNewProject} onClose={onClose} />;
}
