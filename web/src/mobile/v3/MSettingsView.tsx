// input:  canonical settings nav, mobile facts, and connection state
// output: mobile settings index with honest interactive capabilities
// pos:    Presentational mobile settings view preserving dedicated profile chrome
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ReactNode } from 'react';
import type { ConnectionStatus } from '@/features/connection/connection-status';
import { connectionDot, connectionLabelKey } from '@/features/connection/connection-status';
import { getSettingsNav, type SettingsSectionKey } from '@/features/settings/settings-nav';
import { useVocab } from '@/i18n';
import { BUILD_STAMP } from '@/lib/build-info';
import { MCard, MDrillHeader, MScreen, MScrollBody, MC, MONO } from '@/mobile/ui/kit';
import type { MSettingsVm } from './m-settings-vm';

export interface MSettingsCopy {
  title: string;
  daemon: string;
  machinesOk: string;
  desktopOnly: string;
  inspectOnly: string;
  footerBrand: string;
  switchProfile: string;
}

interface MSettingsViewProps {
  vm: MSettingsVm;
  copy: MSettingsCopy;
  onBack: () => void;
  onOpenDaemon: () => void;
  onlineMachines: number;
  connectionStatus: ConnectionStatus;
  onOpenSection: (section: SettingsSectionKey) => void;
}

const DESKTOP_ONLY = new Set<SettingsSectionKey>(['templates', 'plugins']);
const INSPECT_ONLY = new Set<SettingsSectionKey>(['hooks']);
const TITLE = { fontSize: 14, fontWeight: 600, color: MC.ink } as const;
const SUB = { font: `400 10px ${MONO}`, color: MC.muted, marginTop: 2 } as const;

function StatusBadge({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 9.5, fontWeight: 600, padding: '2px 7px', borderRadius: 999,
      background: MC.gray, color: MC.grayInk, flex: 'none' }}>
      {children}
    </span>
  );
}

function DaemonRow(props: Pick<MSettingsViewProps, 'copy' | 'connectionStatus' | 'onOpenDaemon'>) {
  const L = useVocab();
  const dot = connectionDot(props.connectionStatus);
  return (
    <button type="button" onClick={props.onOpenDaemon} data-settings-daemon
      style={{ width: '100%', border: 0, background: 'transparent', padding: '12px 13px',
        display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left' }}>
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: dot.color,
        animation: dot.pulse ? 'cxpulse 1.6s ease-in-out infinite' : undefined }} />
      <span style={TITLE}>{props.copy.daemon}</span>
      <span style={{ marginLeft: 'auto', fontSize: 10, color: dot.color }}>
        {L[connectionLabelKey(props.connectionStatus)]}
      </span>
      <span style={{ color: MC.faint }}>›</span>
    </button>
  );
}

function profileSummary(vm: MSettingsVm): string | undefined {
  const value = [vm.profileName, vm.profileModel, vm.profileThinking].filter(Boolean).join(' · ');
  return value || undefined;
}

function ProfileCard(props: MSettingsViewProps) {
  const L = useVocab();
  const summary = profileSummary(props.vm);
  return (
    <MCard padding={0}>
      <button type="button" data-settings-entry="profiles"
        onClick={() => props.onOpenSection('profiles')}
        style={{ width: '100%', border: 0, background: 'transparent', padding: '12px 13px',
          display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left' }}>
        <span style={{ width: 34, height: 34, borderRadius: 9, background: MC.runBg, color: MC.run,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          font: `600 11px ${MONO}`, flex: 'none' }}>P</span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ ...TITLE, display: 'block' }}>{L.stNavProfiles}</span>
          {summary && <span style={{ ...SUB, display: 'block' }}>{summary}</span>}
        </span>
        <span style={{ font: `500 10px ${MONO}`, color: MC.run, flex: 'none' }}>
          {props.copy.switchProfile}
        </span>
      </button>
    </MCard>
  );
}

function summaries(props: MSettingsViewProps): Partial<Record<SettingsSectionKey, string>> {
  return { machines: `${props.onlineMachines} ${props.copy.machinesOk}` };
}

function SettingsRow(props: {
  section: SettingsSectionKey;
  label: string;
  summary?: string;
  copy: MSettingsCopy;
  last: boolean;
  onOpen: (section: SettingsSectionKey) => void;
}) {
  const desktopOnly = DESKTOP_ONLY.has(props.section);
  const badge = desktopOnly ? props.copy.desktopOnly : INSPECT_ONLY.has(props.section) ? props.copy.inspectOnly : null;
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
  const nav = getSettingsNav(L).filter((entry) => entry.key !== 'profiles');
  const sub = summaries(props);
  return (
    <MCard padding={0} style={{ overflow: 'hidden' }}>
      {nav.map((entry, index) => (
        <SettingsRow key={entry.key} section={entry.key} label={entry.label}
          summary={sub[entry.key]} copy={props.copy} last={index === nav.length - 1}
          onOpen={props.onOpenSection} />
      ))}
    </MCard>
  );
}

function Footer({ copy }: { copy: MSettingsCopy }) {
  return (
    <div style={{ display: 'flex', gap: 7, padding: '2px 4px', font: `400 9.5px ${MONO}`, color: MC.faint }}>
      <span>{copy.footerBrand}</span><span style={{ marginLeft: 'auto' }}>build {BUILD_STAMP}</span>
    </div>
  );
}

export function MSettingsView(props: MSettingsViewProps) {
  return (
    <MScreen label="1l Settings" header={
      <MDrillHeader onBack={props.onBack}>
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>{props.copy.title}</div>
      </MDrillHeader>
    }>
      <MScrollBody gap={10}>
        <MCard padding={0}><DaemonRow copy={props.copy} connectionStatus={props.connectionStatus}
          onOpenDaemon={props.onOpenDaemon} /></MCard>
        <ProfileCard {...props} />
        <SettingsList {...props} />
        <Footer copy={props.copy} />
      </MScrollBody>
    </MScreen>
  );
}
