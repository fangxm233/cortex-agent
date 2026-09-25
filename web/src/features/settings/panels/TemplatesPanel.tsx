// input:  useTemplatesController, settings atoms, detail pane
// output: desktop template master-detail editor
// pos:    Template list and editor composition
// >>> Once updated, update this header and parent AGENTS.md <<<

import '@/features/settings/ui/desktop-panels.css';
import { useEffect, useState } from 'react';
import type { ThreadTemplateDetail, ThreadTemplateEntry, ThreadTemplateIssue } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { SChip, SLinkAction, SPill } from '@/features/settings/ui/settings-ui';
import { useTemplatesController } from '@/features/settings/controllers/useTemplatesController';
import {
  CHIP_COUNT_STYLE,
  EDITOR_COLUMNS_STYLE,
  EDITOR_ROOT_STYLE,
  LIST_BODY_STYLE,
  LIST_EMPTY_STYLE,
  ListHeader,
  PaneFooter,
  listPaneStyle,
  listRowStyle,
} from '@/features/settings/ui/master-detail-ui';
import {
  KindBadge,
  TemplateDetailPane,
  showsPluginTab,
  type Tab,
} from './TemplateDetailPane';
import {
  TEMPLATE_FILTER_KEYS,
  buildSaveArgs,
  countByFilter,
  formatBody,
  needsRunningConfirm,
  parseEditor,
  starterBody,
  type TemplateFilterKey,
  type TemplateKind,
  type TemplateSelection,
} from '@/features/settings/vm/templates-panel-vm';

const MONO = "'IBM Plex Mono',monospace";
const LIST_WIDTH = 248;

const FILTER_LABEL: Record<TemplateFilterKey, keyof Vocab> = {
  all: 'ttFilterAll',
  template: 'ttFilterTemplate',
  agent: 'ttFilterAgent',
  shell: 'ttFilterShell',
};

// ── list ──────────────────────────────────────────────────────────────────────────────────────

function TemplateRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ThreadTemplateEntry;
  selected: boolean;
  onSelect: (selection: TemplateSelection) => void;
}) {
  const L = useVocab();
  return (
    <div
      data-template-row={`${entry.kind}:${entry.name}`}
      data-selected={selected ? '' : undefined}
      role="button"
      onClick={() => onSelect({ kind: entry.kind, name: entry.name })}
      style={listRowStyle(selected)}
    >
      <KindBadge kind={entry.kind} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          font: `600 13px ${MONO}`,
          color: selected ? 'var(--proto-accent)' : 'var(--proto-ink-2)',
          overflowWrap: 'anywhere',
        }}
      >
        {entry.name}
      </span>
      {!entry.valid ? (
        <SPill data-invalid="" title={`${entry.errorCount}`} tone="danger">
          {L.ttInvalidBadge}
        </SPill>
      ) : null}
    </div>
  );
}

function TemplateFilters({ counts, filter, onFilter }: {
  counts: Record<TemplateFilterKey, number>;
  filter: TemplateFilterKey;
  onFilter: (key: TemplateFilterKey) => void;
}) {
  const L = useVocab();
  return (
    <>
      {TEMPLATE_FILTER_KEYS.map((key) => (
        <SChip
          key={key}
          data-template-filter={key}
          data-active={key === filter ? '' : undefined}
          active={key === filter}
          onClick={() => onFilter(key)}
        >
          {L[FILTER_LABEL[key]]}
          <span style={CHIP_COUNT_STYLE}>{counts[key]}</span>
        </SChip>
      ))}
    </>
  );
}

function TemplateList({
  entries,
  visible,
  filter,
  search,
  selection,
  onFilter,
  onSearch,
  onSelect,
  onStartCreate,
}: {
  entries: readonly ThreadTemplateEntry[];
  visible: readonly ThreadTemplateEntry[];
  filter: TemplateFilterKey;
  search: string;
  selection: TemplateSelection | null;
  onFilter: (key: TemplateFilterKey) => void;
  onSearch: (value: string) => void;
  onSelect: (selection: TemplateSelection) => void;
  onStartCreate: (kind: TemplateKind) => void;
}) {
  const L = useVocab();
  return (
    <div className="settings-list-pane" style={listPaneStyle(LIST_WIDTH)}>
      <ListHeader
        title={L.ttEditorTitle} count={entries.length} searchAttr="data-template-search"
        search={search} placeholder={L.ttSearchPh} onSearch={onSearch}
      >
        <TemplateFilters counts={countByFilter(entries, search)} filter={filter} onFilter={onFilter} />
      </ListHeader>

      <div style={LIST_BODY_STYLE}>
        {visible.length === 0 ? (
          <div data-templates-empty="" style={LIST_EMPTY_STYLE}>
            {entries.length === 0 ? L.stNoTemplates : L.ttNoMatch}
          </div>
        ) : (
          visible.map((entry) => (
            <TemplateRow
              key={`${entry.kind}:${entry.name}`}
              entry={entry}
              selected={selection?.kind === entry.kind && selection?.name === entry.name}
              onSelect={onSelect}
            />
          ))
        )}
      </div>

      <PaneFooter hint={`+ ${L.ttNew}`}>
        {(['template', 'agent', 'shell'] as const).map((kind) => (
          <SLinkAction key={kind} data-create-kind={kind} onClick={() => onStartCreate(kind)}>
            {kind}
          </SLinkAction>
        ))}
      </PaneFooter>
    </div>
  );
}

// ── view ──────────────────────────────────────────────────────────────────────────────────────

export interface TemplatesPanelViewProps {
  entries: readonly ThreadTemplateEntry[];
  visible: readonly ThreadTemplateEntry[];
  filter: TemplateFilterKey;
  search: string;
  selection: TemplateSelection | null;
  detail: ThreadTemplateDetail | null;
  creating: { kind: TemplateKind } | null;
  draftName: string;
  text: string;
  loaded: string;
  tab: Tab;
  liveIssues: { errors: ThreadTemplateIssue[]; warnings: ThreadTemplateIssue[] } | null;
  armedSave: boolean;
  armedDelete: boolean;
  busy: boolean;
  onFilter: (key: TemplateFilterKey) => void;
  onSearch: (value: string) => void;
  onSelect: (selection: TemplateSelection) => void;
  onStartCreate: (kind: TemplateKind) => void;
  onDraftName: (value: string) => void;
  onText: (value: string) => void;
  onTab: (tab: Tab) => void;
  onSave: () => void;
  onRevert: () => void;
  onValidate: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onCancelCreate: () => void;
  onFormat: () => void;
  onPluginDirtyChange?: (dirty: boolean) => void;
  onPluginSaved?: () => void;
}

export function TemplatesPanelView(props: TemplatesPanelViewProps) {
  return (
    <div data-settings-panel="templates" style={EDITOR_ROOT_STYLE}>
      <div className="settings-editor-columns" style={EDITOR_COLUMNS_STYLE}>
        <TemplateList
          entries={props.entries}
          visible={props.visible}
          filter={props.filter}
          search={props.search}
          selection={props.selection}
          onFilter={props.onFilter}
          onSearch={props.onSearch}
          onSelect={props.onSelect}
          onStartCreate={props.onStartCreate}
        />
        <TemplateDetailPane
          selection={props.selection}
          detail={props.detail}
          creating={props.creating}
          draftName={props.draftName}
          text={props.text}
          loaded={props.loaded}
          tab={props.tab}
          liveIssues={props.liveIssues}
          armedSave={props.armedSave}
          armedDelete={props.armedDelete}
          busy={props.busy}
          onDraftName={props.onDraftName}
          onText={props.onText}
          onTab={props.onTab}
          onSave={props.onSave}
          onRevert={props.onRevert}
          onValidate={props.onValidate}
          onDelete={props.onDelete}
          onDuplicate={props.onDuplicate}
          onCancelCreate={props.onCancelCreate}
          onPluginDirtyChange={props.onPluginDirtyChange}
          onPluginSaved={props.onPluginSaved}
          onFormat={props.onFormat}
        />
      </div>
    </div>
  );
}

// ── container ─────────────────────────────────────────────────────────────────────────────────

export function TemplatesPanel({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const L = useVocab();
  const { toast } = useToast();

  const [creating, setCreating] = useState<{ kind: TemplateKind } | null>(null);
  const [draftName, setDraftName] = useState('');
  const [tab, setTab] = useState<Tab>('body');
  /** Editor text. Null means "not touched" — the loaded body is the truth. */
  const [text, setText] = useState<string | null>(null);
  const [liveIssues, setLiveIssues] = useState<{ errors: ThreadTemplateIssue[]; warnings: ThreadTemplateIssue[] } | null>(null);
  const [armedSave, setArmedSave] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  const [createText, setCreateText] = useState('');
  const [pluginDirty, setPluginDirty] = useState(false);

  const templates = useTemplatesController({
    creating,
    onValidated: (issues) => {
      setLiveIssues(issues);
      setTab('validation');
    },
    onSaved: () => {
      setText(null);
      setArmedSave(false);
      setLiveIssues(null);
      if (creating) setCreating(null);
    },
    onRemoved: () => {
      setArmedDelete(false);
    },
  });
  const { entries, visible, selection, detail } = templates;

  const loaded = creating ? createText : detail?.body ? formatBody(detail.body) : '';
  const currentText = creating ? createText : (text ?? loaded);

  // Moving to another entity drops the working copy and every transient affordance with it.
  useEffect(() => {
    setText(null);
    setLiveIssues(null);
    setArmedSave(false);
    setArmedDelete(false);
    // The plugins tab does not exist for shells or while creating; fall back rather than blank out.
    setTab((current) => (current === 'plugins' && !showsPluginTab(selection?.kind ?? null, creating !== null) ? 'body' : current));
  }, [selection?.kind, selection?.name, creating?.kind, creating]);

  // Only the assignment draft blocks navigation: it is a committed-on-save form, whereas the JSON
  // buffer has always been free to abandon.
  useEffect(() => { onDirtyChange?.(pluginDirty); }, [pluginDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const startCreate = (kind: TemplateKind) => {
    setCreating({ kind });
    setDraftName('');
    setCreateText(formatBody(starterBody(kind, '')));
    setTab('body');
    setLiveIssues(null);
  };

  const kind = creating?.kind ?? selection?.kind ?? null;
  const name = creating ? draftName : (selection?.name ?? '');

  const onSave = () => {
    if (!kind) return;
    // A live thread on this template gets one confirmation, because transitions are re-read on
    // every step and a save can reroute or stall it.
    if (!creating && needsRunningConfirm(detail) && !armedSave) {
      setArmedSave(true);
      return;
    }
    const args = buildSaveArgs({
      kind,
      name,
      text: currentText,
      loaded,
      creating: creating !== null,
      baseHash: detail?.sha256 ?? null,
    });
    if (args) templates.save(args);
  };

  const onDelete = () => {
    if (!selection) return;
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }
    templates.remove(selection);
  };

  const onDuplicate = () => {
    if (!kind) return;
    setCreating({ kind });
    setDraftName(`${name}-copy`);
    setCreateText(currentText);
    setTab('body');
    setLiveIssues(null);
  };

  const setCurrentText = (value: string) => {
    if (creating) setCreateText(value);
    else setText(value);
  };

  return (
    <TemplatesPanelView
      entries={entries}
      visible={visible}
      filter={templates.filter}
      search={templates.search}
      selection={selection}
      detail={detail}
      creating={creating}
      draftName={draftName}
      text={currentText}
      loaded={loaded}
      tab={tab}
      liveIssues={liveIssues}
      armedSave={armedSave}
      armedDelete={armedDelete}
      busy={templates.busy}
      onFilter={templates.setFilter}
      onSearch={templates.setSearch}
      onSelect={(next) => {
        setCreating(null);
        templates.select(next);
      }}
      onStartCreate={startCreate}
      onDraftName={setDraftName}
      onText={setCurrentText}
      onTab={setTab}
      onSave={onSave}
      onRevert={() => {
        setText(null);
        setLiveIssues(null);
        setArmedSave(false);
      }}
      onValidate={() => {
        if (!kind) return;
        const parsed = parseEditor(currentText);
        if (parsed.body === null) {
          toast({ title: parsed.parseError ?? L.ttHintParse, tone: 'failed' });
          return;
        }
        templates.validate({ kind, name: name || 'draft', body: parsed.body });
      }}
      onDelete={onDelete}
      onDuplicate={onDuplicate}
      onCancelCreate={() => setCreating(null)}
      onPluginDirtyChange={setPluginDirty}
      onPluginSaved={templates.invalidate}
      onFormat={() => {
        const parsed = parseEditor(currentText);
        if (parsed.body === null) {
          toast({ title: parsed.parseError ?? L.ttHintParse, tone: 'failed' });
          return;
        }
        setCurrentText(formatBody(parsed.body));
      }}
    />
  );
}
