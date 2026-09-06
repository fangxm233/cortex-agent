// input:  an entity scope, the plugin catalog, and the assign mutation
// output: plugin assignment for one agent or template, with MCP acknowledgement
// pos:    Assignment control embedded in the thread-template editor
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useEffect, useMemo, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PluginAssignmentTarget, PluginsAssignArgs, PluginsListReturn, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import { Modal, Select, useToast, type SelectOption } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { RadioDot, SButton, Toggle } from './settings-ui';
import {
  EmptyMessage, McpServerSummary, NOTICE, PILL, ROW, META_LABEL,
  pluginTitle, scopeNoticeText,
} from './plugin-ui';
import {
  buildPluginsAssignArgs,
  createPluginDraft,
  draftMcpPlugins,
  effectiveUnmanagedPluginCount,
  pluginDraftState,
  pluginTargetKey,
  pluginToggleDisabledReason,
  resolvePluginTarget,
  scopedAssignTargets,
  setPluginDraftMode,
  syncPluginDraft,
  targetReadOnlyReason,
  togglePluginDraftId,
  type PluginAssignScope,
  type PluginsPanelDraft,
} from './plugin-assign-vm';

const WRAP: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
const LIST: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };

type ToastFn = ReturnType<typeof useToast>['toast'];
type AssignMutation = { mutateAsync: (payload: PluginsAssignArgs) => Promise<unknown> };

interface AckState { key: string | null; payload: PluginsAssignArgs; plugins: UiPluginCatalogEntry[] }

interface Selection { target: PluginAssignmentTarget | null; draft: PluginsPanelDraft | null }

interface RefreshArgs {
  queryClient: ReturnType<typeof useQueryClient>;
  trpc: ReturnType<typeof useTRPC>;
  scope: PluginAssignScope;
  key: string | null;
  draft: PluginsPanelDraft | null;
  setSelectedKey: Dispatch<SetStateAction<string | null>>;
  setDraft: Dispatch<SetStateAction<PluginsPanelDraft | null>>;
  setRefreshing: Dispatch<SetStateAction<boolean>>;
  toast: ToastFn;
  L: Vocab;
  onSaved?: () => void;
}

export interface PluginAssignPanelProps {
  scope: PluginAssignScope;
  /** Set while the JSON body editor has unsaved edits: both write the same file, so only one of
   *  them may hold a draft at a time. */
  locked?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  /** Called after a successful assign so the host can refetch its own stale baseHash. */
  onSaved?: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConflictMessage(message: string): boolean {
  return /changed on disk/i.test(message);
}

function targetKeyOf(target: PluginAssignmentTarget | null): string | null {
  return target ? pluginTargetKey(target) : null;
}

function selectionState(
  all: readonly PluginAssignmentTarget[],
  scope: PluginAssignScope,
  key: string | null,
  draft: PluginsPanelDraft | null,
): Selection {
  const target = resolvePluginTarget(scopedAssignTargets(all, scope), key);
  if (!target) return { target: null, draft: null };
  return { target, draft: syncPluginDraft(target, all, draft) };
}

function slotLabel(target: PluginAssignmentTarget, L: Vocab): string {
  if (target.kind === 'agent') return target.name;
  if (target.kind === 'template-shell') return `${L.plTargetShell} · ${target.templateName}`;
  return `[${target.index + 1}] ${target.ref}`;
}

function readonlyText(reason: 'active-agent' | 'shell-binding' | null, L: Vocab): string | null {
  if (reason === 'active-agent') return L.plReadonlyActive;
  if (reason === 'shell-binding') return L.plReadonlyShell;
  return null;
}

function slotOptions(targets: readonly PluginAssignmentTarget[], L: Vocab): SelectOption<string>[] {
  return targets.map((target) => ({
    value: pluginTargetKey(target),
    label: slotLabel(target, L),
    disabled: !target.editable,
    disabledReason: readonlyText(targetReadOnlyReason(target), L) ?? undefined,
  }));
}

async function refreshCatalog(args: RefreshArgs, preserveDraft: boolean): Promise<void> {
  await args.queryClient.invalidateQueries(args.trpc.plugins.list.queryFilter({}));
  const fresh = await args.queryClient.fetchQuery<PluginsListReturn>(args.trpc.plugins.list.queryOptions({}) as never);
  const next = selectionState(fresh.targets, args.scope, args.key, preserveDraft ? args.draft : null);
  args.setSelectedKey(targetKeyOf(next.target));
  args.setDraft(next.draft);
}

async function refreshWhileBusy(args: RefreshArgs, preserveDraft: boolean): Promise<boolean> {
  args.setRefreshing(true);
  try {
    await refreshCatalog(args, preserveDraft);
    return true;
  } catch (error) {
    args.toast({ title: `${args.L.plToastRefreshFailed}: ${errorMessage(error)}`, tone: 'failed' });
    return false;
  } finally {
    args.setRefreshing(false);
  }
}

async function submitAssign(
  args: RefreshArgs & { assign: AssignMutation; payload: PluginsAssignArgs },
): Promise<void> {
  try {
    await args.assign.mutateAsync(args.payload);
  } catch (error) {
    const message = errorMessage(error);
    if (!isConflictMessage(message)) {
      args.toast({ title: `${args.L.plToastFailed}: ${message}`, tone: 'failed' });
      return;
    }
    if (await refreshWhileBusy(args, true)) args.toast({ title: args.L.plToastConflict, tone: 'failed' });
    return;
  }
  args.toast({ title: args.L.plToastSaved, tone: 'done' });
  await refreshWhileBusy(args, false);
  args.onSaved?.();
}

function PluginChoice(props: {
  plugin: UiPluginCatalogEntry;
  target: PluginAssignmentTarget | null;
  draft: PluginsPanelDraft | null;
  pending: boolean;
  onToggle: (pluginId: string) => void;
}) {
  const L = useVocab();
  const reason = props.pending ? 'readonly' : pluginToggleDisabledReason(props.target, props.draft, props.plugin);
  const selected = Boolean(props.draft?.pluginIds.includes(props.plugin.id));
  const scopeNote = scopeNoticeText(props.plugin, L);
  return (
    <div data-plugin-row={props.plugin.id} data-plugin-disabled={String(Boolean(reason))}
      data-plugin-disabled-reason={reason ?? undefined} style={ROW}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Toggle on={selected} onClick={reason ? undefined : () => props.onToggle(props.plugin.id)} inert={Boolean(reason)}
          ariaLabel={L.plToggleLabel.replace('{name}', pluginTitle(props.plugin))} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, fontWeight: 650, color: 'var(--proto-ink)' }}>{pluginTitle(props.plugin)}</span>
            <span style={PILL}>{L.plSkillCount.replace('{n}', String(props.plugin.skills.length))}</span>
            {props.plugin.mcp.servers.length > 0
              ? <span style={PILL}>{L.plMcpCount.replace('{n}', String(props.plugin.mcp.servers.length))}</span>
              : null}
            {props.plugin.assignable ? null : <span style={{ ...PILL, color: 'var(--proto-danger)' }}>{L.plUnassignable}</span>}
          </div>
          {props.plugin.manifest.description
            ? <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)' }}>{props.plugin.manifest.description}</div>
            : null}
          {scopeNote ? <div data-plugin-scope={props.plugin.scope} style={NOTICE}>{scopeNote}</div> : null}
        </div>
      </div>
    </div>
  );
}

function ModeChoice(props: { label: string; selected: boolean; disabled: boolean; mode: 'inherit' | 'custom'; onClick: () => void }) {
  return (
    <button type="button" data-plugin-mode={props.mode} data-selected={String(props.selected)}
      disabled={props.disabled} aria-pressed={props.selected} onClick={props.onClick}
      style={{
        ...ROW, display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
        cursor: props.disabled ? 'not-allowed' : 'pointer', opacity: props.disabled ? 0.55 : 1,
      }}>
      <RadioDot selected={props.selected} />
      <span style={{ fontSize: 11.5, color: 'var(--proto-ink)' }}>{props.label}</span>
    </button>
  );
}

function SlotModes(props: {
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
      <ModeChoice mode="inherit" label={L.plModeInherit} selected={props.draft?.mode === 'inherit'}
        disabled={props.pending} onClick={() => props.onModeChange('inherit')} />
      <ModeChoice mode="custom" label={L.plModeCustom} selected={props.draft?.mode === 'custom'}
        disabled={props.pending} onClick={() => props.onModeChange('custom')} />
    </div>
  );
}

function AckModal(props: {
  open: boolean; plugins: readonly UiPluginCatalogEntry[]; pending: boolean;
  onOpenChange: (open: boolean) => void; onConfirm: () => void;
}) {
  const L = useVocab();
  return (
    <Modal title={L.plAckTitle} description={L.plAckDesc} open={props.open} layer="nested"
      onOpenChange={props.onOpenChange}
      footer={(
        <>
          <SButton tone="neutral" disabled={props.pending} onClick={() => props.onOpenChange(false)}>{L.plAckCancel}</SButton>
          <SButton tone="accent" disabled={props.pending} onClick={props.onConfirm}>{L.plAckConfirm}</SButton>
        </>
      )}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {props.plugins.map((plugin) => (
          <div key={plugin.id} style={NOTICE}>
            <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{pluginTitle(plugin)}</div>
            <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 4 }}>{plugin.id}</div>
            <div style={{ marginTop: 8 }}><McpServerSummary plugin={plugin} /></div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export interface PluginAssignViewProps {
  state: 'loading' | 'error' | 'ready';
  errorMessage: string | null;
  locked: boolean;
  plugins: UiPluginCatalogEntry[];
  scopedTargets: PluginAssignmentTarget[];
  selectedKey: string | null;
  target: PluginAssignmentTarget | null;
  draft: PluginsPanelDraft | null;
  unmanagedCount: number;
  pending: boolean;
  /** Pending excluding the body-editor lock: Reset must stay reachable while locked, or a draft
   *  made before the lock can only be escaped by reverting the JSON body. */
  busy: boolean;
  ackOpen: boolean;
  ackPlugins: UiPluginCatalogEntry[];
  onSelectTarget: (key: string) => void;
  onModeChange: (mode: 'inherit' | 'custom') => void;
  onTogglePlugin: (pluginId: string) => void;
  onReset: () => void;
  onSave: () => void;
  onAckOpenChange: (open: boolean) => void;
  onAckConfirm: () => void;
}

function AssignBody(props: PluginAssignViewProps) {
  const L = useVocab();
  const state = pluginDraftState(props.target, props.draft, props.pending);
  const resettable = pluginDraftState(props.target, props.draft, props.busy).canReset;
  const readOnly = targetReadOnlyReason(props.target);
  return (
    <>
      {props.scopedTargets.length > 1 ? (
        <Select data-plugin-target aria-label={L.plSlotLabel} value={props.selectedKey ?? ''}
          options={slotOptions(props.scopedTargets, L)} disabled={props.pending || state.dirty}
          onValueChange={props.onSelectTarget}
          style={{ width: '100%', boxSizing: 'border-box', padding: '6px 9px', border: '1px solid var(--proto-line)', borderRadius: 8 }} />
      ) : null}
      {readOnly ? <div data-plugin-readonly={readOnly} style={NOTICE}>{readonlyText(readOnly, L)}</div> : null}
      {props.unmanagedCount > 0 ? <div style={NOTICE}>{L.plUnmanagedNotice.replace('{n}', String(props.unmanagedCount))}</div> : null}
      {state.conflicted ? <div data-plugin-conflict="" style={NOTICE}>{L.plStaleDraft}</div> : null}
      <SlotModes target={props.target} draft={props.draft} pending={props.pending} onModeChange={props.onModeChange} />
      <div style={LIST}>
        {props.plugins.length > 0
          ? props.plugins.map((plugin) => (
            <PluginChoice key={plugin.id} plugin={plugin} target={props.target} draft={props.draft}
              pending={props.pending} onToggle={props.onTogglePlugin} />
          ))
          : <EmptyMessage text={L.plNoCatalog} dataAttr="data-plugins-empty" />}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <SButton tone="neutral" disabled={!resettable} data-action="reset"
          data-disabled={resettable ? 'false' : 'true'} onClick={props.onReset}>{L.plReset}</SButton>
        <SButton tone="accent" disabled={!state.canSave} data-action="save"
          data-disabled={state.canSave ? 'false' : 'true'} onClick={props.onSave}>{props.pending ? L.plSaving : L.plSave}</SButton>
      </div>
    </>
  );
}

export function PluginAssignView(props: PluginAssignViewProps) {
  const L = useVocab();
  return (
    <div data-plugin-assign="" style={WRAP}>
      {props.locked ? <div data-plugin-locked="" style={NOTICE}>{L.plLockedByBody}</div> : null}
      {props.state === 'loading' ? <EmptyMessage text={L.plLoading} dataAttr="data-plugins-loading" /> : null}
      {props.state === 'error'
        ? <EmptyMessage text={`${L.plLoadFailed} ${props.errorMessage ?? ''}`.trim()} dataAttr="data-plugins-error" />
        : null}
      {props.state === 'ready' && props.scopedTargets.length === 0
        ? <EmptyMessage text={L.plNoTargets} dataAttr="data-plugins-empty" />
        : null}
      {props.state === 'ready' && props.scopedTargets.length > 0 ? <AssignBody {...props} /> : null}
      <AckModal open={props.ackOpen} plugins={props.ackPlugins} pending={props.pending}
        onOpenChange={props.onAckOpenChange} onConfirm={props.onAckConfirm} />
    </div>
  );
}

function usePluginAssignProps(props: PluginAssignPanelProps): PluginAssignViewProps {
  const { onDirtyChange, onSaved } = props;
  const scopeKind = props.scope.kind;
  const scopeName = props.scope.name;
  const scope = useMemo<PluginAssignScope>(() => ({ kind: scopeKind, name: scopeName }), [scopeKind, scopeName]);
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

  const data = listQuery.data;
  const all = data?.targets ?? [];
  const scoped = scopedAssignTargets(all, scope);
  const locked = props.locked === true;
  const busy = assign.isPending || refreshing;
  const pending = busy || locked;
  const current = data ? selectionState(all, scope, selectedKey, draft) : { target: null, draft: null };
  const state = pluginDraftState(current.target, current.draft, pending);
  const dirty = state.dirty;

  useEffect(() => {
    if (!data) return;
    const next = selectionState(data.targets, scope, selectedKey, draft);
    if (targetKeyOf(next.target) !== selectedKey) setSelectedKey(targetKeyOf(next.target));
    if (next.draft !== draft) setDraft(next.draft);
  }, [data, scope, selectedKey, draft]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const refresh: RefreshArgs = {
    queryClient, trpc, scope, key: targetKeyOf(current.target), draft,
    setSelectedKey, setDraft, setRefreshing, toast, L, onSaved,
  };

  return {
    state: listQuery.isLoading ? 'loading' : listQuery.isError ? 'error' : 'ready',
    errorMessage: listQuery.isError ? errorMessage(listQuery.error) : null,
    locked,
    plugins: listQuery.data?.plugins ?? [],
    scopedTargets: scoped,
    selectedKey: targetKeyOf(current.target),
    target: current.target,
    draft: current.draft,
    unmanagedCount: effectiveUnmanagedPluginCount(current.target, all, current.draft?.mode ?? null),
    pending,
    busy,
    ackOpen: ack !== null,
    ackPlugins: ack?.plugins ?? [],
    onSelectTarget: (key) => {
      if (pending || state.dirty) return;
      const next = selectionState(all, scope, key, null);
      setSelectedKey(targetKeyOf(next.target));
      setDraft(next.draft);
    },
    onModeChange: (mode) => {
      if (!current.target || !current.draft || pending) return;
      setDraft(setPluginDraftMode(current.draft, current.target, all, mode));
    },
    onTogglePlugin: (pluginId) => {
      if (!current.target || !current.draft || pending) return;
      const plugin = listQuery.data?.plugins.find((item) => item.id === pluginId);
      if (plugin) setDraft(togglePluginDraftId(current.draft, current.target, plugin));
    },
    onReset: () => {
      if (!current.target || busy) return;
      setDraft(createPluginDraft(current.target, all));
    },
    onSave: () => {
      if (pending || !listQuery.data) return;
      const payload = buildPluginsAssignArgs(current.target, current.draft);
      if (!payload) return;
      const mcp = draftMcpPlugins(current.target, current.draft, listQuery.data.plugins);
      if (mcp.length > 0) {
        setAck({ key: targetKeyOf(current.target), payload, plugins: mcp });
        return;
      }
      void submitAssign({ ...refresh, assign, payload });
    },
    onAckOpenChange: (open) => { if (!open && !pending) setAck(null); },
    onAckConfirm: () => {
      if (!ack || pending) return;
      setAck(null);
      void submitAssign({ ...refresh, key: ack.key, assign, payload: { ...ack.payload, acknowledgeMcp: true } });
    },
  };
}

export function PluginAssignPanel(props: PluginAssignPanelProps) {
  return <PluginAssignView {...usePluginAssignProps(props)} />;
}
