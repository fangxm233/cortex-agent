import '@/features/settings/ui/desktop-panels.css';
import { useEffect, useState } from 'react';
import type { EnvironmentDetail, EnvironmentEntry, EnvironmentIssue } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { SLinkAction, SStatus } from '@/features/settings/ui/settings-ui';
import { useEnvironmentsController } from '@/features/settings/controllers/useEnvironmentsController';
import {
  EDITOR_COLUMNS_STYLE,
  EDITOR_ROOT_STYLE,
  LIST_BODY_STYLE,
  LIST_EMPTY_STYLE,
  ListHeader,
  PaneFooter,
  listPaneStyle,
  listRowStyle,
} from '@/features/settings/ui/master-detail-ui';
import { EnvironmentDetailPane, type Tab } from './EnvironmentDetailPane';
import {
  buildSaveArgs,
  formatBody,
  parseEditor,
  starterBody,
} from '@/features/settings/vm/environments-panel-vm';

const LIST_WIDTH = 248;

type Issues = { errors: EnvironmentIssue[]; warnings: EnvironmentIssue[] };

// ── list ──────────────────────────────────────────────────────────────────────────────────────

function EnvironmentRow({
  entry,
  selected,
  onSelect,
}: {
  entry: EnvironmentEntry;
  selected: boolean;
  onSelect: (name: string) => void;
}) {
  const L = useVocab();
  return (
    <div
      data-environment-row={entry.name}
      data-selected={selected ? '' : undefined}
      role="button"
      onClick={() => onSelect(entry.name)}
      style={listRowStyle(selected)}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          fontWeight: selected ? 600 : 500,
          color: selected ? 'var(--proto-ink)' : 'var(--proto-ink-2)',
          overflowWrap: 'anywhere',
        }}
      >
        {entry.name}
      </span>
      {!entry.valid ? (
        <SStatus data-invalid="" title={`${entry.errorCount}`} tone="danger">
          {L.ttInvalidBadge}
        </SStatus>
      ) : null}
    </div>
  );
}

function EnvironmentList({
  entries,
  visible,
  search,
  selection,
  onSearch,
  onSelect,
  onStartCreate,
}: {
  entries: readonly EnvironmentEntry[];
  visible: readonly EnvironmentEntry[];
  search: string;
  selection: string | null;
  onSearch: (value: string) => void;
  onSelect: (name: string) => void;
  onStartCreate: () => void;
}) {
  const L = useVocab();
  return (
    <div className="settings-list-pane" style={listPaneStyle(LIST_WIDTH)}>
      <ListHeader
        title={L.ttEditorTitle} count={entries.length} searchAttr="data-environment-search"
        search={search} placeholder={L.ttSearchPh} onSearch={onSearch}
      />

      <div style={LIST_BODY_STYLE}>
        {visible.length === 0 ? (
          <div data-environments-empty="" style={LIST_EMPTY_STYLE}>
            {entries.length === 0 ? L.stNoEnvironments : L.ttNoMatch}
          </div>
        ) : (
          visible.map((entry) => (
            <EnvironmentRow
              key={entry.name}
              entry={entry}
              selected={selection === entry.name}
              onSelect={onSelect}
            />
          ))
        )}
      </div>

      <PaneFooter>
        <SLinkAction data-action="create" onClick={onStartCreate}>+ {L.ttNew}</SLinkAction>
      </PaneFooter>
    </div>
  );
}

// ── view ──────────────────────────────────────────────────────────────────────────────────────

export interface EnvironmentsPanelViewProps {
  entries: readonly EnvironmentEntry[];
  visible: readonly EnvironmentEntry[];
  search: string;
  selection: string | null;
  detail: EnvironmentDetail | null;
  creating: boolean;
  draftName: string;
  text: string;
  loaded: string;
  tab: Tab;
  liveIssues: Issues | null;
  armedDelete: boolean;
  busy: boolean;
  onSearch: (value: string) => void;
  onSelect: (name: string) => void;
  onStartCreate: () => void;
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
  promptDraft: string | null;
  onPromptDraft: (value: string | null) => void;
}

export function EnvironmentsPanelView(props: EnvironmentsPanelViewProps) {
  return (
    <div data-settings-panel="environments" style={EDITOR_ROOT_STYLE}>
      <div className="settings-editor-columns" style={EDITOR_COLUMNS_STYLE}>
        <EnvironmentList
          entries={props.entries}
          visible={props.visible}
          search={props.search}
          selection={props.selection}
          onSearch={props.onSearch}
          onSelect={props.onSelect}
          onStartCreate={props.onStartCreate}
        />
        <EnvironmentDetailPane
          detail={props.detail}
          creating={props.creating}
          draftName={props.draftName}
          text={props.text}
          loaded={props.loaded}
          tab={props.tab}
          liveIssues={props.liveIssues}
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
          promptDraft={props.promptDraft}
          onPromptDraft={props.onPromptDraft}
          onFormat={props.onFormat}
        />
      </div>
    </div>
  );
}

// ── container ─────────────────────────────────────────────────────────────────────────────────

export function EnvironmentsPanel({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const L = useVocab();
  const { toast } = useToast();

  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [tab, setTab] = useState<Tab>('body');
  /** Editor text. Null means "not touched" — the loaded body is the truth. */
  const [text, setText] = useState<string | null>(null);
  const [liveIssues, setLiveIssues] = useState<Issues | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const [createText, setCreateText] = useState('');
  const [pluginDirty, setPluginDirty] = useState(false);
  const [promptDraft, setPromptDraft] = useState<string | null>(null);

  const environments = useEnvironmentsController({
    creating,
    onValidated: (issues) => {
      setLiveIssues(issues);
      setTab('validation');
    },
    onSaved: () => {
      setText(null);
      setLiveIssues(null);
      if (creating) setCreating(false);
    },
    onRemoved: () => {
      setArmedDelete(false);
    },
  });
  const { entries, visible, selection, detail } = environments;

  const loaded = creating ? createText : detail?.body ? formatBody(detail.body) : '';
  const currentText = creating ? createText : (text ?? loaded);

  // Moving to another environment drops the working copy and every transient affordance with it.
  useEffect(() => {
    setText(null);
    setPromptDraft(null);
    setLiveIssues(null);
    setArmedDelete(false);
    // The plugins and prompt tabs do not exist while creating; fall back rather than blank out.
    setTab((current) => (current !== 'validation' && creating ? 'body' : current));
  }, [selection, creating]);

  // The assignment and prompt drafts block navigation: both are committed-on-save forms, whereas
  // the JSON buffer has always been free to abandon.
  const promptDirty = promptDraft !== null && promptDraft !== detail?.systemPrompt?.text;
  useEffect(() => { onDirtyChange?.(pluginDirty || promptDirty); }, [pluginDirty, promptDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const startCreate = (initialName: string, body: string) => {
    setCreating(true);
    setDraftName(initialName);
    setCreateText(body);
    setTab('body');
    setLiveIssues(null);
  };

  const name = creating ? draftName : (selection ?? '');
  const hasTarget = creating || selection !== null;

  const onSave = () => {
    if (!hasTarget) return;
    const args = buildSaveArgs({
      name,
      text: currentText,
      loaded,
      creating,
      baseHash: detail?.sha256 ?? null,
    });
    if (args) environments.save(args);
  };

  const onDelete = () => {
    if (!selection) return;
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }
    environments.remove(selection);
  };

  const setCurrentText = (value: string) => {
    if (creating) setCreateText(value);
    else setText(value);
  };

  const parsedOrToast = () => {
    const parsed = parseEditor(currentText, L);
    if (parsed.body === null) toast({ title: parsed.parseError ?? L.ttHintParse, tone: 'failed' });
    return parsed.body;
  };

  return (
    <EnvironmentsPanelView
      entries={entries}
      visible={visible}
      search={environments.search}
      selection={selection}
      detail={detail}
      creating={creating}
      draftName={draftName}
      text={currentText}
      loaded={loaded}
      tab={tab}
      liveIssues={liveIssues}
      armedDelete={armedDelete}
      busy={environments.busy}
      onSearch={environments.setSearch}
      onSelect={(next) => {
        setCreating(false);
        environments.select(next);
      }}
      onStartCreate={() => startCreate('', formatBody(starterBody()))}
      onDraftName={setDraftName}
      onText={setCurrentText}
      onTab={setTab}
      onSave={onSave}
      onRevert={() => {
        setText(null);
        setLiveIssues(null);
      }}
      onValidate={() => {
        if (!hasTarget) return;
        const body = parsedOrToast();
        if (body) environments.validate({ name: name || 'draft', body });
      }}
      onDelete={onDelete}
      onDuplicate={() => {
        if (hasTarget) startCreate(`${name}-copy`, currentText);
      }}
      onCancelCreate={() => setCreating(false)}
      onPluginDirtyChange={setPluginDirty}
      onPluginSaved={environments.invalidate}
      promptDraft={promptDraft}
      onPromptDraft={setPromptDraft}
      onFormat={() => {
        const body = parsedOrToast();
        if (body) setCurrentText(formatBody(body));
      }}
    />
  );
}
