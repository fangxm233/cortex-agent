// input:  config queries, panels, login flow, material tokens
// output: Glass settings shell, legible nav, panel header action slot and dirty-form guard
// pos:    Responsive settings shell with readable navigation
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import * as RadixDialog from '@radix-ui/react-dialog';
import { useEffect, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConfigSnapshot, CostSummary } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { BUILD_STAMP } from '@/lib/build-info';
import { useLoginFlow } from '@/features/auth/LoginFlowProvider';
import { getSettingsNavGroups, getSectionMeta, type SettingsSectionKey } from './settings-nav';
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
import { SettingsHeaderSlotContext } from './settings-kit';
import './settings-style.css';

const MONO = "'IBM Plex Mono',monospace";

const BACKDROP_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--overlay-scrim)',
  backdropFilter: 'var(--material-scrim-filter)',
  WebkitBackdropFilter: 'var(--material-scrim-filter)',
  zIndex: 60,
};

// The sheet is a row, not a column: the nav owns the title and the content pane owns its own
// header. That is the prototype's arrangement, and it is also why the sheet no longer needs a
// full-width chrome bar — the only thing that spanned both columns was the word "Settings".
const MODAL_STYLE: CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%,-50%)',
  width: 1080,
  maxWidth: '94vw',
  height: 680,
  maxHeight: '90vh',
  // The sheet filters once; scrolling cards and controls carry unfiltered tint.
  background: 'var(--material-overlay-bg)',
  backdropFilter: 'var(--glass-filter)',
  WebkitBackdropFilter: 'var(--glass-filter)',
  borderRadius: 16,
  border: '1px solid var(--proto-line-2)',
  boxSizing: 'border-box',
  boxShadow: 'var(--material-overlay-shadow)',
  zIndex: 61,
  overflow: 'hidden',
  display: 'flex',
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

// Bounded panels (the master–detail editors) own their height and need a flex frame to stretch in.
// Scrolling ones stay a block, so the stack inside them measures at its natural height instead of
// being compressed by the scroller — a flex column here would shrink every card to fit.
function panelContentStyle(section: SettingsSectionKey): CSSProperties {
  const bounded = isBoundedPanel(section);
  return {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: bounded ? 'hidden' : 'auto',
    padding: 'var(--settings-panel-padding, 20px)',
    display: bounded ? 'flex' : 'block',
    flexDirection: bounded ? 'column' : undefined,
  };
}

// Every page shares the same compact section rhythm.
const PANEL_STACK_STYLE: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 'var(--settings-section-gap, 20px)', alignItems: 'stretch',
};

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
        <RadixDialog.Content aria-describedby={undefined} style={MODAL_STYLE} className="settings-surface settings-modal animate-cxmodal focus:outline-none motion-reduce:animate-none">
          <RadixDialog.Title style={SR_ONLY}>{L.settings}</RadixDialog.Title>
          <OpenSettingsBody open={open} onClose={requestClose} panelDirty={dirty}
            onPanelDirtyChange={setDirty} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

// ── Navigation ──────────────────────────────────────────────────────────────

const NAV_STYLE: CSSProperties = {
  width: 'var(--settings-nav-width, 196px)', flex: 'none', display: 'flex', flexDirection: 'column',
  padding: '16px 10px 12px', borderRight: '1px solid var(--proto-line-2)',
  // A tint, not a fill: the nav has to read as the same pane as the content beside it, one shade
  // recessed. An opaque rail colour here would cut the sheet in two.
  background: 'var(--proto-alt)',
};

function navButtonStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    width: '100%', border: 0, display: 'flex', alignItems: 'center', gap: 9,
    minHeight: 34, padding: '6px 10px', flex: 'none',
    background: active ? 'var(--proto-accent-bg)' : 'transparent',
    color: active ? 'var(--settings-selected-ink)' : 'var(--proto-ink-2)',
    fontFamily: 'inherit', fontSize: 13, fontWeight: active ? 600 : 500,
    borderRadius: 'var(--r-control)', cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1, textAlign: 'left',
  };
}

function NavIcon({ path, active }: { path: string; active: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden
      style={{ flex: 'none', color: active ? 'var(--proto-accent)' : 'var(--proto-muted-2)' }}>
      <path d={path} />
    </svg>
  );
}

function NavGroupLabel({ children }: { children: string }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase',
      color: 'var(--proto-muted-2)', padding: '12px 10px 5px', flex: 'none',
    }}>
      {children}
    </div>
  );
}

interface SettingsNavProps {
  section: SettingsSectionKey;
  blocked: boolean;
  onSelect: (key: SettingsSectionKey) => void;
}

type NavEntry = ReturnType<typeof getSettingsNavGroups>[number]['entries'][number];

function SettingsNavEntry({ entry, ...props }: SettingsNavProps & { entry: NavEntry }) {
  const L = useVocab();
  const active = entry.key === props.section;
  const disabled = props.blocked && !active;
  return (
    <button className="settings-nav-button" type="button" disabled={disabled}
      onClick={() => props.onSelect(entry.key)} data-settings-nav={entry.key}
      title={disabled ? L.plUnsavedLeave : undefined} style={navButtonStyle(active, disabled)}>
      <NavIcon path={entry.icon} active={active} />
      <span className="settings-nav-label" style={{ flex: 1, minWidth: 0 }}>{entry.label}</span>
    </button>
  );
}

function SettingsNav(props: SettingsNavProps) {
  const L = useVocab();
  return (
    <div className="settings-nav" style={NAV_STYLE}>
      <div style={{ fontSize: 16, fontWeight: 650, color: 'var(--proto-ink)', padding: '2px 10px 6px', flex: 'none' }}>
        {L.settings}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        {getSettingsNavGroups(L).map((group) => (
          <div key={group.key}>
            <NavGroupLabel>{group.label}</NavGroupLabel>
            {group.entries.map((entry) => <SettingsNavEntry key={entry.key} entry={entry} {...props} />)}
          </div>
        ))}
      </div>
      <div className="settings-nav-build" style={{ padding: '10px 10px 0', font: `400 11px ${MONO}`, color: 'var(--proto-muted-2)', flex: 'none' }}>
        Cortex · {BUILD_STAMP}
      </div>
    </div>
  );
}

// ── Content header ──────────────────────────────────────────────────────────

function CloseButton({ onClose, blocked, label, title }: {
  onClose: () => void;
  blocked: boolean;
  label: string;
  title?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" data-settings-close disabled={blocked} onClick={onClose}
      aria-label={label} title={title}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: 34, height: 34, border: 0, borderRadius: 'var(--settings-control-radius, 8px)',
        background: hover && !blocked ? 'var(--proto-line-2)' : 'transparent',
        color: hover && !blocked ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
        display: 'grid', placeItems: 'center', padding: 0, fontSize: 14, flex: 'none',
        cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.4 : 1,
      }}>
      ✕
    </button>
  );
}

function SettingsPanelHeader(props: {
  section: SettingsSectionKey;
  onClose: () => void;
  closeBlocked: boolean;
  actionsRef: (node: HTMLDivElement | null) => void;
}) {
  const L = useVocab();
  const meta = getSectionMeta(L, props.section);
  return (
    <div className="settings-panel-header" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--proto-line-2)' }}>
      <div className="settings-panel-heading">
        <span className="settings-panel-title">{meta.title}</span>
        <span className="settings-panel-subtitle">{meta.sub}</span>
      </div>
      <div ref={props.actionsRef} data-settings-header-actions
        style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }} />
      <CloseButton onClose={props.onClose} blocked={props.closeBlocked} label={L.stEsc}
        title={props.closeBlocked ? L.plUnsavedLeave : L.stEsc} />
    </div>
  );
}

// ── Section routing ─────────────────────────────────────────────────────────

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
    return <div style={{ fontSize: 12, color: 'var(--proto-muted-3)' }}>{L.stLoadingConfig}</div>;
  }
  if (props.configError) {
    return <div style={{ fontSize: 12, color: 'var(--proto-danger)' }}>{L.stFailedLoadConfig} {props.configError.message}</div>;
  }
  if (!props.snapshot) return null;
  return <PanelBody {...props} snapshot={props.snapshot} />;
}

function SettingsSectionContent(props: SectionContentProps) {
  const independent = ['appearance', 'accounts', 'usage', 'plugins'].includes(props.section);
  const panel = independent ? <IndependentSettingsPanel {...props} /> : <ConfiguredSettingsPanel {...props} />;
  if (isBoundedPanel(props.section)) return panel;
  return <div style={PANEL_STACK_STYLE}>{panel}</div>;
}

interface SettingsBodyProps {
  onClose: () => void;
  panelDirty: boolean;
  onPanelDirtyChange: (dirty: boolean) => void;
}

function SettingsBody(props: SettingsBodyProps) {
  const trpc = useTRPC();
  const [section, setSection] = useState<SettingsSectionKey>('appearance');
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
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
      <SettingsNav section={section} blocked={props.panelDirty} onSelect={setSection} />
      <div className="settings-content-frame" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <SettingsPanelHeader section={section} onClose={props.onClose} closeBlocked={props.panelDirty} actionsRef={setHeaderSlot} />
        <div className={`settings-panel-content${isBoundedPanel(section) ? ' settings-panel-content--bounded' : ''}`} style={panelContentStyle(section)}>
          <SettingsHeaderSlotContext.Provider value={headerSlot}>
            <SettingsSectionContent {...content} />
          </SettingsHeaderSlotContext.Provider>
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
