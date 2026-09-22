// input:  plugin queries, settings atoms, authoring tabs
// output: readable plugin catalog and glass nested dialogs
// pos:    Responsive plugin master-detail panel
// >>> Once updated, update this header and parent AGENTS.md <<<

import './desktop-panels.css';
import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PluginAssignmentTarget, PluginsListReturn, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import { Modal } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import {
  ROW_STYLE, SButton, SCard, SCardHeader, SFieldRow, SNotice, SPill, SRowGroup, SSegmented,
  S_CONTROL_STYLE,
} from './settings-ui';
import {
  EmptyMessage, IssueList, MetaBlock, MetaSection,
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
const LIST_WIDTH = 244;

const PANEL: CSSProperties = {
  flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
};
const CARDS: CSSProperties = {
  display: 'flex', gap: 14, flex: 1, minHeight: 0, alignItems: 'stretch',
};
const LIST_CARD: CSSProperties = {
  width: LIST_WIDTH, flex: 'none', minHeight: 0,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
};
const DETAIL_CARD: CSSProperties = {
  flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
};
// The detail header holds still while the tab body scrolls under it, so the two are parted by a
// hairline: inside a card a divider stays a border, only the card itself outlines with a ring.
const DETAIL_HEADER: CSSProperties = {
  padding: '14px 16px', flex: 'none', borderBottom: '1px solid var(--proto-line-2)',
};

const MODAL_TEXT: CSSProperties = { fontSize: 13, lineHeight: 1.6, color: 'var(--proto-muted-2)' };

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
        padding: '9px 12px', borderRadius: 'var(--r-control)', cursor: 'pointer',
        background: props.active ? 'var(--proto-accent-bg)' : 'transparent',
        display: 'flex', flexDirection: 'column', gap: 3, flex: 'none',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          font: `600 13px ${MONO}`, minWidth: 0, overflowWrap: 'anywhere',
          color: props.active ? 'var(--settings-selected-ink)' : 'var(--proto-ink)',
        }}>{props.plugin.id}</span>
        {props.plugin.valid ? null : <span style={{ font: `600 11px ${MONO}`, color: 'var(--proto-danger)' }}>!</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--proto-muted-3)' }}>
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
    <Modal open layer="nested" contentClassName="settings-surface settings-nested-modal"
      contentDataAttributes={{ 'data-settings-dialog': '' }} title={L.plNewPluginTitle}
      onOpenChange={(next) => { if (!next) props.onClose(); }}
      footer={(
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
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
    <Modal open layer="nested" contentClassName="settings-surface settings-nested-modal"
      contentDataAttributes={{ 'data-settings-dialog': '' }} title={L.plDeletePluginTitle.replace('{name}', props.plugin.id)}
      onOpenChange={(next) => { if (!next) props.onClose(); }}
      footer={(
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={MODAL_TEXT}>{L.plDeletePluginDesc}</div>
        {managed ? <SNotice tone="amber" data-plugin-delete-managed="">{L.plDeletePluginManaged}</SNotice> : null}
      </div>
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
    <SCard className="settings-list-pane" style={LIST_CARD}>
      <SCardHeader title={L.plCatalogTitle} right={`${props.plugins.length}`} />
      <div style={{ padding: '12px 14px', flex: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input data-plugin-search="" value={props.search} placeholder={L.plSearchPh}
          onChange={(event) => props.onSearch(event.target.value)} style={S_CONTROL_STYLE} />
        <SButton tone="neutral" data-action="plugin-create" disabled={props.actions.busy}
          onClick={() => setCreating(true)} style={{ width: '100%' }}>
          {L.plNewPlugin}
        </SButton>
        {creating ? <CreatePluginModal actions={props.actions} onClose={() => setCreating(false)} /> : null}
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '0 8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {props.visible.length > 0
          ? props.visible.map((plugin) => (
            <PluginListRow key={plugin.id} plugin={plugin}
              active={plugin.id === props.selectedId} onSelect={props.onSelect} />
          ))
          : <div style={{ padding: '4px 8px' }}><EmptyMessage text={L.plNoCatalog} dataAttr="data-plugins-empty" /></div>}
      </div>
    </SCard>
  );
}

function UsageRow({ item }: { item: PluginUsage }) {
  const L = useVocab();
  return (
    <div data-plugin-usage={item.key} style={{ ...ROW_STYLE, flexWrap: 'wrap', overflowWrap: 'anywhere', gap: 8 }}>
      <SPill>{item.kind === 'agent' ? L.plTargetAgent : L.plTargetSlot}</SPill>
      <span style={{ font: `500 12px ${MONO}`, color: 'var(--proto-ink-2)', minWidth: 0 }}>{item.name}</span>
      {item.slot ? <span style={{ fontSize: 12, color: 'var(--proto-muted-2)' }}>{item.slot}</span> : null}
    </div>
  );
}

function UsageList({ usage }: { usage: readonly PluginUsage[] }) {
  const L = useVocab();
  if (usage.length === 0) return <div style={{ fontSize: 12, color: 'var(--proto-muted-2)' }}>{L.plUsedByNone}</div>;
  return <SRowGroup>{usage.map((item) => <UsageRow key={item.key} item={item} />)}</SRowGroup>;
}

function OverviewTab({ plugin, usage }: { plugin: UiPluginCatalogEntry; usage: readonly PluginUsage[] }) {
  const L = useVocab();
  const scopeNote = scopeNoticeText(plugin, L);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {scopeNote ? <SNotice tone="muted" data-plugin-scope={plugin.scope}>{scopeNote}</SNotice> : null}
      <SRowGroup>
        <MetaBlock label={L.plRootDirLabel} value={plugin.rootDir} />
        <MetaBlock label={L.plManifestSourceLabel} value={manifestSourceText(plugin.manifest.source, L)} />
        <MetaBlock label={L.plManifestDescLabel} value={plugin.manifest.description ?? L.plUnknownValue} />
      </SRowGroup>
      <MetaSection label={L.plUsedByLabel}><UsageList usage={usage} /></MetaSection>
      <MetaSection label={L.plIssuesLabel}><IssueList plugin={plugin} /></MetaSection>
    </div>
  );
}

function PluginTabs(props: { tab: PluginTab; onTab: (tab: PluginTab) => void }) {
  const L = useVocab();
  const options = PLUGIN_TABS.map((key) => ({ id: key, label: L[TAB_LABEL[key]] }));
  return (
    <div style={{ display: 'flex' }}>
      <SSegmented<PluginTab> value={props.tab} options={options} onChange={props.onTab}
        dataAttr="data-plugin-tab" />
    </div>
  );
}

function PluginHeader(props: { plugin: UiPluginCatalogEntry; busy: boolean; onDelete: () => void }) {
  const L = useVocab();
  const plugin = props.plugin;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)', minWidth: 0, overflowWrap: 'anywhere' }}>{pluginTitle(plugin)}</span>
      <SPill mono>{plugin.manifest.version ?? L.plUnknownValue}</SPill>
      <SPill>{pluginKindText(plugin.kind, L)}</SPill>
      <SPill data-plugin-origin={plugin.origin} tone={plugin.origin === 'managed' ? 'accent' : 'neutral'}>
        {plugin.origin === 'managed' ? L.plOriginManaged : L.plOriginLocal}
      </SPill>
      <SPill tone={plugin.valid ? 'success' : 'danger'}>{plugin.valid ? L.plValid : L.plInvalid}</SPill>
      <SButton tone="danger" data-action="plugin-delete" disabled={props.busy}
        style={{ marginLeft: 'auto' }} onClick={props.onDelete}>
        {L.plDeletePlugin}
      </SButton>
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
      <SCard className="settings-detail-pane" style={{ ...DETAIL_CARD, alignItems: 'center', justifyContent: 'center' }}>
        <span data-plugin-detail-empty="" style={{ fontSize: 13, color: 'var(--proto-muted-2)' }}>{L.plSelectPrompt}</span>
      </SCard>
    );
  }
  const plugin = props.plugin;
  return (
    <SCard className="settings-detail-pane" data-plugin-detail={plugin.id} style={DETAIL_CARD}>
      <div style={DETAIL_HEADER}>
        <PluginHeader plugin={plugin} busy={props.actions.busy} onDelete={() => setDeleting(true)} />
        <PluginTabs tab={props.tab} onTab={props.onTab} />
      </div>
      <div className="settings-detail-fields" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }}>
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
        <div className="settings-editor-columns" data-plugin-cards="" style={CARDS}>
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
