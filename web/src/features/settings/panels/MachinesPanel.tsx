import type { CSSProperties } from 'react';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { promptDialog, useToast } from '@/design';
import { useMachinesResource } from '@/features/machines/useMachinesResource';
import { machineHeartbeatText } from '@/features/machines/machines-menu-vm';
import { useLang, useVocab } from '@/i18n';
import {
  ROW_STYLE,
  SCode,
  SCount,
  SLinkAction,
  SMeta,
  SNotice,
  SRowGroup,
  SSection,
} from '@/features/settings/ui/settings-ui';

const NAME_STYLE: CSSProperties = {
  width: 88, flex: 'none', fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)', overflowWrap: 'anywhere',
};
const META_STYLE: CSSProperties = {
  flex: '1 1 200px', minWidth: 0, fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--proto-muted-2)',
  overflowWrap: 'anywhere',
};

/** Online is a green dot with a soft halo; offline is a hollow ring — the machines menu's dot. */
function OnlineDot({ online }: { online: boolean }) {
  const L = useVocab();
  const label = online ? L.mOnline : L.mOffline;
  return (
    <span style={{ width: 16, flex: 'none', display: 'inline-flex', justifyContent: 'center' }}>
      <span role="img" aria-label={label} title={label} data-machine-status={online ? 'online' : 'offline'} style={{
        width: 7, height: 7, borderRadius: '50%', boxSizing: 'border-box',
        ...(online
          ? { background: 'var(--proto-success)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--proto-success) 15%, transparent)' }
          : { border: '1.5px solid var(--proto-faint)' }),
      }} />
    </span>
  );
}

/** The right-hand word: this machine, its last heartbeat, or offline. */
function machineTrailing(machine: MachineInfo, heartbeat: string, L: ReturnType<typeof useVocab>): string {
  if (!machine.sshConfigured) return L.stMachineLocal;
  if (machine.online && heartbeat) return heartbeat;
  return machine.online ? L.mOnline : L.mOffline;
}

function MachineRow({ machine }: { machine: MachineInfo }) {
  const L = useVocab();
  const lang = useLang();
  const trailing = machineTrailing(machine, machineHeartbeatText(machine, lang), L);
  return (
    <div data-settings-machine={machine.name} style={{ ...ROW_STYLE, flexWrap: 'wrap', rowGap: 2 }}>
      <OnlineDot online={machine.online} />
      <span style={NAME_STYLE}>{machine.name}</span>
      <span style={META_STYLE}>
        {machine.cortexPath ? <SCode>{machine.cortexPath}</SCode> : '—'}
        {` · ${machine.os === 'windows' ? L.stWinOs : L.stUnixOs} · ${L.mGpu} ${machine.gpuCount ?? '—'}`}
      </span>
      <SMeta>{trailing}</SMeta>
    </div>
  );
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
    {L.machines}<SCount tone="quiet">{count}</SCount>
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
  return (
    <SSection label={<MachinesHeading count={props.machines.length} />}
      action={<AddMachineAction disabled={props.addPending} onAdd={props.onAdd} />}>
      {props.machines.length === 0
        ? <SNotice tone={props.error ? 'danger' : 'muted'}>{message}</SNotice>
        : <SRowGroup>{props.machines.map((machine) => <MachineRow key={machine.name} machine={machine} />)}</SRowGroup>}
    </SSection>
  );
}

export function MachinesPanel() {
  // Registration is high privilege: this only queues approvals.request and never writes machines.json.
  const L = useVocab();
  const { toast } = useToast();
  const machines = useMachinesResource();
  const onAdd = async () => {
    const name = await promptDialog({
      title: L.stAddMachineTitle, description: L.stAddMachineDesc,
      inputLabel: L.stAddMachineName, confirmLabel: L.stAddMachineSubmit,
    });
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
