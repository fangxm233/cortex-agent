import '@/features/settings/ui/desktop-panels.css';
import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PluginAssignmentTarget, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import { Modal } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import {
  ROW_STYLE, SButton, SCode, SFacts, SFieldRow, SLinkAction, SMeta, SNotice, SRowGroup, SSection, SSegmented, SStatus,
  S_CONTROL_STYLE,
} from '@/features/settings/ui/settings-ui';
import {
  DETAIL_PANE_STYLE, EDITOR_COLUMNS_STYLE, EDITOR_ROOT_STYLE, LIST_BODY_STYLE, ListHeader, PANE_BODY_STYLE,
  PANE_HEADER_STYLE, PaneFooter, listPaneStyle, listRowStyle,
} from '@/features/settings/ui/master-detail-ui';
import {
  EmptyMessage, IssueList,
  manifestSourceText, pluginKindText, pluginTitle, scopeNoticeText,
} from '@/features/settings/ui/plugin-ui';
import {
  PLUGIN_TABS, filterPlugins, pluginUsage, resolvePluginSelection,
  type PluginTab, type PluginUsage,
} from '@/features/settings/vm/plugins-panel-vm';
import { isCanonicalName } from '@/features/settings/vm/plugin-authoring-vm';
import { PluginSkillsTab } from './PluginSkillsTab';
import { PluginMcpTab } from './PluginMcpTab';
import { usePluginAuthoring, type PluginAuthoringActions } from '@/features/settings/controllers/usePluginAuthoring';

const MONO = "'IBM Plex Mono',monospace";
const LIST_WIDTH = 244;

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
      style={{ ...listRowStyle(props.active, 'stretch'), flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          font: `600 12px ${MONO}`, minWidth: 0, overflowWrap: 'anywhere',
          color: props.active ? 'var(--proto-ink)' : 'var(--proto-ink-2)',
        }}>{props.plugin.id}</span>
        {props.plugin.valid ? null : <SStatus tone="danger">{L.plInvalid}</SStatus>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--proto-muted-2)' }}>
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
          <SButton tone="primary" data-action="plugin-create-confirm"
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
  const builtin = props.plugin.origin === 'builtin';
  return (
    <Modal open layer="nested" contentClassName="settings-surface settings-nested-modal"
      contentDataAttributes={{ 'data-settings-dialog': '' }} title={L.plDeletePluginTitle.replace('{name}', props.plugin.id)}
      onOpenChange={(next) => { if (!next) props.onClose(); }}
      footer={(
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
          <SButton tone="neutral" onClick={props.onClose}>{L.plCancel}</SButton>
          <SButton tone="danger" data-action="plugin-delete-confirm" disabled={props.actions.busy || builtin}
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
        {builtin ? <SNotice tone="amber" data-plugin-delete-builtin="">{L.plDeletePluginBuiltin}</SNotice> : null}
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
    <div className="settings-list-pane" style={listPaneStyle(LIST_WIDTH)}>
      <ListHeader title={L.plCatalogTitle} count={props.plugins.length} searchAttr="data-plugin-search"
        search={props.search} placeholder={L.plSearchPh} onSearch={props.onSearch} />
      <div style={LIST_BODY_STYLE}>
        {props.visible.length > 0
          ? props.visible.map((plugin) => (
            <PluginListRow key={plugin.id} plugin={plugin}
              active={plugin.id === props.selectedId} onSelect={props.onSelect} />
          ))
          : <div style={{ padding: '4px 10px' }}><EmptyMessage text={L.plNoCatalog} dataAttr="data-plugins-empty" /></div>}
      </div>
      <PaneFooter>
        <SLinkAction data-action="plugin-create" disabled={props.actions.busy} onClick={() => setCreating(true)}>
          + {L.plNewPlugin}
        </SLinkAction>
      </PaneFooter>
      {creating ? <CreatePluginModal actions={props.actions} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function UsageRow({ item }: { item: PluginUsage }) {
  const L = useVocab();
  return (
    <div data-plugin-usage={item.key} style={{ ...ROW_STYLE, flexWrap: 'wrap', overflowWrap: 'anywhere', gap: 8 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)', minWidth: 0 }}>{item.name}</span>
      <SMeta>{L.plTargetAgent}</SMeta>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {scopeNote ? <SNotice tone="muted" data-plugin-scope={plugin.scope}>{scopeNote}</SNotice> : null}
      <SFacts data-plugin-facts="" rows={[
        { k: L.plRootDirLabel, v: <SCode>{plugin.rootDir}</SCode> },
        { k: L.plManifestSourceLabel, v: manifestSourceText(plugin.manifest.source, L) },
        { k: L.plManifestDescLabel, v: plugin.manifest.description ?? L.plUnknownValue },
      ]} />
      <SSection label={L.plUsedByLabel}><UsageList usage={usage} /></SSection>
      <SSection label={L.plIssuesLabel}><IssueList plugin={plugin} /></SSection>
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

function pluginMeta(plugin: UiPluginCatalogEntry, L: Vocab): string {
  return [
    plugin.manifest.version ?? L.plUnknownValue,
    pluginKindText(plugin.kind, L),
    plugin.origin === 'builtin' ? L.plOriginBuiltin : L.plOriginLocal,
  ].join(' · ');
}

/** Name, then version · kind · origin as one meta line; validity is said only when it fails. */
function PluginHeader(props: { plugin: UiPluginCatalogEntry; busy: boolean; onDelete: () => void }) {
  const L = useVocab();
  const plugin = props.plugin;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)', minWidth: 0, overflowWrap: 'anywhere' }}>{pluginTitle(plugin)}</span>
      <SMeta data-plugin-origin={plugin.origin}>{pluginMeta(plugin, L)}</SMeta>
      {plugin.valid ? null : <SStatus data-plugin-invalid="" tone="danger">{L.plInvalid}</SStatus>}
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
      <div className="settings-detail-pane" style={{ ...DETAIL_PANE_STYLE, alignItems: 'center', justifyContent: 'center' }}>
        <span data-plugin-detail-empty="" style={{ fontSize: 12, color: 'var(--proto-muted-2)' }}>{L.plSelectPrompt}</span>
      </div>
    );
  }
  const plugin = props.plugin;
  return (
    <div className="settings-detail-pane" data-plugin-detail={plugin.id} style={DETAIL_PANE_STYLE}>
      <div style={PANE_HEADER_STYLE}>
        <PluginHeader plugin={plugin} busy={props.actions.busy} onDelete={() => setDeleting(true)} />
        <PluginTabs tab={props.tab} onTab={props.onTab} />
      </div>
      <div className="settings-detail-fields" style={PANE_BODY_STYLE}>
        {props.tab === 'overview' ? <OverviewTab plugin={plugin} usage={usage} /> : null}
        {props.tab === 'skills'
          ? <PluginSkillsTab plugin={plugin} plugins={props.plugins} actions={props.actions} />
          : null}
        {props.tab === 'mcp' ? <PluginMcpTab plugin={plugin} actions={props.actions} /> : null}
      </div>
      {deleting
        ? <DeletePluginModal plugin={plugin} actions={props.actions} onClose={() => setDeleting(false)} />
        : null}
    </div>
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
    <div data-settings-panel="plugins" style={EDITOR_ROOT_STYLE}>
      {props.state === 'loading' ? <EmptyMessage text={L.plLoading} dataAttr="data-plugins-loading" /> : null}
      {props.state === 'error'
        ? <EmptyMessage text={`${L.plLoadFailed} ${props.errorMessage ?? ''}`.trim()} dataAttr="data-plugins-error" />
        : null}
      {props.state === 'ready' ? (
        <div className="settings-editor-columns" data-plugin-cards="" style={EDITOR_COLUMNS_STYLE}>
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
  const listQuery = useQuery(trpc.plugins.list.queryOptions({}));
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
