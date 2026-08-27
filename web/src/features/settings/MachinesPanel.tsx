// input:  shared machines resource, localized desktop copy and settings primitives
// output: desktop machine registry table and approval-gated Add machine action
// pos:    Desktop Machines settings resource adapter and independent view
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { CSSProperties } from 'react';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useMachinesResource } from '@/features/machines/useMachinesResource';
import { useVocab } from '@/i18n';
import { SCard, SCardHeader } from './settings-ui';

const MONO = "'IBM Plex Mono',monospace";
const GRID = '110px 1fr 44px 120px 90px 96px';
const TH: CSSProperties = {
  fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', color: 'var(--proto-muted-3)',
};

function MachineTableHeader() {
  const L = useVocab();
  return <div style={{ display: 'grid', gridTemplateColumns: GRID, padding: '7px 14px',
    borderBottom: '1px solid var(--proto-line-soft)', ...TH }}>
    <span>{L.stColName}</span><span>{L.stColCortexPath}</span><span>{L.mGpu}</span>
    <span>{L.stColSsh}</span><span>{L.stColOs}</span><span />
  </div>;
}

function MachineRow({ machine }: { machine: MachineInfo }) {
  const L = useVocab();
  const mono = { font: `400 9.5px ${MONO}`, color: 'var(--proto-muted)' };
  return <div style={{ display: 'grid', gridTemplateColumns: GRID, padding: '9px 14px',
    borderBottom: '1px solid var(--proto-alt)', alignItems: 'center' }}>
    <span style={{ font: `600 10.5px ${MONO}`, color: 'var(--proto-ink)' }}>{machine.name}</span>
    <span style={{ ...mono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      paddingRight: 8 }}>{machine.cortexPath ?? '—'}</span>
    <span style={{ font: `400 10px ${MONO}`, color: 'var(--proto-ink-2)' }}>{machine.gpuCount ?? '—'}</span>
    <span style={{ ...mono, color: machine.sshConfigured ? 'var(--proto-muted)' : 'var(--proto-faint)' }}>
      {machine.sshConfigured ? L.stConfigured : L.stMachineLocal}
    </span>
    <span style={mono}>{machine.os === 'windows' ? L.stWinOs : L.stUnixOs}</span>
    <span title="No machine logs/registry backend op — inert" style={{ fontSize: 10, fontWeight: 600,
      color: 'var(--proto-faint)', textAlign: 'right', cursor: 'not-allowed' }}>{L.stLogs}</span>
  </div>;
}

function AddMachineRow({ disabled, onAdd }: { disabled: boolean; onAdd: () => void }) {
  const L = useVocab();
  return <div onClick={disabled ? undefined : onAdd} role="button" data-add-machine=""
    aria-disabled={disabled} title={L.stAddMachineApprovalTitle}
    style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px',
      cursor: disabled ? 'not-allowed' : 'pointer' }}>
    <span style={{ fontSize: 11, fontWeight: 600,
      color: disabled ? 'var(--proto-faint)' : 'var(--proto-accent)' }}>{L.stAddMachine}</span>
    <span style={{ font: `400 9px ${MONO}`, color: 'var(--proto-faint)' }}>{L.stMachineFieldsHint}</span>
  </div>;
}

function MonoInfoRow({ k, v }: { k: string; v: string }) {
  return <div style={{ display: 'flex' }}><span>{k}</span>
    <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: 'var(--proto-ink)' }}>{v}</span>
  </div>;
}

function MachineGuidance() {
  const L = useVocab();
  const body = { padding: '8px 14px', fontSize: 10.5, lineHeight: 2, color: 'var(--proto-muted)' };
  return <>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12, alignItems: 'start' }}>
      <SCard><SCardHeader title={L.stClientLifecycle} right="client-manager" /><div style={body}>
        <MonoInfoRow k={L.mHeartbeat} v="5s · 15s timeout" />
        <MonoInfoRow k={L.mRecover} v="SSH restart · 60s backoff" />
        <MonoInfoRow k="PID" v="data/client-pids.json" /><MonoInfoRow k="WebSocket" v=":3002 · CORTEX_CLIENT_TOKEN" />
      </div></SCard>
      <SCard><SCardHeader title={L.stConnectivity} right="cortex-client.json" /><div style={body}>
        <MonoInfoRow k="LAN" v="serverHost = LAN IP" /><MonoInfoRow k="Tailscale" v="100.x.y.z" />
        <MonoInfoRow k="CF Tunnel" v="serverUrl = wss://…" /><MonoInfoRow k={L.mFirewall} v="STCP" />
      </div></SCard>
    </div>
    <SCard style={{ marginTop: 12, padding: '10px 14px' }}>
      <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)' }}>{L.stMachinesFootNote}</div>
    </SCard>
  </>;
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
  return <div style={{ marginTop: 12, maxWidth: 980 }}>
    <SCard style={{ overflow: 'hidden' }}><MachineTableHeader />
      {props.machines.length === 0
        ? <div style={{ padding: '12px 14px', fontSize: 11,
          color: props.error ? 'var(--proto-danger)' : 'var(--proto-muted-3)' }}>{message}</div>
        : props.machines.map((machine) => <MachineRow key={machine.name} machine={machine} />)}
      <AddMachineRow disabled={props.addPending} onAdd={props.onAdd} />
    </SCard>
    <MachineGuidance />
  </div>;
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
