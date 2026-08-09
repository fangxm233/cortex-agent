// input:  plugin queries, writes, and settings controls
// output: plugin catalog, assignments, and MCP confirm
// pos:    Desktop plugin settings view and container
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useEffect, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PluginAssignmentTarget, PluginsAssignArgs, PluginsListReturn, UiPluginCatalogEntry, UiPluginMcpServer } from '@cortex-agent/ui-contract';
import { Modal, Select, useToast, type SelectOption } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { RadioDot, SButton, SCard, SCardHeader, Toggle } from './settings-ui';
import {
  buildPluginsAssignArgs,
  createPluginDraft,
  draftMcpPlugins,
  effectiveUnmanagedPluginCount,
  pluginDraftState,
  pluginTargetKey,
  pluginToggleDisabledReason,
  resolvePluginTarget,
  resolvePluginTargetKey,
  setPluginDraftMode,
  syncPluginDraft,
  targetReadOnlyReason,
  togglePluginDraftId,
  type PluginsPanelDraft,
} from './plugins-panel-vm';

const PANEL: CSSProperties = {
  marginTop: 12, flex: 1, minHeight: 0,
  display: 'flex', flexDirection: 'column',
};
const CARDS: CSSProperties = {
  display: 'flex', gap: 12, flex: 1, minHeight: 0,
  alignItems: 'stretch', flexWrap: 'wrap',
};
const LEFT_CARD: CSSProperties = {
  flex: '1 1 320px', minWidth: 290, maxWidth: '100%', minHeight: 0,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
};
const RIGHT_CARD: CSSProperties = {
  flex: '999 1 420px', minWidth: 320, maxWidth: '100%', minHeight: 0,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
};
const SCROLLER: CSSProperties = {
  flex: 1, overflow: 'auto', minHeight: 0, maxHeight: '100%',
  padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10,
};
const META_LABEL: CSSProperties = {
  fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em',
  color: 'var(--proto-muted-3)', textTransform: 'uppercase',
};
const NOTICE: CSSProperties = {
  fontSize: 10.5, color: 'var(--proto-muted-2)', background: 'var(--proto-alt)',
  border: '1px solid var(--proto-line)', borderRadius: 8, padding: '8px 10px',
};
const ROW: CSSProperties = {
  border: '1px solid var(--proto-line)', borderRadius: 9,
  padding: '10px 12px', background: 'var(--proto-card)',
};
const PILL: CSSProperties = {
  border: '1px solid var(--proto-line)', borderRadius: 999,
  padding: '2px 8px', fontSize: 10, color: 'var(--proto-muted-2)',
};

type ToastFn = ReturnType<typeof useToast>['toast'];
type PluginsQueryClient = ReturnType<typeof useQueryClient>;
type PluginsTrpc = ReturnType<typeof useTRPC>;
type AssignMutation = { mutateAsync: (payload: PluginsAssignArgs) => Promise<unknown> };

interface AckState { key: string | null; payload: PluginsAssignArgs; plugins: UiPluginCatalogEntry[]; }
interface RefreshPluginsArgs {
  queryClient: PluginsQueryClient; trpc: PluginsTrpc; key: string | null; draft: PluginsPanelDraft | null;
  setSelectedKey: Dispatch<SetStateAction<string | null>>; setDraft: Dispatch<SetStateAction<PluginsPanelDraft | null>>;
  setRefreshing: Dispatch<SetStateAction<boolean>>; toast: ToastFn; L: Vocab;
}
interface SubmitPluginsArgs extends RefreshPluginsArgs {
  assign: AssignMutation; payload: PluginsAssignArgs;
}

export interface PluginsPanelViewProps {
  state: 'loading' | 'error' | 'ready'; errorMessage: string | null;
  plugins: UiPluginCatalogEntry[]; targets: PluginAssignmentTarget[];
  selectedKey: string | null; draft: PluginsPanelDraft | null; pending: boolean;
  ackOpen: boolean; ackPlugins: UiPluginCatalogEntry[];
  onTargetChange: (key: string) => void;
  onModeChange: (mode: 'inherit' | 'custom') => void;
  onTogglePlugin: (pluginId: string) => void;
  onReset: () => void; onSave: () => void;
  onAckOpenChange: (open: boolean) => void; onAckConfirm: () => void;
}

function selectionState(
  targets: readonly PluginAssignmentTarget[],
  key: string | null,
  draft: PluginsPanelDraft | null,
): { target: PluginAssignmentTarget | null; draft: PluginsPanelDraft | null } {
  const target = resolvePluginTarget(targets, key);
  if (!target) return { target: null, draft: null };
  return { target, draft: syncPluginDraft(target, targets, draft) };
}

function applyPluginsData(
  data: PluginsListReturn,
  key: string | null,
  setSelectedKey: Dispatch<SetStateAction<string | null>>,
  setDraft: Dispatch<SetStateAction<PluginsPanelDraft | null>>,
): void {
  const next = selectionState(data.targets, resolvePluginTargetKey(data.targets, key), null);
  setSelectedKey(next.target ? pluginTargetKey(next.target) : null);
  setDraft(next.draft);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConflictMessage(message: string): boolean {
  return /changed on disk/i.test(message);
}

function targetOptionLabel(target: PluginAssignmentTarget, L: Vocab): string {
  if (target.kind === 'agent') return `${L.plTargetAgent} · ${target.name}`;
  if (target.kind === 'template-shell') return `${L.plTargetShell} · ${target.templateName}`;
  return `${L.plTargetSlot} · ${target.templateName}[${target.index + 1}] · ${target.ref}`;
}

function readonlyText(reason: 'active-agent' | 'shell-binding' | null, L: Vocab): string | null {
  if (reason === 'active-agent') return L.plReadonlyActive;
  if (reason === 'shell-binding') return L.plReadonlyShell;
  return null;
}

function targetOptionDescription(target: PluginAssignmentTarget, L: Vocab): string | undefined {
  const reason = targetReadOnlyReason(target);
  if (reason === 'active-agent') return L.plReadonlyActiveOption;
  if (reason === 'shell-binding') return L.plReadonlyShellOption;
  return undefined;
}

function targetOptions(targets: readonly PluginAssignmentTarget[], L: Vocab): SelectOption<string>[] {
  return targets.map((target) => {
    const reason = readonlyText(targetReadOnlyReason(target), L) ?? undefined;
    return {
      value: pluginTargetKey(target),
      label: targetOptionLabel(target, L),
      description: targetOptionDescription(target, L),
      disabled: !target.editable,
      disabledReason: reason,
    };
  });
}

function mcpStatusText(plugin: UiPluginCatalogEntry, L: Vocab): string {
  if (plugin.mcp.status === 'missing') return L.plMcpMissing;
  if (plugin.mcp.status === 'invalid') return L.plMcpInvalid;
  return L.plMcpValid;
}

function pluginTitle(plugin: UiPluginCatalogEntry): string {
  return plugin.manifest.name ?? plugin.id;
}

function joinValues(values: readonly string[], fallback = '—'): string {
  return values.length > 0 ? values.join(', ') : fallback;
}

function pluginKindText(kind: UiPluginCatalogEntry['kind'], L: Vocab): string {
  if (kind === 'legacy') return L.plKindLegacy;
  if (kind === 'unknown') return L.plKindUnknown;
  return L.plKindPortable;
}

function mcpTransportText(server: UiPluginMcpServer, L: Vocab): string {
  if (server.type === 'sse') return L.plTransportSse;
  if (server.type === 'streamable-http') return L.plTransportHttp;
  return L.plTransportStdio;
}

function manifestSourceText(source: UiPluginCatalogEntry['manifest']['source'], L: Vocab): string {
  if (source === 'legacy') return L.plManifestSourceLegacy;
  if (source === 'none') return L.plManifestSourceNone;
  return L.plManifestSourceRoot;
}

function targetKey(target: PluginAssignmentTarget | null): string | null {
  return target ? pluginTargetKey(target) : null;
}

async function refreshPluginsData(
  args: RefreshPluginsArgs,
  preserveDraft: boolean,
): Promise<void> {
  await args.queryClient.invalidateQueries(args.trpc.plugins.list.queryFilter({}));
  const fresh = await args.queryClient.fetchQuery<PluginsListReturn>(args.trpc.plugins.list.queryOptions({}) as never);
  const next = selectionState(fresh.targets, args.key, preserveDraft ? args.draft : null);
  args.setSelectedKey(targetKey(next.target));
  args.setDraft(next.draft);
}

function toastRefreshFailed(
  toast: ToastFn,
  L: Vocab,
  error: unknown,
): void {
  toast({ title: `${L.plToastRefreshFailed}: ${errorMessage(error)}`, tone: 'failed' });
}

async function tryRefreshPluginsData(args: RefreshPluginsArgs, preserveDraft: boolean): Promise<boolean> {
  try {
    await refreshPluginsData(args, preserveDraft);
    return true;
  } catch (error) {
    toastRefreshFailed(args.toast, args.L, error);
    return false;
  }
}

async function refreshPluginsWhileBusy(args: RefreshPluginsArgs, preserveDraft: boolean): Promise<boolean> {
  args.setRefreshing(true);
  try {
    return await tryRefreshPluginsData(args, preserveDraft);
  } finally {
    args.setRefreshing(false);
  }
}

async function handleAssignError(args: SubmitPluginsArgs, error: unknown): Promise<void> {
  const message = errorMessage(error);
  if (!isConflictMessage(message)) {
    args.toast({ title: `${args.L.plToastFailed}: ${message}`, tone: 'failed' });
    return;
  }
  const refreshed = await refreshPluginsWhileBusy(args, true);
  if (refreshed) args.toast({ title: args.L.plToastConflict, tone: 'failed' });
}

async function submitPluginsAssign(args: SubmitPluginsArgs): Promise<void> {
  try {
    await args.assign.mutateAsync(args.payload);
  } catch (error) {
    await handleAssignError(args, error);
    return;
  }
  args.toast({ title: args.L.plToastSaved, tone: 'done' });
  await refreshPluginsWhileBusy(args, false);
}

function MetaBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={META_LABEL}>{label}</div>
      <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 4 }}>{value}</div>
    </div>
  );
}

function MetaSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={META_LABEL}>{label}</div>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}

function EmptyMessage({ text, dataAttr }: { text: string; dataAttr: string }) {
  return <div {...{ [dataAttr]: '' }} style={{ fontSize: 11, color: 'var(--proto-muted-2)' }}>{text}</div>;
}

function McpSummaryLine({ server }: { server: UiPluginMcpServer }) {
  const L = useVocab();
  const text = server.type === 'stdio'
    ? `${server.summary.command} · ${L.plArgsLabel} ${server.summary.argsCount} · ${L.plEnvLabel} ${joinValues(server.summary.envKeys)}`
    : `${server.summary.origin} · ${L.plHeadersLabel} ${joinValues(server.summary.headerKeys)}`;
  return (
    <div data-plugin-server={server.name} style={NOTICE}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-ink)' }}>{server.name} · {mcpTransportText(server, L)}</div>
      <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)' }}>{text}</div>
    </div>
  );
}

function McpServerSummary({ plugin }: { plugin: UiPluginCatalogEntry }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)' }}>{mcpStatusText(plugin, L)}</div>
      {plugin.mcp.servers.map((server) => <McpSummaryLine key={`${plugin.id}:${server.name}`} server={server} />)}
    </div>
  );
}

function IssueLine({ plugin, index }: { plugin: UiPluginCatalogEntry; index: number }) {
  const L = useVocab();
  const issue = plugin.issues[index];
  const meta = [
    `${L.plIssueScopeLabel} ${issue.scope}`,
    `${L.plIssueCodeLabel} ${issue.code}`,
    `${L.plIssuePathLabel} ${issue.path ?? L.plUnknownValue}`,
  ].join(' · ');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ fontSize: 10, color: 'var(--proto-muted-2)' }}>{meta}</div>
      <div style={{ fontSize: 10.5, color: 'var(--proto-danger)' }}>{issue.message}</div>
    </div>
  );
}

function IssueList({ plugin }: { plugin: UiPluginCatalogEntry }) {
  const L = useVocab();
  if (plugin.issues.length === 0) return <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)' }}>{L.plNone}</div>;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{plugin.issues.map((_, index) => <IssueLine key={`${plugin.id}:${index}`} plugin={plugin} index={index} />)}</div>;
}

function ManifestSection({ plugin }: { plugin: UiPluginCatalogEntry }) {
  const L = useVocab();
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <MetaBlock label={L.plManifestSourceLabel} value={manifestSourceText(plugin.manifest.source, L)} />
      <MetaBlock label={L.plManifestDescLabel} value={plugin.manifest.description ?? L.plUnknownValue} />
    </div>
  );
}

function PluginBadges({ plugin }: { plugin: UiPluginCatalogEntry }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{pluginTitle(plugin)}</span>
      <span style={PILL}>{plugin.id}</span>
      <span style={PILL}>{plugin.manifest.version ?? L.plUnknownValue}</span>
      <span style={PILL}>{pluginKindText(plugin.kind, L)}</span>
      <span style={PILL}>{plugin.valid ? L.plValid : L.plInvalid}</span>
    </div>
  );
}

function modeChoiceStyle(disabled: boolean): CSSProperties {
  return {
    ...ROW,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    textAlign: 'left',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  };
}

function ModeChoice(props: {
  label: string;
  selected: boolean;
  disabled: boolean;
  mode: 'inherit' | 'custom';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-plugin-mode={props.mode}
      data-selected={String(props.selected)}
      disabled={props.disabled}
      aria-pressed={props.selected}
      onClick={props.onClick}
      style={modeChoiceStyle(props.disabled)}
    >
      <RadioDot selected={props.selected} />
      <span style={{ fontSize: 11.5, color: 'var(--proto-ink)' }}>{props.label}</span>
    </button>
  );
}

function pluginRowToggle(props: {
  plugin: UiPluginCatalogEntry;
  target: PluginAssignmentTarget | null;
  draft: PluginsPanelDraft | null;
  pending: boolean;
  onTogglePlugin: (pluginId: string) => void;
}) {
  const reason = props.pending
    ? 'readonly'
    : pluginToggleDisabledReason(props.target, props.draft, props.plugin);
  return {
    reason,
    selected: Boolean(props.draft?.pluginIds.includes(props.plugin.id)),
    onClick: reason ? undefined : () => props.onTogglePlugin(props.plugin.id),
  };
}

function PluginRow(props: Parameters<typeof pluginRowToggle>[0]) {
  const L = useVocab();
  const toggle = pluginRowToggle(props);
  const assignment = props.plugin.assignable ? L.plAssignable : L.plUnassignable;
  return (
    <div data-plugin-row={props.plugin.id} data-plugin-disabled={String(Boolean(toggle.reason))} data-plugin-disabled-reason={toggle.reason ?? undefined} style={ROW}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <Toggle on={toggle.selected} onClick={toggle.onClick} inert={!toggle.onClick}
          ariaLabel={L.plToggleLabel.replace('{name}', pluginTitle(props.plugin))} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <PluginBadges plugin={props.plugin} />
          <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', overflowWrap: 'anywhere' }}>{assignment} · {props.plugin.rootDir}</div>
          <MetaBlock label={L.plSkillsLabel} value={joinValues(props.plugin.skills.map((skill) => skill.name))} />
          <MetaSection label={L.plManifestLabel}><ManifestSection plugin={props.plugin} /></MetaSection>
          <MetaSection label={L.plIssuesLabel}><IssueList plugin={props.plugin} /></MetaSection>
          <MetaSection label={L.plMcpLabel}><McpServerSummary plugin={props.plugin} /></MetaSection>
        </div>
      </div>
    </div>
  );
}

function TargetModes(props: {
  target: PluginAssignmentTarget | null;
  draft: PluginsPanelDraft | null;
  pending: boolean;
  onModeChange: (mode: 'inherit' | 'custom') => void;
}) {
  const L = useVocab();
  if (props.target?.kind !== 'template-slot' || !props.target.editable) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={META_LABEL}>{L.plModeLabel}</div>
      <ModeChoice mode="inherit" label={L.plModeInherit} selected={props.draft?.mode === 'inherit'} disabled={props.pending} onClick={() => props.onModeChange('inherit')} />
      <ModeChoice mode="custom" label={L.plModeCustom} selected={props.draft?.mode === 'custom'} disabled={props.pending} onClick={() => props.onModeChange('custom')} />
    </div>
  );
}

function TargetSelector(props: {
  selectedKey: string | null;
  targets: readonly PluginAssignmentTarget[];
  disabled: boolean;
  onTargetChange: (key: string) => void;
}) {
  const L = useVocab();
  if (props.targets.length === 0) return <EmptyMessage text={L.plNoTargets} dataAttr="data-plugins-empty" />;
  return (
    <Select
      data-plugin-target
      aria-label={L.plTargetsTitle}
      value={props.selectedKey ?? ''}
      options={targetOptions(props.targets, L)}
      disabled={props.disabled}
      onValueChange={props.onTargetChange}
      style={{ width: '100%', boxSizing: 'border-box', padding: '6px 9px', border: '1px solid var(--proto-line)', borderRadius: 8 }}
    />
  );
}

function TargetNotices(props: {
  target: PluginAssignmentTarget | null;
  targets: readonly PluginAssignmentTarget[];
  draft: PluginsPanelDraft | null;
}) {
  const L = useVocab();
  const readOnly = targetReadOnlyReason(props.target);
  const unmanaged = effectiveUnmanagedPluginCount(props.target, props.targets, props.draft?.mode ?? null);
  return (
    <>
      {props.target ? <div style={{ fontSize: 11.5, fontWeight: 650, color: 'var(--proto-ink)' }}>{targetOptionLabel(props.target, L)}</div> : null}
      {readOnly ? <div data-plugin-readonly={readOnly} style={NOTICE}>{readonlyText(readOnly, L)}</div> : null}
      {unmanaged > 0 ? <div style={NOTICE}>{L.plUnmanagedNotice.replace('{n}', String(unmanaged))}</div> : null}
    </>
  );
}

function TargetFooter(props: { state: ReturnType<typeof pluginDraftState>; pending: boolean; onReset: () => void; onSave: () => void }) {
  const L = useVocab();
  return (
    <div style={{ borderTop: '1px solid var(--proto-line)', padding: '10px 14px', display: 'flex', gap: 8 }}>
      <SButton tone="neutral" disabled={!props.state.canReset} data-action="reset" data-disabled={props.state.canReset ? 'false' : 'true'} onClick={props.onReset}>{L.plReset}</SButton>
      <SButton tone="accent" disabled={!props.state.canSave} data-action="save" data-disabled={props.state.canSave ? 'false' : 'true'} onClick={props.onSave}>{props.pending ? L.plSaving : L.plSave}</SButton>
    </div>
  );
}

function TargetCard(props: {
  selectedKey: string | null;
  target: PluginAssignmentTarget | null;
  targets: readonly PluginAssignmentTarget[];
  draft: PluginsPanelDraft | null;
  pending: boolean;
  onTargetChange: (key: string) => void;
  onModeChange: (mode: 'inherit' | 'custom') => void;
  onReset: () => void;
  onSave: () => void;
}) {
  const L = useVocab();
  const state = pluginDraftState(props.target, props.draft, props.pending);
  return (
    <SCard style={LEFT_CARD}>
      <SCardHeader title={L.plTargetsTitle} right={`${props.targets.length}`} />
      <div style={SCROLLER}>
        <TargetSelector selectedKey={props.selectedKey} targets={props.targets} disabled={props.pending || state.dirty} onTargetChange={props.onTargetChange} />
        <TargetNotices target={props.target} targets={props.targets} draft={props.draft} />
        {state.conflicted ? <div data-plugin-conflict="" style={NOTICE}>{L.plStaleDraft}</div> : null}<TargetModes target={props.target} draft={props.draft} pending={props.pending} onModeChange={props.onModeChange} />
      </div>
      <TargetFooter state={state} pending={props.pending} onReset={props.onReset} onSave={props.onSave} />
    </SCard>
  );
}

function CatalogCard(props: {
  plugins: readonly UiPluginCatalogEntry[];
  target: PluginAssignmentTarget | null;
  draft: PluginsPanelDraft | null;
  pending: boolean;
  onTogglePlugin: (pluginId: string) => void;
}) {
  const L = useVocab();
  return (
    <SCard style={RIGHT_CARD}>
      <SCardHeader title={L.plCatalogTitle} right={`${props.plugins.length}`} />
      <div style={SCROLLER}>
        {props.plugins.length > 0
          ? props.plugins.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} target={props.target} draft={props.draft} pending={props.pending} onTogglePlugin={props.onTogglePlugin} />
          ))
          : <EmptyMessage text={L.plNoCatalog} dataAttr="data-plugins-empty" />}
      </div>
    </SCard>
  );
}

function AckPluginCard({ plugin }: { plugin: UiPluginCatalogEntry }) {
  return (
    <div style={NOTICE}>
      <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{pluginTitle(plugin)}</div>
      <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 4 }}>{plugin.id}</div>
      <div style={{ marginTop: 8 }}><McpServerSummary plugin={plugin} /></div>
    </div>
  );
}

function AckModal(props: {
  open: boolean;
  plugins: readonly UiPluginCatalogEntry[];
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const L = useVocab();
  return (
    <Modal
      title={L.plAckTitle}
      description={L.plAckDesc}
      open={props.open}
      layer="nested"
      onOpenChange={props.onOpenChange}
      footer={(
        <>
          <SButton tone="neutral" disabled={props.pending} onClick={() => props.onOpenChange(false)}>{L.plAckCancel}</SButton>
          <SButton tone="accent" disabled={props.pending} onClick={props.onConfirm}>{L.plAckConfirm}</SButton>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{props.plugins.map((plugin) => <AckPluginCard key={plugin.id} plugin={plugin} />)}</div>
    </Modal>
  );
}

function PluginsPanelState(props: PluginsPanelViewProps) {
  const L = useVocab();
  if (props.state === 'loading') {
    return <EmptyMessage text={L.plLoading} dataAttr="data-plugins-loading" />;
  }
  if (props.state === 'error') {
    const text = `${L.plLoadFailed} ${props.errorMessage ?? ''}`.trim();
    return <EmptyMessage text={text} dataAttr="data-plugins-error" />;
  }
  return null;
}

function ReadyPluginsPanel(props: PluginsPanelViewProps) {
  const current = selectionState(props.targets, props.selectedKey, props.draft);
  return (
    <>
      <div data-plugin-cards="" style={CARDS}>
        <TargetCard selectedKey={props.selectedKey} target={current.target}
          targets={props.targets} draft={current.draft} pending={props.pending}
          onTargetChange={props.onTargetChange} onModeChange={props.onModeChange}
          onReset={props.onReset} onSave={props.onSave} />
        <CatalogCard plugins={props.plugins} target={current.target}
          draft={current.draft} pending={props.pending}
          onTogglePlugin={props.onTogglePlugin} />
      </div>
      <AckModal open={props.ackOpen} plugins={props.ackPlugins}
        pending={props.pending} onOpenChange={props.onAckOpenChange}
        onConfirm={props.onAckConfirm} />
    </>
  );
}

export function PluginsPanelView(props: PluginsPanelViewProps) {
  const state = <PluginsPanelState {...props} />;
  return (
    <div data-settings-panel="plugins" style={PANEL}>
      {props.state === 'ready' ? <ReadyPluginsPanel {...props} /> : state}
    </div>
  );
}

function applyCurrentSelection(
  next: ReturnType<typeof selectionState>, selectedKey: string | null,
  draft: PluginsPanelDraft | null, setSelectedKey: Dispatch<SetStateAction<string | null>>,
  setDraft: Dispatch<SetStateAction<PluginsPanelDraft | null>>,
): void {
  if (targetKey(next.target) !== selectedKey) setSelectedKey(targetKey(next.target));
  if (next.draft !== draft) setDraft(next.draft);
}

function usePluginsSelectionState(
  data: PluginsListReturn | undefined, pending: boolean, selectedKey: string | null,
  draft: PluginsPanelDraft | null, setSelectedKey: Dispatch<SetStateAction<string | null>>,
  setDraft: Dispatch<SetStateAction<PluginsPanelDraft | null>>,
) {
  useEffect(() => {
    if (!data) return;
    applyCurrentSelection(selectionState(data.targets, selectedKey, draft), selectedKey, draft, setSelectedKey, setDraft);
  }, [data, draft, selectedKey, setDraft, setSelectedKey]);
  const current = data ? selectionState(data.targets, selectedKey, draft) : { target: null, draft: null };
  return { current, currentState: pluginDraftState(current.target, current.draft, pending) };
}

function targetChangeHandler(args: {
  data: PluginsListReturn | undefined;
  pending: boolean;
  dirty: boolean;
  setSelectedKey: Dispatch<SetStateAction<string | null>>;
  setDraft: Dispatch<SetStateAction<PluginsPanelDraft | null>>;
}) {
  return (key: string) => {
    if (!args.data || args.pending || args.dirty) return;
    applyPluginsData(args.data, key, args.setSelectedKey, args.setDraft);
  };
}

function modeChangeHandler(args: {
  data: PluginsListReturn | undefined;
  current: { target: PluginAssignmentTarget | null; draft: PluginsPanelDraft | null };
  pending: boolean;
  setDraft: Dispatch<SetStateAction<PluginsPanelDraft | null>>;
}) {
  return (mode: 'inherit' | 'custom') => {
    if (!args.data || !args.current.target || !args.current.draft || args.pending) return;
    args.setDraft(setPluginDraftMode(args.current.draft, args.current.target, args.data.targets, mode));
  };
}

function togglePluginHandler(args: {
  data: PluginsListReturn | undefined;
  current: { target: PluginAssignmentTarget | null; draft: PluginsPanelDraft | null };
  pending: boolean;
  setDraft: Dispatch<SetStateAction<PluginsPanelDraft | null>>;
}) {
  return (pluginId: string) => {
    if (!args.data || !args.current.target || !args.current.draft || args.pending) return;
    const plugin = args.data.plugins.find((item) => item.id === pluginId);
    if (plugin) args.setDraft(togglePluginDraftId(args.current.draft, args.current.target, plugin));
  };
}

function resetHandler(args: {
  data: PluginsListReturn | undefined;
  target: PluginAssignmentTarget | null;
  pending: boolean;
  setDraft: Dispatch<SetStateAction<PluginsPanelDraft | null>>;
}) {
  return () => {
    if (!args.data || !args.target || args.pending) return;
    args.setDraft(createPluginDraft(args.target, args.data.targets));
  };
}

function saveHandler(args: {
  data: PluginsListReturn | undefined;
  current: { target: PluginAssignmentTarget | null; draft: PluginsPanelDraft | null };
  pending: boolean;
  assign: AssignMutation;
  setAck: Dispatch<SetStateAction<AckState | null>>;
} & Omit<Parameters<typeof submitPluginsAssign>[0], 'assign' | 'payload' | 'key'>) {
  return () => {
    if (!args.data || args.pending) return;
    const payload = buildPluginsAssignArgs(args.current.target, args.current.draft);
    const mcp = draftMcpPlugins(args.current.target, args.current.draft, args.data.plugins);
    if (!payload) return;
    if (mcp.length > 0) return args.setAck({ key: targetKey(args.current.target), payload, plugins: mcp });
    void submitPluginsAssign({
      assign: args.assign,
      payload,
      key: targetKey(args.current.target),
      queryClient: args.queryClient,
      trpc: args.trpc,
      draft: args.current.draft,
      setSelectedKey: args.setSelectedKey,
      setDraft: args.setDraft,
      setRefreshing: args.setRefreshing,
      toast: args.toast,
      L: args.L,
    });
  };
}

function ackConfirmHandler(args: {
  ack: AckState | null;
  pending: boolean;
  assign: AssignMutation;
  setAck: Dispatch<SetStateAction<AckState | null>>;
} & Omit<Parameters<typeof submitPluginsAssign>[0], 'assign' | 'payload' | 'key'>) {
  return () => {
    if (!args.ack || args.pending) return;
    args.setAck(null);
    void submitPluginsAssign({
      assign: args.assign,
      payload: { ...args.ack.payload, acknowledgeMcp: true },
      key: args.ack.key,
      queryClient: args.queryClient,
      trpc: args.trpc,
      draft: args.draft,
      setSelectedKey: args.setSelectedKey,
      setDraft: args.setDraft,
      setRefreshing: args.setRefreshing,
      toast: args.toast,
      L: args.L,
    });
  };
}

function pluginPanelHandlers(args: {
  data: PluginsListReturn | undefined;
  current: ReturnType<typeof selectionState>;
  dirty: boolean;
  pending: boolean;
  assign: AssignMutation;
  ack: AckState | null;
  setAck: Dispatch<SetStateAction<AckState | null>>;
  setSelectedKey: Dispatch<SetStateAction<string | null>>;
  setDraft: Dispatch<SetStateAction<PluginsPanelDraft | null>>;
  refresh: Omit<Parameters<typeof submitPluginsAssign>[0], 'assign' | 'payload' | 'key'>;
}) {
  const state = { data: args.data, current: args.current, pending: args.pending };
  return {
    onTargetChange: targetChangeHandler({ data: args.data, pending: args.pending, dirty: args.dirty, setSelectedKey: args.setSelectedKey, setDraft: args.setDraft }),
    onModeChange: modeChangeHandler({ ...state, setDraft: args.setDraft }),
    onTogglePlugin: togglePluginHandler({ ...state, setDraft: args.setDraft }),
    onReset: resetHandler({ data: args.data, target: args.current.target, pending: args.pending, setDraft: args.setDraft }),
    onSave: saveHandler({ ...state, assign: args.assign, setAck: args.setAck, ...args.refresh }),
    onAckOpenChange: (open: boolean) => { if (!open && !args.pending) args.setAck(null); },
    onAckConfirm: ackConfirmHandler({ ack: args.ack, pending: args.pending, assign: args.assign, setAck: args.setAck, ...args.refresh }),
  };
}

function usePluginDirtyNotification(
  dirty: boolean,
  onDirtyChange?: (dirty: boolean) => void,
): void {
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
}

function usePluginsPanelProps(
  onDirtyChange?: (dirty: boolean) => void,
): PluginsPanelViewProps {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const listQuery = useQuery<PluginsListReturn>(trpc.plugins.list.queryOptions({}) as never);
  const assign = useMutation<unknown, Error, PluginsAssignArgs>(trpc.plugins.assign.mutationOptions() as never);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<PluginsPanelDraft | null>(null);
  const [ack, setAck] = useState<AckState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const pending = assign.isPending || refreshing;
  const selection = usePluginsSelectionState(listQuery.data, pending, selectedKey, draft, setSelectedKey, setDraft);
  usePluginDirtyNotification(selection.currentState.dirty, onDirtyChange);
  const refresh = { queryClient, trpc, draft, setSelectedKey, setDraft, setRefreshing, toast, L };
  const handlers = pluginPanelHandlers({ data: listQuery.data, current: selection.current,
    dirty: selection.currentState.dirty, pending, assign, ack,
    setAck, setSelectedKey, setDraft, refresh });
  return {
    state: listQuery.isLoading ? 'loading' : listQuery.isError ? 'error' : 'ready',
    errorMessage: listQuery.isError ? errorMessage(listQuery.error) : null,
    plugins: listQuery.data?.plugins ?? [], targets: listQuery.data?.targets ?? [],
    selectedKey, draft, pending,
    ackOpen: ack !== null, ackPlugins: ack?.plugins ?? [], ...handlers,
  };
}

export function PluginsPanel({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
} = {}) {
  return <PluginsPanelView {...usePluginsPanelProps(onDirtyChange)} />;
}
