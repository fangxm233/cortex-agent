import { useEffect, useMemo, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PluginAssignmentTarget, UiPluginCatalogEntry, MutateArgs } from '@cortex-agent/ui-contract';
import { Modal, useToast } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { trpcErrorCode, useTRPC } from '@/lib/trpc';
import { SButton, SNotice, SPill, Toggle } from '@/features/settings/ui/settings-ui';
import {
  EmptyMessage, McpServerSummary, ROW,
  pluginTitle, scopeNoticeText,
} from '@/features/settings/ui/plugin-ui';
import {
  buildPluginsAssignArgs,
  createPluginDraft,
  draftMcpPlugins,
  pluginDraftState,
  pluginTargetKey,
  pluginToggleDisabledReason,
  resolvePluginTarget,
  scopedAssignTargets,
  syncPluginDraft,
  togglePluginDraftId,
  type PluginAssignScope,
  type PluginsPanelDraft,
} from '@/features/settings/vm/plugin-assign-vm';

const MONO = "'IBM Plex Mono',monospace";

const WRAP: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
const LIST: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };

type ToastFn = ReturnType<typeof useToast>['toast'];
type AssignMutation = { mutateAsync: (payload: MutateArgs<'plugins.assign'>) => Promise<unknown> };

interface AckState { key: string | null; payload: MutateArgs<'plugins.assign'>; plugins: UiPluginCatalogEntry[] }

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

function isConflictError(error: unknown, message: string): boolean {
  return trpcErrorCode(error) === 'CONFLICT' || /changed on disk/i.test(message);
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
  return { target, draft: syncPluginDraft(target, draft) };
}

async function refreshCatalog(args: RefreshArgs, preserveDraft: boolean): Promise<void> {
  await args.queryClient.invalidateQueries(args.trpc.plugins.list.queryFilter({}));
  const fresh = await args.queryClient.fetchQuery(args.trpc.plugins.list.queryOptions({}));
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
  args: RefreshArgs & { assign: AssignMutation; payload: MutateArgs<'plugins.assign'> },
): Promise<void> {
  try {
    await args.assign.mutateAsync(args.payload);
  } catch (error) {
    const message = errorMessage(error);
    if (!isConflictError(error, message)) {
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
      data-plugin-disabled-reason={reason ?? undefined}
      style={{ ...ROW, flexDirection: 'row', alignItems: 'flex-start', gap: 14 }}>
      <Toggle on={selected} onClick={reason ? undefined : () => props.onToggle(props.plugin.id)} inert={Boolean(reason)}
        ariaLabel={L.plToggleLabel.replace('{name}', pluginTitle(props.plugin))} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)', minWidth: 0, overflowWrap: 'anywhere' }}>{pluginTitle(props.plugin)}</span>
          {props.plugin.origin === 'builtin' ? <SPill tone="strong" data-plugin-builtin="">{L.plOriginBuiltin}</SPill> : null}
          <SPill>{L.plSkillCount.replace('{n}', String(props.plugin.skills.length))}</SPill>
          {props.plugin.mcp.servers.length > 0
            ? <SPill tone="strong">{L.plMcpCount.replace('{n}', String(props.plugin.mcp.servers.length))}</SPill>
            : null}
          {props.plugin.assignable ? null : <SPill tone="danger">{L.plUnassignable}</SPill>}
        </div>
        {props.plugin.manifest.description
          ? <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--proto-muted-2)' }}>{props.plugin.manifest.description}</div>
          : null}
        {scopeNote ? <SNotice tone="muted" data-plugin-scope={props.plugin.scope}>{scopeNote}</SNotice> : null}
      </div>
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
      contentClassName="settings-surface settings-nested-modal"
      contentDataAttributes={{ 'data-settings-dialog': '' }}
      onOpenChange={props.onOpenChange}
      footer={(
        <>
          <SButton tone="neutral" disabled={props.pending} onClick={() => props.onOpenChange(false)}>{L.plAckCancel}</SButton>
          <SButton tone="primary" disabled={props.pending} onClick={props.onConfirm}>{L.plAckConfirm}</SButton>
        </>
      )}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {props.plugins.map((plugin) => (
          <div key={plugin.id} style={ROW}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)', overflowWrap: 'anywhere' }}>{pluginTitle(plugin)}</div>
            <div style={{ font: `400 12px ${MONO}`, color: 'var(--proto-muted-3)', marginTop: 4, overflowWrap: 'anywhere' }}>{plugin.id}</div>
            <div style={{ marginTop: 10 }}><McpServerSummary plugin={plugin} /></div>
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
  return (
    <>
      {props.unmanagedCount > 0 ? <SNotice tone="muted">{L.plUnmanagedNotice.replace('{n}', String(props.unmanagedCount))}</SNotice> : null}
      {/* The marker stays on a plain wrapper: hung on the notice it would appear twice, once on the
          component and once on the element it renders. */}
      {state.conflicted ? <div data-plugin-conflict=""><SNotice tone="amber">{L.plStaleDraft}</SNotice></div> : null}
      <div style={LIST}>
        {props.plugins.length > 0
          ? props.plugins.map((plugin) => (
            <PluginChoice key={plugin.id} plugin={plugin} target={props.target} draft={props.draft}
              pending={props.pending} onToggle={props.onTogglePlugin} />
          ))
          : <EmptyMessage text={L.plNoCatalog} dataAttr="data-plugins-empty" />}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <SButton tone="neutral" disabled={!resettable} data-action="reset"
          data-disabled={resettable ? 'false' : 'true'} onClick={props.onReset}>{L.plReset}</SButton>
        <SButton tone="primary" disabled={!state.canSave} data-action="save"
          data-disabled={state.canSave ? 'false' : 'true'} onClick={props.onSave}>{props.pending ? L.plSaving : L.plSave}</SButton>
      </div>
    </>
  );
}

export function PluginAssignView(props: PluginAssignViewProps) {
  const L = useVocab();
  return (
    <div data-plugin-assign="" style={WRAP}>
      {props.locked ? <SNotice tone="amber" data-plugin-locked="">{L.plLockedByBody}</SNotice> : null}
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
  const scopeName = props.scope.name;
  const scope = useMemo<PluginAssignScope>(() => ({ name: scopeName }), [scopeName]);
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const listQuery = useQuery(trpc.plugins.list.queryOptions({}));
  const assign = useMutation(trpc.plugins.assign.mutationOptions());
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
    unmanagedCount: current.target?.unmanagedPluginCount ?? 0,
    pending,
    busy,
    ackOpen: ack !== null,
    ackPlugins: ack?.plugins ?? [],
    onTogglePlugin: (pluginId) => {
      if (!current.target || !current.draft || pending) return;
      const plugin = listQuery.data?.plugins.find((item) => item.id === pluginId);
      if (plugin) setDraft(togglePluginDraftId(current.draft, current.target, plugin));
    },
    onReset: () => {
      if (!current.target || busy) return;
      setDraft(createPluginDraft(current.target));
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
