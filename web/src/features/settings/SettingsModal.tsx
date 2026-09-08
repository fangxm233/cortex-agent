// input:  config queries, panels and login handoff
// output: settings navigation and dirty-form protection
// pos:    Desktop settings modal and section router
// >>> Once updated, update this header and parent CORTEX.md <<<

import * as RadixDialog from '@radix-ui/react-dialog';
import { useEffect, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConfigSnapshot, CostSummary } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { useLoginFlow } from '@/features/auth/LoginFlowProvider';
import { getSettingsNav, getSectionMeta, type SettingsSectionKey } from './settings-nav';
import { McpPanel } from './SettingsPanels';
import { PlatformPanel } from './PlatformPanel';
import { MachinesPanel } from './MachinesPanel';
import { ProfilesPanel } from './ProfilesPanel';
import { AdvancedPanel, NotificationsPanel } from './RuntimeSettingsPanels';
import { BudgetPanel } from './BudgetPanel';
import { HooksPanel } from './HooksPanel';
import { TemplatesPanel } from './TemplatesPanel';
import { AppearancePanel } from './AppearancePanel';
import { AccountsPanel } from './AccountsPanel';
import { PluginsPanel } from './PluginsPanel';
import { UsagePanel } from '@/features/usage';

const MONO = "'IBM Plex Mono',monospace";

const BACKDROP_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--overlay-scrim)',
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
  boxShadow: 'var(--shadow-overlay-strong)',
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

function resetDirty(open: boolean, setDirty: (dirty: boolean) => void): void {
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
  // A panel holding an unsaved committed-on-save draft blocks nav and close. Today that is the
  // plugin assignment form, which lives in the templates editor.
  const [dirty, setDirty] = useState(false);
  useEffect(() => resetDirty(open, setDirty), [open]);
  const requestClose = () => requestSettingsClose(dirty, onClose);
  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => dialogOpenChanged(next, requestClose)}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay style={BACKDROP_STYLE} className="animate-cxfade motion-reduce:animate-none" />
        <RadixDialog.Content aria-describedby={undefined} style={MODAL_STYLE} className="animate-cxmodal focus:outline-none motion-reduce:animate-none">
          <RadixDialog.Title style={SR_ONLY}>{L.settings}</RadixDialog.Title>
          <OpenSettingsBody open={open} onClose={requestClose} panelDirty={dirty}
            onPanelDirtyChange={setDirty} />
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
  onPanelDirtyChange: (dirty: boolean) => void;
}

type IndependentPanelProps = Pick<
  SectionContentProps,
  'section' | 'onClose' | 'onPanelDirtyChange'
>;

type IndependentPanelRenderer = (props: IndependentPanelProps) => JSX.Element;

const INDEPENDENT_PANEL_RENDERERS: Partial<Record<SettingsSectionKey, IndependentPanelRenderer>> = {
  appearance: () => <AppearancePanel />,
  usage: () => <UsagePanel />,
  plugins: () => <PluginsPanel />,
};

function IndependentSettingsPanel(props: IndependentPanelProps) {
  const { openLogin } = useLoginFlow();
  if (props.section === 'accounts') {
    return <AccountsPanel onLogin={(target) => { props.onClose(); openLogin(target); }} />;
  }
  const render = INDEPENDENT_PANEL_RENDERERS[props.section];
  return render ? render(props) : null;
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
  const independent = ['appearance', 'accounts', 'usage', 'plugins'].includes(props.section);
  return independent ? <IndependentSettingsPanel {...props} /> : <ConfiguredSettingsPanel {...props} />;
}

function SettingsSectionTitle({ section }: { section: SettingsSectionKey }) {
  const L = useVocab();
  if (section === 'usage') return null;
  return <div style={{ fontSize: 15, fontWeight: 650, color: 'var(--proto-ink)' }}>{getSectionMeta(L, section).title}</div>;
}

interface SettingsBodyProps {
  onClose: () => void;
  panelDirty: boolean;
  onPanelDirtyChange: (dirty: boolean) => void;
}

function SettingsBody(props: SettingsBodyProps) {
  const trpc = useTRPC();
  const [section, setSection] = useState<SettingsSectionKey>('appearance');
  const config = useQuery(trpc.config.get.queryOptions({}));
  const cost = useQuery(trpc.cost.summary.queryOptions({}));
  const content = {
    section, onClose: props.onClose, snapshot: config.data, cost: cost.data,
    configLoading: config.isLoading,
    onPanelDirtyChange: props.onPanelDirtyChange,
    configError: config.isError ? config.error : null,
  };
  return (
    <>
      <SettingsHeader onClose={props.onClose} closeBlocked={props.panelDirty} />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <SettingsNav section={section} blocked={props.panelDirty} onSelect={setSection} />
        <div style={panelContentStyle(section)}>
          <SettingsSectionTitle section={section} />
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
  platform: (props) => <PlatformPanel snapshot={props.snapshot} onDirtyChange={props.onPanelDirtyChange} />,
  profiles: (props) => <ProfilesPanel snapshot={props.snapshot} />,
  budget: (props) => <BudgetPanel snapshot={props.snapshot} cost={props.cost} />,
  machines: () => <MachinesPanel />,
  templates: (props) => <TemplatesPanel onDirtyChange={props.onPanelDirtyChange} />,
  mcp: (props) => <McpPanel snapshot={props.snapshot} />,
  notifications: (props) => <NotificationsPanel snapshot={props.snapshot} />,
  hooks: () => <HooksPanel />,
  advanced: (props) => <AdvancedPanel snapshot={props.snapshot} />,
};

function PanelBody(props: PanelBodyProps) {
  const render = PANEL_RENDERERS[props.section];
  return render ? render(props) : null;
}
