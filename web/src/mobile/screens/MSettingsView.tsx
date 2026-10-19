import type { CSSProperties } from 'react';
import type { ConnectionStatus } from '@/features/connection/connection-status';
import { connectionDot, connectionLabelKey } from '@/features/connection/connection-status';
import { getSettingsNavGroups, type SettingsNavGroup, type SettingsSectionKey } from '@/features/settings/settings-nav';
import { fmt, useVocab, type Vocab } from '@/i18n';
import { BUILD_STAMP } from '@/lib/build-info';
import { MC } from '@/mobile/ui/kit';
import { MSET_INSET, MSettingsGroup, MSettingsHeader as MDrillHeader, MSettingsSection,
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
const META = { fontSize: 12, color: MC.muted, flex: 'none' } as const;
const CHEVRON = <span aria-hidden="true" style={{ color: MC.faint, fontSize: 15, flex: 'none' }}>›</span>;
const ROW: CSSProperties = {
  width: '100%', minHeight: 44, border: 0, background: 'transparent', padding: `12px ${MSET_INSET}px`,
  display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
};

function DaemonRow(props: Pick<MSettingsViewProps, 'connectionStatus' | 'onOpenDaemon'>) {
  const L = useVocab();
  const dot = connectionDot(props.connectionStatus);
  return (
    <button type="button" onClick={props.onOpenDaemon} data-settings-daemon style={ROW}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: dot.color, flex: 'none' }} />
      <span style={TITLE}>{L.dmnTitle}</span>
      <span style={{ ...META, marginLeft: 'auto' }}>{L[connectionLabelKey(props.connectionStatus)]}</span>
      {CHEVRON}
    </button>
  );
}

function modelSummary(vm: MSettingsVm): string | undefined {
  const value = [vm.modelLabel, vm.thinking].filter(Boolean).join(' · ');
  return value || undefined;
}

function ModelRow(props: MSettingsViewProps) {
  const L = useVocab();
  const summary = modelSummary(props.vm);
  return (
    <button type="button" data-settings-entry="models" onClick={() => props.onOpenSection('models')} style={ROW}>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ ...TITLE, display: 'block' }}>{L.stDefaultModel}</span>
        {summary && <span style={{ ...SUB, display: 'block' }}>{summary}</span>}
      </span>
      <span style={{ fontSize: 13, color: MC.run, maxWidth: '35%' }}>
        {L.setSwitchModel}
      </span>
    </button>
  );
}

function summaries(props: MSettingsViewProps, L: Vocab): Partial<Record<SettingsSectionKey, string>> {
  return { machines: fmt(L.setMachinesOnline, { n: props.onlineMachines }) };
}

function SettingsRow(props: {
  section: SettingsSectionKey;
  label: string;
  summary?: string;
  onOpen: (section: SettingsSectionKey) => void;
}) {
  const L = useVocab();
  const desktopOnly = DESKTOP_ONLY.has(props.section);
  const note = desktopOnly ? L.setEditOnDesktop : INSPECT_ONLY.has(props.section) ? L.setViewOnly : null;
  const onClick = desktopOnly ? undefined : () => props.onOpen(props.section);
  return (
    <button type="button" data-settings-entry={props.section} onClick={onClick}
      aria-disabled={desktopOnly || undefined}
      style={{ ...ROW, cursor: onClick ? 'pointer' : 'default' }}>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ ...TITLE, display: 'block' }}>{props.label}</span>
        {props.summary && <span style={{ ...SUB, display: 'block' }}>{props.summary}</span>}
      </span>
      {note && <span style={META}>{note}</span>}
      {onClick && CHEVRON}
    </button>
  );
}

function UpdateRow(props: Pick<MSettingsViewProps, 'checkingUpdates' | 'onCheckUpdates'>) {
  const L = useVocab();
  return (
    <button type="button" data-settings-updates disabled={props.checkingUpdates} onClick={props.onCheckUpdates}
      style={{ ...ROW, opacity: props.checkingUpdates ? 0.6 : 1 }}>
      <span style={TITLE}>{props.checkingUpdates ? L.updateCheckBusy : L.mHelpUpdates}</span>
      <span style={{ marginLeft: 'auto', display: 'flex' }}>{CHEVRON}</span>
    </button>
  );
}

/** Models open from the default-model row above, so the nav drops them; System closes with the update check. */
function NavSection(props: MSettingsViewProps & { group: SettingsNavGroup }) {
  const L = useVocab();
  const sub = summaries(props, L);
  const entries = props.group.entries.filter((entry) => entry.key !== 'models');
  return (
    <MSettingsSection title={props.group.label}>
      {entries.map((entry) => (
        <SettingsRow key={entry.key} section={entry.key} label={entry.label}
          summary={sub[entry.key]} onOpen={props.onOpenSection} />
      ))}
      {props.group.key === 'system' && <UpdateRow checkingUpdates={props.checkingUpdates} onCheckUpdates={props.onCheckUpdates} />}
    </MSettingsSection>
  );
}

function Footer() {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: `0 ${MSET_INSET}px`, fontSize: 12.5, color: MC.faint, fontVariantNumeric: 'tabular-nums' }}>
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
        <MSettingsGroup>
          <DaemonRow connectionStatus={props.connectionStatus} onOpenDaemon={props.onOpenDaemon} />
          <ModelRow {...props} />
        </MSettingsGroup>
        {getSettingsNavGroups(L).map((group) => <NavSection key={group.key} {...props} group={group} />)}
        <Footer />
      </MScrollBody>
    </MScreen>
  );
}
