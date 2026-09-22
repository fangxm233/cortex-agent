// input:  template queries, settings atoms, detail pane
// output: desktop template master-detail editor
// pos:    Template list and editor composition
// >>> Once updated, update this header and parent AGENTS.md <<<

import './desktop-panels.css';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ThreadTemplateEntry, ThreadTemplateIssue } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useToast } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { SChip, SLinkAction, SPill } from './settings-ui';
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
} from './master-detail-ui';
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
  filterEntries,
  formatBody,
  needsRunningConfirm,
  parseEditor,
  resolveSelection,
  starterBody,
  type TemplateFilterKey,
  type TemplateKind,
  type TemplateSelection,
} from './templates-panel-vm';

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

// ── container ─────────────────────────────────────────────────────────────────────────────────

export function TemplatesPanel({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const listQuery = useQuery(trpc.threadTemplates.get.queryOptions({}));
  const entries = useMemo(() => listQuery.data ?? [], [listQuery.data]);

  const [filter, setFilter] = useState<TemplateFilterKey>('all');
  const [search, setSearch] = useState('');
  const [requested, setRequested] = useState<TemplateSelection | null>(null);
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

  const visible = useMemo(() => filterEntries(entries, filter, search), [entries, filter, search]);
  const selection = creating ? null : resolveSelection(visible, requested);

  const detailQuery = useQuery({
    ...trpc.threadTemplates.detail.queryOptions(
      selection ?? { kind: 'template' as const, name: '' },
    ),
    enabled: selection !== null,
  });
  const detail = selection ? (detailQuery.data ?? null) : null;

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

  const invalidate = () => {
    queryClient.invalidateQueries(trpc.threadTemplates.get.queryFilter({}));
    if (selection) queryClient.invalidateQueries(trpc.threadTemplates.detail.queryFilter(selection));
  };
  const onWriteError = (error: { message: string; data?: unknown }) => {
    const conflict = /changed on disk/i.test(error.message);
    toast({ title: conflict ? L.ttToastConflict : `${L.ttToastWriteFailed}: ${error.message}`, tone: 'failed' });
  };

  const validate = useMutation(
    trpc.threadTemplates.validate.mutationOptions({
      onSuccess: (data) => {
        setLiveIssues({ errors: data.errors, warnings: data.warnings });
        setTab('validation');
        toast({ title: data.ok ? L.ttToastValid : L.ttToastInvalid, tone: data.ok ? 'done' : 'failed' });
      },
      onError: onWriteError,
    }),
  );

  const save = useMutation(
    trpc.threadTemplates.save.mutationOptions({
      onSuccess: (data, vars) => {
        invalidate();
        setText(null);
        setArmedSave(false);
        setLiveIssues(null);
        if (creating) {
          setCreating(null);
          setRequested({ kind: vars.kind, name: vars.name });
        }
        toast({ title: L.ttToastSaved, tone: 'done' });
        for (const warning of data.warnings) {
          toast({ title: `${warning.path}: ${warning.message}`, tone: 'waiting' });
        }
      },
      onError: onWriteError,
    }),
  );

  const remove = useMutation(
    trpc.threadTemplates.remove.mutationOptions({
      onSuccess: () => {
        invalidate();
        setRequested(null);
        setArmedDelete(false);
        toast({ title: L.ttToastDeleted, tone: 'done' });
      },
      onError: onWriteError,
    }),
  );

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
    if (args) save.mutate(args);
  };

  const onDelete = () => {
    if (!selection) return;
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }
    remove.mutate(selection);
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

  const busy = save.isPending || remove.isPending || validate.isPending;

  return (
    <div data-settings-panel="templates" style={EDITOR_ROOT_STYLE}>
      <div className="settings-editor-columns" style={EDITOR_COLUMNS_STYLE}>
        <TemplateList
          entries={entries}
          visible={visible}
          filter={filter}
          search={search}
          selection={selection}
          onFilter={setFilter}
          onSearch={setSearch}
          onSelect={(next) => {
            setCreating(null);
            setRequested(next);
          }}
          onStartCreate={startCreate}
        />
        <TemplateDetailPane
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
          busy={busy}
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
            validate.mutate({ kind, name: name || 'draft', body: parsed.body });
          }}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
          onCancelCreate={() => setCreating(null)}
          onPluginDirtyChange={setPluginDirty}
          onPluginSaved={invalidate}
          onFormat={() => {
            const parsed = parseEditor(currentText);
            if (parsed.body === null) {
              toast({ title: parsed.parseError ?? L.ttHintParse, tone: 'failed' });
              return;
            }
            setCurrentText(formatBody(parsed.body));
          }}
        />
      </div>
    </div>
  );
}
