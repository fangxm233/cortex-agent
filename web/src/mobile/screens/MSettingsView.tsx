import type { ReactNode } from 'react';
import type { ConnectionStatus } from '@/features/connection/connection-status';
import { connectionDot, connectionLabelKey } from '@/features/connection/connection-status';
import { getSettingsNav, type SettingsSectionKey } from '@/features/settings/settings-nav';
import { fmt, useVocab, type Vocab } from '@/i18n';
import { BUILD_STAMP } from '@/lib/build-info';
import { MC, MONO } from '@/mobile/ui/kit';
import { MSettingsSurfaceCard as MCard, MSettingsHeader as MDrillHeader,
  MSettingsFrame as MScreen, MSettingsBody as MScrollBody } from './MSettingsControls';
import type { MSettingsVm } from './m-settings-vm';

interface MSettingsViewProps {
  vm: MSettingsVm;
  onBack: () => void;
  onOpenDaemon: () => void;
  onlineMachines: number;
  connectionStatus: ConnectionStatus;
  checkingUpdates: boolean;
  onCheckUpdates: () => void;
  onOpenSection: (section: SettingsSectionKey) => void;
}

const DESKTOP_ONLY = new Set<SettingsSectionKey>(['environments', 'plugins']);
const INSPECT_ONLY = new Set<SettingsSectionKey>(['hooks']);
const TITLE = { fontSize: 14, fontWeight: 600, color: MC.ink } as const;
const SUB = { fontSize: 12, color: MC.muted, marginTop: 4 } as const;

function StatusBadge({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 7px', borderRadius: 'var(--r-pill)',
      background: MC.gray, color: MC.grayInk, flex: 'none' }}>
      {children}
    </span>
  );
}

function DaemonRow(props: Pick<MSettingsViewProps, 'connectionStatus' | 'onOpenDaemon'>) {
  const L = useVocab();
  const dot = connectionDot(props.connectionStatus);
  return (
    <button type="button" onClick={props.onOpenDaemon} data-settings-daemon
      style={{ width: '100%', border: 0, background: 'transparent', padding: '12px 13px',
        display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left' }}>
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: dot.color }} />
      <span style={TITLE}>{L.dmnTitle}</span>
      <span style={{ marginLeft: 'auto', fontSize: 12, color: dot.color }}>
        {L[connectionLabelKey(props.connectionStatus)]}
      </span>
      <span style={{ color: MC.faint }}>›</span>
    </button>
  );
}

function modelSummary(vm: MSettingsVm): string | undefined {
  const value = [vm.modelLabel, vm.thinking].filter(Boolean).join(' · ');
  return value || undefined;
}

function ModelCard(props: MSettingsViewProps) {
  const L = useVocab();
  const summary = modelSummary(props.vm);
  return (
    <MCard padding={0}>
      <button type="button" data-settings-entry="models"
        onClick={() => props.onOpenSection('models')}
        style={{ width: '100%', border: 0, background: 'transparent', padding: '12px 13px',
          display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left' }}>
        <span style={{ width: 34, height: 34, borderRadius: 'var(--r-chip)', background: MC.runBg, color: MC.run,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          font: `600 11px ${MONO}`, flex: 'none' }}>M</span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ ...TITLE, display: 'block' }}>{L.stDefaultModel}</span>
          {summary && <span style={{ ...SUB, display: 'block' }}>{summary}</span>}
        </span>
        <span style={{ fontSize: 13, color: MC.run, maxWidth: '35%' }}>
          {L.setSwitchModel}
        </span>
      </button>
    </MCard>
  );
}

function summaries(props: MSettingsViewProps, L: Vocab): Partial<Record<SettingsSectionKey, string>> {
  return { machines: fmt(L.setMachinesOnline, { n: props.onlineMachines }) };
}

function SettingsRow(props: {
  section: SettingsSectionKey;
  label: string;
  summary?: string;
  last: boolean;
  onOpen: (section: SettingsSectionKey) => void;
}) {
  const L = useVocab();
  const desktopOnly = DESKTOP_ONLY.has(props.section);
  const badge = desktopOnly ? L.setEditOnDesktop : INSPECT_ONLY.has(props.section) ? L.setViewOnly : null;
  const onClick = desktopOnly ? undefined : () => props.onOpen(props.section);
  return (
    <button type="button" data-settings-entry={props.section} onClick={onClick}
      aria-disabled={desktopOnly || undefined}
      style={{ width: '100%', border: 0, borderBottom: props.last ? undefined : `1px solid ${MC.divider}`,
        background: 'transparent', padding: '12px 13px', display: 'flex', alignItems: 'center',
        gap: 9, textAlign: 'left', cursor: onClick ? 'pointer' : 'default' }}>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ ...TITLE, display: 'block' }}>{props.label}</span>
        {props.summary && <span style={{ ...SUB, display: 'block' }}>{props.summary}</span>}
      </span>
      {badge && <StatusBadge>{badge}</StatusBadge>}
      {onClick && <span style={{ color: MC.faint, fontSize: 15 }}>›</span>}
    </button>
  );
}

function SettingsList(props: MSettingsViewProps) {
  const L = useVocab();
  const nav = getSettingsNav(L).filter((entry) => entry.key !== 'models');
  const sub = summaries(props, L);
  return (
    <MCard padding={0} style={{ overflow: 'hidden' }}>
      {nav.map((entry, index) => (
        <SettingsRow key={entry.key} section={entry.key} label={entry.label}
          summary={sub[entry.key]} last={index === nav.length - 1}
          onOpen={props.onOpenSection} />
      ))}
    </MCard>
  );
}

function UpdateRow(props: Pick<MSettingsViewProps, 'checkingUpdates' | 'onCheckUpdates'>) {
  const L = useVocab();
  return (
    <MCard padding={0}>
      <button type="button" data-settings-updates disabled={props.checkingUpdates} onClick={props.onCheckUpdates}
        style={{ width: '100%', border: 0, background: 'transparent', padding: '12px 13px',
          display: 'flex', alignItems: 'center', textAlign: 'left', opacity: props.checkingUpdates ? 0.6 : 1 }}>
        <span style={TITLE}>{props.checkingUpdates ? L.updateCheckBusy : L.mHelpUpdates}</span>
        <span style={{ marginLeft: 'auto', color: MC.faint }}>›</span>
      </button>
    </MCard>
  );
}

function Footer() {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '2px 4px', font: `400 12px ${MONO}`, color: MC.faint }}>
      <span style={{ marginLeft: 'auto' }}>{L.dmnBuild} {BUILD_STAMP}</span>
    </div>
  );
}

export function MSettingsView(props: MSettingsViewProps) {
  const L = useVocab();
  return (
    <MScreen label="1l Settings" header={
      <MDrillHeader onBack={props.onBack}>
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>{L.settings}</div>
      </MDrillHeader>
    }>
      <MScrollBody>
        <MCard padding={0}><DaemonRow connectionStatus={props.connectionStatus}
          onOpenDaemon={props.onOpenDaemon} /></MCard>
        <ModelCard {...props} />
        <SettingsList {...props} />
        <UpdateRow checkingUpdates={props.checkingUpdates} onCheckUpdates={props.onCheckUpdates} />
        <Footer />
      </MScrollBody>
    </MScreen>
  );
}
