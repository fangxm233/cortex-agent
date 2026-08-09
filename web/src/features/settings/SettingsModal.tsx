// input:  config queries, settings panels, login handoff
// output: settings shell with bounded panel content
// pos:    Desktop settings modal and section router
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as RadixDialog from '@radix-ui/react-dialog';
import { useEffect, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigSnapshot, CostSummary } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useLoginFlow } from '@/features/auth/LoginFlowProvider';
import { getSettingsNav, getSectionMeta, type SettingsSectionKey } from './settings-nav';
import { PlatformPanel, MachinesPanel, McpPanel } from './SettingsPanels';
import { ProfilesPanel } from './ProfilesPanel';
import { AdvancedPanel, NotificationsPanel } from './RuntimeSettingsPanels';
import { BudgetPanel } from './BudgetPanel';
import { HooksPanel } from './HooksPanel';
import { TemplatesPanel } from './TemplatesPanel';
import { AppearancePanel } from './AppearancePanel';
import { AccountsPanel } from './AccountsPanel';
import { PluginsPanel } from './PluginsPanel';

const MONO = "'IBM Plex Mono',monospace";

const BACKDROP_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(25,28,34,.34)',
  zIndex: 60,
};

const MODAL_STYLE: CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%,-50%)',
  width: 1080,
  maxWidth: '94vw',
  height: 680,
  maxHeight: '90vh',
  background: 'var(--proto-card)',
  borderRadius: 14,
  boxShadow: '0 24px 64px rgba(16,24,40,.3)',
  zIndex: 61,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

function isBoundedPanel(section: SettingsSectionKey): boolean {
  return section === 'hooks' || section === 'templates' || section === 'plugins';
}

function panelContentStyle(section: SettingsSectionKey): CSSProperties {
  const bounded = isBoundedPanel(section);
  return {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: bounded ? 'hidden' : 'auto',
    padding: '16px 22px',
    background: 'var(--proto-alt)',
    display: bounded ? 'flex' : undefined,
    flexDirection: bounded ? 'column' : undefined,
  };
}

function resetPluginsDirty(open: boolean, setDirty: (dirty: boolean) => void): void {
  if (!open) setDirty(false);
}

function requestSettingsClose(dirty: boolean, onClose: () => void): void {
  if (!dirty) onClose();
}

function dialogOpenChanged(next: boolean, requestClose: () => void): void {
  if (!next) requestClose();
}

function OpenSettingsBody(props: SettingsBodyProps & { open: boolean }) {
  if (!props.open) return null;
  const { open: _open, ...bodyProps } = props;
  return <SettingsBody {...bodyProps} />;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const L = useVocab();
  const [pluginsDirty, setPluginsDirty] = useState(false);
  useEffect(() => resetPluginsDirty(open, setPluginsDirty), [open]);
  const requestClose = () => requestSettingsClose(pluginsDirty, onClose);
  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => dialogOpenChanged(next, requestClose)}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay style={BACKDROP_STYLE} className="animate-cxfade motion-reduce:animate-none" />
        <RadixDialog.Content aria-describedby={undefined} style={MODAL_STYLE} className="animate-cxmodal focus:outline-none motion-reduce:animate-none">
          <RadixDialog.Title style={SR_ONLY}>{L.settings}</RadixDialog.Title>
          <OpenSettingsBody open={open} onClose={requestClose} pluginsDirty={pluginsDirty}
            onPluginDirtyChange={setPluginsDirty} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function SettingsHeader(props: { onClose: () => void; closeBlocked: boolean }) {
  const L = useVocab();
  return (
    <div style={{ height: 48, flex: 'none', borderBottom: '1px solid var(--proto-line)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 18px', background: 'var(--proto-card)' }}>
      <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.settings}</span>
      <button type="button" disabled={props.closeBlocked} onClick={props.onClose}
        title={props.closeBlocked ? L.plUnsavedLeave : undefined}
        style={{ marginLeft: 'auto', font: `500 9.5px ${MONO}`, color: 'var(--proto-muted-3)', background: 'transparent', border: '1px solid var(--proto-line)', borderRadius: 5, padding: '2px 6px', cursor: props.closeBlocked ? 'not-allowed' : 'pointer' }}>
        {L.stEsc}
      </button>
    </div>
  );
}

function navButtonStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    width: '100%', border: 0, display: 'flex', alignItems: 'center', gap: 8,
    padding: '7px 10px',
    background: active ? 'var(--proto-accent-bg)' : 'transparent',
    borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

function SettingsNav(props: {
  section: SettingsSectionKey;
  blocked: boolean;
  onSelect: (key: SettingsSectionKey) => void;
}) {
  const L = useVocab();
  return (
    <div style={{ width: 210, flex: 'none', borderRight: '1px solid var(--proto-line)', background: 'var(--proto-rail)', padding: '10px 8px', overflow: 'auto' }}>
      {getSettingsNav(L).map((entry) => {
        const active = entry.key === props.section;
        const disabled = props.blocked && !active;
        return (
          <button type="button" key={entry.key} disabled={disabled}
            onClick={() => props.onSelect(entry.key)} data-settings-nav={entry.key}
            title={disabled ? L.plUnsavedLeave : undefined}
            style={navButtonStyle(active, disabled)}>
            <span style={{ fontSize: 12, fontWeight: 600, color: active ? 'var(--proto-accent)' : 'var(--proto-ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.label}</span>
          </button>
        );
      })}
    </div>
  );
}

interface SectionContentProps {
  section: SettingsSectionKey;
  onClose: () => void;
  snapshot: ConfigSnapshot | undefined;
  cost: CostSummary | undefined;
  configLoading: boolean;
  configError: { message: string } | null;
  onSetDefaultProfile: (name: string) => void;
  onReconnect: (platform: 'slack' | 'feishu') => void;
  onAddMachine: (machineName: string) => void;
  onPluginDirtyChange: (dirty: boolean) => void;
}

function IndependentSettingsPanel(
  props: Pick<SectionContentProps, 'section' | 'onClose' | 'onPluginDirtyChange'>,
) {
  const { openLogin } = useLoginFlow();
  switch (props.section) {
    case 'appearance': return <AppearancePanel />;
    case 'accounts':
      return <AccountsPanel onLogin={(target) => { props.onClose(); openLogin(target); }} />;
    case 'plugins': return <PluginsPanel onDirtyChange={props.onPluginDirtyChange} />;
    default: return null;
  }
}

function ConfiguredSettingsPanel(props: SectionContentProps) {
  const L = useVocab();
  if (props.configLoading) {
    return <div style={{ marginTop: 16, fontSize: 12, color: 'var(--proto-muted-3)' }}>{L.stLoadingConfig}</div>;
  }
  if (props.configError) {
    return <div style={{ marginTop: 16, fontSize: 12, color: 'var(--proto-danger)' }}>{L.stFailedLoadConfig} {props.configError.message}</div>;
  }
  if (!props.snapshot) return null;
  return <PanelBody {...props} snapshot={props.snapshot} />;
}

function SettingsSectionContent(props: SectionContentProps) {
  const independent = ['appearance', 'accounts', 'plugins'].includes(props.section);
  return independent ? <IndependentSettingsPanel {...props} /> : <ConfiguredSettingsPanel {...props} />;
}

function useSettingsActions() {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const setProfile = useMutation(trpc.config.set.mutationOptions({
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries(trpc.config.get.queryFilter({}));
      const name = vars.section === 'profiles' ? vars.value.defaultProfile : '';
      toast({ title: `Default profile → ${name} · ${L.stToastDefaultProfile}`, tone: 'done' });
    },
    onError: (error) => toast({ title: `${L.stToastWriteFailed}: ${error.message}`, tone: 'failed' }),
  }));
  const requestApproval = useMutation(trpc.approvals.request.mutationOptions({
    onSuccess: () => toast({ title: L.stToastQueuedApproval, tone: 'waiting' }),
    onError: (error) => toast({ title: `${L.stToastCouldNotQueue}: ${error.message}`, tone: 'failed' }),
  }));
  return { setProfile, requestApproval };
}

interface SettingsBodyProps {
  onClose: () => void;
  pluginsDirty: boolean;
  onPluginDirtyChange: (dirty: boolean) => void;
}

function SettingsBody(props: SettingsBodyProps) {
  const L = useVocab();
  const trpc = useTRPC();
  const [section, setSection] = useState<SettingsSectionKey>('appearance');
  const config = useQuery(trpc.config.get.queryOptions({}));
  const cost = useQuery(trpc.cost.summary.queryOptions({}));
  const actions = useSettingsActions();
  const content = {
    section, onClose: props.onClose, snapshot: config.data, cost: cost.data,
    configLoading: config.isLoading,
    onPluginDirtyChange: props.onPluginDirtyChange,
    configError: config.isError ? config.error : null,
    onSetDefaultProfile: (name: string) => actions.setProfile.mutate({ section: 'profiles', value: { defaultProfile: name } }),
    onReconnect: (platform: 'slack' | 'feishu') => actions.requestApproval.mutate({ kind: 'reconnect-platform', platform }),
    onAddMachine: (machineName: string) => actions.requestApproval.mutate({ kind: 'add-machine', machineName }),
  };
  return (
    <>
      <SettingsHeader onClose={props.onClose} closeBlocked={props.pluginsDirty} />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <SettingsNav section={section} blocked={props.pluginsDirty} onSelect={setSection} />
        <div style={panelContentStyle(section)}>
          <div style={{ fontSize: 15, fontWeight: 650, color: 'var(--proto-ink)' }}>{getSectionMeta(L, section).title}</div>
          <SettingsSectionContent {...content} />
        </div>
      </div>
    </>
  );
}

interface PanelBodyProps extends SectionContentProps {
  snapshot: ConfigSnapshot;
}

type PanelRenderer = (props: PanelBodyProps) => JSX.Element;

const PANEL_RENDERERS: Partial<Record<SettingsSectionKey, PanelRenderer>> = {
  platform: (props) => <PlatformPanel snapshot={props.snapshot} onReconnect={props.onReconnect} />,
  profiles: (props) => <ProfilesPanel snapshot={props.snapshot} onSetDefaultProfile={props.onSetDefaultProfile} />,
  budget: (props) => <BudgetPanel snapshot={props.snapshot} cost={props.cost} />,
  machines: (props) => <MachinesPanel snapshot={props.snapshot} onAddMachine={props.onAddMachine} />,
  templates: () => <TemplatesPanel />,
  mcp: (props) => <McpPanel snapshot={props.snapshot} />,
  notifications: (props) => <NotificationsPanel snapshot={props.snapshot} />,
  hooks: () => <HooksPanel />,
  advanced: (props) => <AdvancedPanel snapshot={props.snapshot} />,
};

function PanelBody(props: PanelBodyProps) {
  const render = PANEL_RENDERERS[props.section];
  return render ? render(props) : null;
}
