import '@/features/settings/ui/desktop-panels.css';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useMachinesResource } from '@/features/machines/useMachinesResource';
import { useVocab } from '@/i18n';
import {
  SCount,
  SDot,
  SEntityName,
  SEntityRow,
  SLinkAction,
  SNotice,
  SPill,
  SSection,
} from '@/features/settings/ui/settings-ui';

function MachineEntity({ machine }: { machine: MachineInfo }) {
  const L = useVocab();
  const ssh = machine.sshConfigured;
  return <SEntityRow
    dot={<SDot color={ssh ? 'var(--proto-success)' : 'var(--proto-line-3)'} />}
    name={<SEntityName>{machine.name}</SEntityName>}
    meta={`${machine.cortexPath ?? '—'} · ${machine.os === 'windows' ? L.stWinOs : L.stUnixOs} · ${L.mGpu} ${machine.gpuCount ?? '—'}`}
    trailing={<div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <SPill tone={ssh ? 'success' : 'neutral'}>{ssh ? L.stConfigured : L.stMachineLocal}</SPill>
      <SLinkAction tone="muted" disabled title={L.stMachineLogsUnavailable}>
        {L.stLogs}
      </SLinkAction>
    </div>} />;
}

function AddMachineAction({ disabled, onAdd }: { disabled: boolean; onAdd: () => void }) {
  const L = useVocab();
  return <SLinkAction onClick={disabled ? undefined : onAdd} disabled={disabled} role="button"
    data-add-machine="" aria-disabled={disabled} title={L.stAddMachineApprovalTitle}>
    {L.stAddMachine}
  </SLinkAction>;
}

function MachinesHeading({ count }: { count: number }) {
  const L = useVocab();
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
    {L.machines}<SCount tone="accent">{count}</SCount>
  </span>;
}

export interface MachinesPanelViewProps {
  machines: MachineInfo[];
  loading: boolean;
  error: Error | null;
  addPending: boolean;
  onAdd: () => void;
}

export function MachinesPanelView(props: MachinesPanelViewProps) {
  const L = useVocab();
  const message = props.loading ? L.stLoadingConfig
    : props.error ? `${L.stFailedLoadConfig} ${props.error.message}` : L.stNoMachinesFile;
  return <>
    <SSection label={<MachinesHeading count={props.machines.length} />}
      action={<AddMachineAction disabled={props.addPending} onAdd={props.onAdd} />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {props.machines.length === 0
          ? <SNotice tone={props.error ? 'danger' : 'muted'}>{message}</SNotice>
          : props.machines.map((machine) => <MachineEntity key={machine.name} machine={machine} />)}
      </div>
    </SSection>
  </>;
}

export function MachinesPanel() {
  // Registration is high privilege: this only queues approvals.request and never writes machines.json.
  const L = useVocab();
  const { toast } = useToast();
  const machines = useMachinesResource();
  const onAdd = async () => {
    const name = window.prompt(L.stAddMachinePrompt)?.trim();
    if (!name) return;
    try {
      await machines.requestAddMachine(name);
      toast({ title: L.stToastQueuedApproval, tone: 'waiting' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({ title: `${L.stToastCouldNotQueue}: ${message}`, tone: 'failed' });
    }
  };
  return <MachinesPanelView machines={machines.machines} loading={machines.loading}
    error={machines.error} addPending={machines.addPending} onAdd={onAdd} />;
}
