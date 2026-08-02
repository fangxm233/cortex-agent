// input:  config/auth queries, settings panels, LoginFlow, Radix
// output: settings overlay with non-stacked account login handoff
// pos:    Desktop settings overlay shell and data bindings
// >>> If I am updated, update my header comment and CORTEX.md <<<

import * as RadixDialog from '@radix-ui/react-dialog';
import { useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { getSettingsNav, getSectionMeta, type SettingsSectionKey } from './settings-nav';
import {
  PlatformPanel,
  ProfilesPanel,
  MachinesPanel,
  TemplatesPanel,
  McpPanel,
} from './SettingsPanels';
import { AdvancedPanel, NotificationsPanel } from './RuntimeSettingsPanels';
import { BudgetPanel } from './BudgetPanel';
import { HooksPanel } from './HooksPanel';
import { AppearancePanel } from './AppearancePanel';
import { AccountsPanel } from './AccountsPanel';
import { useLoginFlow } from '@/features/auth/LoginFlowProvider';

// Settings modal (design 12a–g, prototype.dc.html L721–1088; proto-shot 14-settings.png). Rebuilt
// 1:1 on Radix Dialog (focus trap / Esc-close / focus-restore + backdrop scrim). Header + 210px left
// nav + var(--proto-alt) content area; panels switch client-side. Real config/auth data feeds each panel;
// Budget and runtime-setting toggles drive config.set writes. Raw inline styles/px/hex/font per §8.3.

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

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const L = useVocab();
  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay style={BACKDROP_STYLE} className="animate-cxfade motion-reduce:animate-none" />
        <RadixDialog.Content
          aria-describedby={undefined}
          style={MODAL_STYLE}
          className="animate-cxmodal focus:outline-none motion-reduce:animate-none"
        >
          <RadixDialog.Title style={SR_ONLY}>{L.settings}</RadixDialog.Title>
          {open ? <SettingsBody onClose={onClose} /> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function SettingsBody({ onClose }: { onClose: () => void }) {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { openLogin } = useLoginFlow();
  const [section, setSection] = useState<SettingsSectionKey>('appearance');

  const configQuery = useQuery(trpc.config.get.queryOptions({}));
  const costQuery = useQuery(trpc.cost.summary.queryOptions({}));
  const templateEntriesQuery = useQuery(trpc.threadTemplates.get.queryOptions({}));
  const snapshot = configQuery.data;
  const meta = getSectionMeta(L, section);

  // profiles: a REAL config.set write — re-point defaultProfile, then read back (invalidate).
  const setProfile = useMutation(
    trpc.config.set.mutationOptions({
      onSuccess: (_d, vars) => {
        queryClient.invalidateQueries(trpc.config.get.queryFilter({}));
        const name = vars.section === 'profiles' ? vars.value.defaultProfile : '';
        toast({ title: `Default profile → ${name} · ${L.stToastDefaultProfile}`, tone: 'done' });
      },
      onError: (e) => toast({ title: `${L.stToastWriteFailed}: ${e.message}`, tone: 'failed' }),
    }),
  );

  // high-privilege gate: queue an approval request instead of bare-executing (Reconnect / Add machine).
  const requestApproval = useMutation(
    trpc.approvals.request.mutationOptions({
      onSuccess: () =>
        toast({ title: L.stToastQueuedApproval, tone: 'waiting' }),
      onError: (e) => toast({ title: `${L.stToastCouldNotQueue}: ${e.message}`, tone: 'failed' }),
    }),
  );

  const onSetDefaultProfile = (name: string) =>
    setProfile.mutate({ section: 'profiles', value: { defaultProfile: name } });
  const onReconnect = (platform: 'slack' | 'feishu') =>
    requestApproval.mutate({ kind: 'reconnect-platform', platform });
  const onAddMachine = (machineName: string) =>
    requestApproval.mutate({ kind: 'add-machine', machineName });

  return (
    <>
      {/* header (prototype L724) */}
      <div
        style={{
          height: 48,
          flex: 'none',
          borderBottom: '1px solid var(--proto-line)',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '0 18px',
          background: 'var(--proto-card)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.settings}</span>
        <span style={{ font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)', marginLeft: 4 }}>{L.stConfigRoot}</span>
        <span
          onClick={onClose}
          role="button"
          style={{
            marginLeft: 'auto',
            font: `500 9.5px ${MONO}`,
            color: 'var(--proto-muted-3)',
            border: '1px solid var(--proto-line)',
            borderRadius: 5,
            padding: '2px 6px',
            cursor: 'pointer',
          }}
        >
          {L.stEsc}
        </span>
      </div>
      {/* body: 210px nav + content (prototype L732) */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <div
          style={{
            width: 210,
            flex: 'none',
            borderRight: '1px solid var(--proto-line)',
            background: 'var(--proto-rail)',
            padding: '10px 8px',
            overflow: 'auto',
          }}
        >
          {getSettingsNav(L).map((n) => {
            const active = n.key === section;
            return (
              <div
                key={n.key}
                onClick={() => setSection(n.key)}
                role="button"
                data-settings-nav={n.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 10px',
                  background: active ? 'var(--proto-accent-bg)' : 'transparent',
                  borderRadius: 8,
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: active ? 'var(--proto-accent)' : 'var(--proto-ink-2)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {n.label}
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    font: `400 9px ${MONO}`,
                    color: active ? 'var(--proto-accent)' : 'var(--proto-faint)',
                    flex: 'none',
                  }}
                >
                  {n.file}
                </span>
              </div>
            );
          })}
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'auto',
            padding: '16px 22px',
            background: 'var(--proto-alt)',
            display: section === 'hooks' ? 'flex' : undefined,
            flexDirection: section === 'hooks' ? 'column' : undefined,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 650, color: 'var(--proto-ink)' }}>{meta.title}</div>
          <div style={{ fontSize: 11, color: 'var(--proto-muted-2)', marginTop: 2 }}>{meta.sub}</div>
          {section === 'appearance' ? (
            // Device-local theme — no config.get dependency, so it renders even if config fails to load.
            <AppearancePanel />
          ) : section === 'accounts' ? (
            <AccountsPanel onLogin={(target) => { onClose(); openLogin(target); }} />
          ) : configQuery.isLoading ? (
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--proto-muted-3)' }}>{L.stLoadingConfig}</div>
          ) : configQuery.isError ? (
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--proto-danger)' }}>
              {L.stFailedLoadConfig} {configQuery.error.message}
            </div>
          ) : snapshot ? (
            <PanelBody
              section={section}
              snapshot={snapshot}
              cost={costQuery.data}
              templateEntries={templateEntriesQuery.data}
              onSetDefaultProfile={onSetDefaultProfile}
              onReconnect={onReconnect}
              onAddMachine={onAddMachine}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

function PanelBody({
  section,
  snapshot,
  cost,
  templateEntries,
  onSetDefaultProfile,
  onReconnect,
  onAddMachine,
}: {
  section: SettingsSectionKey;
  snapshot: import('@cortex-agent/ui-contract').ConfigSnapshot;
  cost: import('@cortex-agent/ui-contract').CostSummary | undefined;
  templateEntries: import('@cortex-agent/ui-contract').ThreadTemplateEntry[] | undefined;
  onSetDefaultProfile: (name: string) => void;
  onReconnect: (platform: 'slack' | 'feishu') => void;
  onAddMachine: (machineName: string) => void;
}) {
  switch (section) {
    case 'platform':
      return <PlatformPanel snapshot={snapshot} onReconnect={onReconnect} />;
    case 'profiles':
      return <ProfilesPanel snapshot={snapshot} onSetDefaultProfile={onSetDefaultProfile} />;
    case 'budget':
      return <BudgetPanel snapshot={snapshot} cost={cost} />;
    case 'machines':
      return <MachinesPanel snapshot={snapshot} onAddMachine={onAddMachine} />;
    case 'templates':
      return <TemplatesPanel snapshot={snapshot} entries={templateEntries} />;
    case 'mcp':
      return <McpPanel snapshot={snapshot} />;
    case 'notifications':
      return <NotificationsPanel snapshot={snapshot} />;
    // Hooks reads its own hooks.list query — the four-field config.get summary cannot carry a
    // full declaration, let alone edit one.
    case 'hooks':
      return <HooksPanel />;
    case 'advanced':
      return <AdvancedPanel snapshot={snapshot} />;
    default:
      return null;
  }
}
