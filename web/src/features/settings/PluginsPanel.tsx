// input:  the plugin catalog query and shared plugin presentation pieces
// output: a bounded master-detail view of what each installed plugin contains
// pos:    Desktop plugin package manager
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PluginAssignmentTarget, PluginsListReturn, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import { Modal } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { SButton, SCard, SCardHeader, SFieldRow, S_CONTROL_STYLE } from './settings-ui';
import {
  EmptyMessage, IssueList, MetaBlock, MetaSection,
  NOTICE, PILL,
  manifestSourceText, pluginKindText, pluginTitle, scopeNoticeText,
} from './plugin-ui';
import {
  PLUGIN_TABS, filterPlugins, pluginUsage, resolvePluginSelection,
  type PluginTab, type PluginUsage,
} from './plugins-panel-vm';
import { isCanonicalName } from './plugin-authoring-vm';
import { PluginSkillsTab } from './PluginSkillsTab';
import { PluginMcpTab } from './PluginMcpTab';
import { usePluginAuthoring, type PluginAuthoringActions } from './usePluginAuthoring';

const MONO = "'IBM Plex Mono',monospace";
const LIST_WIDTH = 232;

const PANEL: CSSProperties = {
  marginTop: 12, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
};
const CARDS: CSSProperties = {
  display: 'flex', gap: 12, flex: 1, minHeight: 0, alignItems: 'stretch',
};
const LIST_CARD: CSSProperties = {
  width: LIST_WIDTH, flex: 'none', minHeight: 0,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
};
const DETAIL_CARD: CSSProperties = {
  flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
};

const TAB_LABEL: Record<PluginTab, keyof Vocab> = {
  overview: 'plTabOverview',
  skills: 'plTabSkills',
  mcp: 'plTabMcp',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PluginListRow(props: {
  plugin: UiPluginCatalogEntry;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const L = useVocab();
  return (
    <div role="button" data-plugin-item={props.plugin.id} data-active={props.active ? '' : undefined}
      onClick={() => props.onSelect(props.plugin.id)}
      style={{
        padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
        background: props.active ? 'var(--proto-accent-bg)' : 'transparent',
        display: 'flex', flexDirection: 'column', gap: 3,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          font: `600 11px ${MONO}`, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          color: props.active ? 'var(--proto-accent)' : 'var(--proto-ink)',
        }}>{props.plugin.id}</span>
        {props.plugin.valid ? null : <span style={{ font: `500 9px ${MONO}`, color: 'var(--proto-danger)' }}>!</span>}
      </div>
      <div style={{ fontSize: 9.5, color: 'var(--proto-faint)' }}>
        {L.plSkillCount.replace('{n}', String(props.plugin.skills.length))}
        {props.plugin.mcp.servers.length > 0 ? ` · ${L.plMcpCount.replace('{n}', String(props.plugin.mcp.servers.length))}` : ''}
      </div>
    </div>
  );
}

function CreatePluginModal(props: { actions: PluginAuthoringActions; onClose: () => void }) {
  const L = useVocab();
  const [id, setId] = useState('');
  const [description, setDescription] = useState('');
  const bad = id.length > 0 && !isCanonicalName(id);
  return (
    <Modal open layer="nested" title={L.plNewPluginTitle}
      onOpenChange={(next) => { if (!next) props.onClose(); }}
      footer={(
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <SButton tone="neutral" onClick={props.onClose}>{L.plCancel}</SButton>
          <SButton tone="accent" data-action="plugin-create-confirm"
            disabled={props.actions.busy || !isCanonicalName(id)}
            onClick={async () => {
              const done = await props.actions.pluginCreate({ id, description: description.trim() || undefined });
              if (done) props.onClose();
            }}>
            {L.plCreate}
          </SButton>
        </div>
      )}>
      <SFieldRow label={L.plNewPluginId} hint={bad ? L.plNameInvalid : undefined} hintTone="danger">
        <input data-field="plugin-id" value={id} onChange={(event) => setId(event.target.value)}
          style={S_CONTROL_STYLE} />
      </SFieldRow>
      <SFieldRow label={L.plNewPluginDesc}>
        <input data-field="plugin-description" value={description}
          onChange={(event) => setDescription(event.target.value)} style={S_CONTROL_STYLE} />
      </SFieldRow>
    </Modal>
  );
}

function DeletePluginModal(props: {
  plugin: UiPluginCatalogEntry;
  actions: PluginAuthoringActions;
  onClose: () => void;
}) {
  const L = useVocab();
  const managed = props.plugin.origin === 'managed';
  return (
    <Modal open layer="nested" title={L.plDeletePluginTitle.replace('{name}', props.plugin.id)}
      onOpenChange={(next) => { if (!next) props.onClose(); }}
      footer={(
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <SButton tone="neutral" onClick={props.onClose}>{L.plCancel}</SButton>
          <SButton tone="danger" data-action="plugin-delete-confirm" disabled={props.actions.busy || managed}
            onClick={async () => {
              const done = await props.actions.pluginRemove({ id: props.plugin.id });
              if (done) props.onClose();
            }}>
            {L.plConfirmDelete}
          </SButton>
        </div>
      )}>
      <div style={{ fontSize: 11, color: 'var(--proto-muted-2)' }}>{L.plDeletePluginDesc}</div>
      {managed
        ? <div data-plugin-delete-managed="" style={{ ...NOTICE, marginTop: 8 }}>{L.plDeletePluginManaged}</div>
        : null}
    </Modal>
  );
}

function PluginList(props: {
  plugins: readonly UiPluginCatalogEntry[];
  visible: readonly UiPluginCatalogEntry[];
  search: string;
  selectedId: string | null;
  actions: PluginAuthoringActions;
  onSearch: (value: string) => void;
  onSelect: (id: string) => void;
}) {
  const L = useVocab();
  const [creating, setCreating] = useState(false);
  return (
    <SCard style={LIST_CARD}>
      <SCardHeader title={L.plCatalogTitle} right={`${props.plugins.length}`} />
      <div style={{ padding: '8px 10px', flex: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input data-plugin-search="" value={props.search} placeholder={L.plSearchPh}
          onChange={(event) => props.onSearch(event.target.value)}
          style={{ ...S_CONTROL_STYLE, width: '100%', boxSizing: 'border-box', padding: '4px 8px' }} />
        <SButton tone="neutral" data-action="plugin-create" disabled={props.actions.busy}
          onClick={() => setCreating(true)} style={{ width: '100%' }}>
          {L.plNewPlugin}
        </SButton>
        {creating ? <CreatePluginModal actions={props.actions} onClose={() => setCreating(false)} /> : null}
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '0 6px 8px' }}>
        {props.visible.length > 0
          ? props.visible.map((plugin) => (
            <PluginListRow key={plugin.id} plugin={plugin}
              active={plugin.id === props.selectedId} onSelect={props.onSelect} />
          ))
          : <div style={{ padding: '8px 10px' }}><EmptyMessage text={L.plNoCatalog} dataAttr="data-plugins-empty" /></div>}
      </div>
    </SCard>
  );
}

function UsageList({ usage }: { usage: readonly PluginUsage[] }) {
  const L = useVocab();
  if (usage.length === 0) return <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)' }}>{L.plUsedByNone}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {usage.map((item) => (
        <div key={item.key} data-plugin-usage={item.key} style={{ fontSize: 10.5, color: 'var(--proto-muted-2)' }}>
          <span style={{ ...PILL, marginRight: 6 }}>{item.kind === 'agent' ? L.plTargetAgent : L.plTargetSlot}</span>
          <span style={{ font: `500 10.5px ${MONO}`, color: 'var(--proto-ink-2)' }}>{item.name}</span>
          {item.slot ? <span style={{ marginLeft: 6 }}>{item.slot}</span> : null}
        </div>
      ))}
    </div>
  );
}

function OverviewTab({ plugin, usage }: { plugin: UiPluginCatalogEntry; usage: readonly PluginUsage[] }) {
  const L = useVocab();
  const scopeNote = scopeNoticeText(plugin, L);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {scopeNote ? <div data-plugin-scope={plugin.scope} style={NOTICE}>{scopeNote}</div> : null}
      <MetaBlock label={L.plRootDirLabel} value={plugin.rootDir} />
      <MetaBlock label={L.plManifestSourceLabel} value={manifestSourceText(plugin.manifest.source, L)} />
      <MetaBlock label={L.plManifestDescLabel} value={plugin.manifest.description ?? L.plUnknownValue} />
      <MetaSection label={L.plUsedByLabel}><UsageList usage={usage} /></MetaSection>
      <MetaSection label={L.plIssuesLabel}><IssueList plugin={plugin} /></MetaSection>
    </div>
  );
}

function PluginTabs(props: { tab: PluginTab; onTab: (tab: PluginTab) => void }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--proto-line-2)' }}>
      {PLUGIN_TABS.map((key) => {
        const active = key === props.tab;
        return (
          <span key={key} role="button" data-plugin-tab={key} data-active={active ? '' : undefined}
            onClick={() => props.onTab(key)}
            style={{
              fontSize: 11, fontWeight: 600, padding: '5px 10px', cursor: 'pointer',
              color: active ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
              borderBottom: `2px solid ${active ? 'var(--proto-accent)' : 'transparent'}`,
              marginBottom: -1,
            }}>
            {L[TAB_LABEL[key]]}
          </span>
        );
      })}
    </div>
  );
}

function PluginDetail(props: {
  plugin: UiPluginCatalogEntry | null;
  plugins: readonly UiPluginCatalogEntry[];
  targets: readonly PluginAssignmentTarget[];
  tab: PluginTab;
  actions: PluginAuthoringActions;
  onTab: (tab: PluginTab) => void;
}) {
  const L = useVocab();
  const [deleting, setDeleting] = useState(false);
  const usage = useMemo(
    () => (props.plugin ? pluginUsage(props.targets, props.plugin.id) : []),
    [props.targets, props.plugin],
  );
  if (!props.plugin) {
    return (
      <SCard style={{ ...DETAIL_CARD, alignItems: 'center', justifyContent: 'center' }}>
        <span data-plugin-detail-empty="" style={{ fontSize: 11, color: 'var(--proto-faint)' }}>{L.plSelectPrompt}</span>
      </SCard>
    );
  }
  const plugin = props.plugin;
  return (
    <SCard data-plugin-detail={plugin.id} style={DETAIL_CARD}>
      <div style={{ padding: '10px 14px 0', flex: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--proto-ink)' }}>{pluginTitle(plugin)}</span>
          <span style={PILL}>{plugin.manifest.version ?? L.plUnknownValue}</span>
          <span style={PILL}>{pluginKindText(plugin.kind, L)}</span>
          <span data-plugin-origin={plugin.origin} style={PILL}>
            {plugin.origin === 'managed' ? L.plOriginManaged : L.plOriginLocal}
          </span>
          <span style={{ ...PILL, color: plugin.valid ? 'var(--proto-muted-2)' : 'var(--proto-danger)' }}>
            {plugin.valid ? L.plValid : L.plInvalid}
          </span>
          <SButton tone="danger" data-action="plugin-delete" disabled={props.actions.busy}
            style={{ marginLeft: 'auto' }} onClick={() => setDeleting(true)}>
            {L.plDeletePlugin}
          </SButton>
        </div>
        <PluginTabs tab={props.tab} onTab={props.onTab} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px' }}>
        {props.tab === 'overview' ? <OverviewTab plugin={plugin} usage={usage} /> : null}
        {props.tab === 'skills'
          ? <PluginSkillsTab plugin={plugin} plugins={props.plugins} actions={props.actions} />
          : null}
        {props.tab === 'mcp' ? <PluginMcpTab plugin={plugin} actions={props.actions} /> : null}
      </div>
      {deleting
        ? <DeletePluginModal plugin={plugin} actions={props.actions} onClose={() => setDeleting(false)} />
        : null}
    </SCard>
  );
}

export interface PluginsPanelViewProps {
  state: 'loading' | 'error' | 'ready';
  errorMessage: string | null;
  plugins: UiPluginCatalogEntry[];
  targets: PluginAssignmentTarget[];
  search: string;
  selectedId: string | null;
  tab: PluginTab;
  actions: PluginAuthoringActions;
  onSearch: (value: string) => void;
  onSelect: (id: string) => void;
  onTab: (tab: PluginTab) => void;
}

export function PluginsPanelView(props: PluginsPanelViewProps) {
  const L = useVocab();
  const visible = filterPlugins(props.plugins, props.search);
  const selected = resolvePluginSelection(visible, props.selectedId);
  return (
    <div data-settings-panel="plugins" style={PANEL}>
      {props.state === 'loading' ? <EmptyMessage text={L.plLoading} dataAttr="data-plugins-loading" /> : null}
      {props.state === 'error'
        ? <EmptyMessage text={`${L.plLoadFailed} ${props.errorMessage ?? ''}`.trim()} dataAttr="data-plugins-error" />
        : null}
      {props.state === 'ready' ? (
        <div data-plugin-cards="" style={CARDS}>
          <PluginList plugins={props.plugins} visible={visible} search={props.search}
            selectedId={selected?.id ?? null} actions={props.actions}
            onSearch={props.onSearch} onSelect={props.onSelect} />
          <PluginDetail plugin={selected} plugins={props.plugins} targets={props.targets}
            tab={props.tab} actions={props.actions} onTab={props.onTab} />
        </div>
      ) : null}
    </div>
  );
}

export function PluginsPanel() {
  const trpc = useTRPC();
  const listQuery = useQuery<PluginsListReturn>(trpc.plugins.list.queryOptions({}) as never);
  const actions = usePluginAuthoring();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<PluginTab>('overview');
  return (
    <PluginsPanelView
      state={listQuery.isLoading ? 'loading' : listQuery.isError ? 'error' : 'ready'}
      errorMessage={listQuery.isError ? errorMessage(listQuery.error) : null}
      plugins={listQuery.data?.plugins ?? []}
      targets={listQuery.data?.targets ?? []}
      search={search}
      selectedId={selectedId}
      tab={tab}
      actions={actions}
      onSearch={setSearch}
      onSelect={setSelectedId}
      onTab={setTab}
    />
  );
}
