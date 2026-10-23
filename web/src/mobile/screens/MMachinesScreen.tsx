import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { promptDialog, useToast } from '@/design';
import { useLang, useVocab } from '@/i18n';
import { MC } from '@/mobile/ui/kit';
import { MSettingsPage } from './MSettingsControls';
import {
  useMachinesResource,
  type MachineDetailResource,
  type MachinesResource,
} from '@/features/machines/useMachinesResource';
import { MMachinesView, type MMachineDetailPanel } from './MMachinesView';
import { buildMMachinesVm } from './m-machines-vm';

function detailPanel(detail: MachineDetailResource | undefined): MMachineDetailPanel | null {
  if (!detail || detail.status === 'offline') return null;
  if (detail.status === 'error') return { status: 'error', vm: null, uptime: '' };
  if (detail.status === 'probing') return { status: 'probing', vm: null, uptime: '' };
  return { status: 'ready', vm: detail.facts, uptime: detail.uptime };
}

function useAddMachine(resource: MachinesResource) {
  const L = useVocab();
  const { toast } = useToast();
  return async () => {
    const name = await promptDialog({
      title: L.stAddMachineTitle, description: L.stAddMachineDesc,
      inputLabel: L.stAddMachineName, confirmLabel: L.stAddMachineSubmit,
    });
    if (!name) return;
    try {
      await resource.requestAddMachine(name);
      toast({ title: L.stToastQueuedApproval, tone: 'waiting' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({ title: `${L.stToastCouldNotQueue}: ${message}`, tone: 'failed' });
    }
  };
}

export function MMachinesScreen() {
  const navigate = useNavigate();
  const lang = useLang();
  const L = useVocab();
  const [expanded, setExpanded] = useState<string | null>(null);
  const resource = useMachinesResource(expanded ? [expanded] : []);
  const vm = useMemo(() => buildMMachinesVm(resource.machines, lang, Date.now()), [resource.machines, lang]);
  const panel = detailPanel(expanded ? resource.detailFor(expanded) : undefined);
  const requestAdd = useAddMachine(resource);
  return <>{resource.loading
    ? <MSettingsPage title={L.stNavMachines} onBack={() => mobileHeaderBack(navigate, '/m/settings')}>
        <div style={{ color: MC.muted, fontSize: 13 }}>{L.machEmpty}</div></MSettingsPage>
    : <MMachinesView vm={vm} onBack={() => mobileHeaderBack(navigate, '/m/settings')}
      expanded={expanded} onToggle={(name) => setExpanded((old) => old === name ? null : name)}
      panel={panel} onAdd={requestAdd} addDisabled={resource.addPending} />}
  </>;
}
