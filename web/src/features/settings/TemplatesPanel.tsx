// input:  threadTemplates APIs, editor VM, shared settings primitives
// output: bounded master-detail editor with validation and write guards
// pos:    Settings view for thread-template configuration
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ThreadTemplateEntry,
  ThreadTemplateDetail,
  ThreadTemplateIssue,
} from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useToast } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { SButton, SCard, S_CONTROL_STYLE } from './settings-ui';
import {
  TEMPLATE_FILTER_KEYS,
  buildSaveArgs,
  countByFilter,
  deleteBlockedReason,
  filterEntries,
  forksFromDefaults,
  formatBody,
  isDirty,
  needsRunningConfirm,
  parseEditor,
  resolveSelection,
  saveGate,
  starterBody,
  validateName,
  type TemplateFilterKey,
  type TemplateKind,
  type TemplateSelection,
} from './templates-panel-vm';

const MONO = "'IBM Plex Mono',monospace";
const LIST_WIDTH = 232;

const KIND_STYLE: Record<TemplateKind, { bg: string; color: string }> = {
  template: { bg: 'var(--proto-accent-bg)', color: 'var(--proto-accent)' },
  agent: { bg: 'var(--proto-success-bg)', color: 'var(--proto-success)' },
  shell: { bg: 'var(--proto-amber-bg)', color: 'var(--proto-amber)' },
};

const FILTER_LABEL: Record<TemplateFilterKey, keyof Vocab> = {
  all: 'ttFilterAll',
  template: 'ttFilterTemplate',
  agent: 'ttFilterAgent',
  shell: 'ttFilterShell',
};

const ORIGIN_LABEL: Record<ThreadTemplateDetail['origin'], keyof Vocab> = {
  stock: 'ttOriginStock',
  modified: 'ttOriginModified',
  custom: 'ttOriginCustom',
};

const ORIGIN_TITLE: Record<ThreadTemplateDetail['origin'], keyof Vocab> = {
  stock: 'ttOriginStockTitle',
  modified: 'ttOriginModifiedTitle',
  custom: 'ttOriginCustomTitle',
};

type Tab = 'body' | 'validation' | 'references';

// ── small pieces ──────────────────────────────────────────────────────────────────────────────

function KindBadge({ kind }: { kind: TemplateKind }) {
  const s = KIND_STYLE[kind];
  return (
    <span
      data-kind={kind}
      style={{
        fontSize: 9,
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: 999,
        background: s.bg,
        color: s.color,
        flex: 'none',
        letterSpacing: '.02em',
      }}
    >
      {kind}
    </span>
  );
}

function OriginBadge({ origin }: { origin: ThreadTemplateDetail['origin'] }) {
  const L = useVocab();
  return (
    <span
      data-origin={origin}
      title={L[ORIGIN_TITLE[origin]]}
      style={{
        font: `500 9px ${MONO}`,
        padding: '1px 5px',
        borderRadius: 5,
        border: '1px solid var(--proto-line-2)',
        color: 'var(--proto-muted-3)',
        flex: 'none',
      }}
    >
      {L[ORIGIN_LABEL[origin]]}
    </span>
  );
}

function Banner({ tone, children }: { tone: 'danger' | 'warn'; children: ReactNode }) {
  const danger = tone === 'danger';
  return (
    <div
      data-banner={tone}
      style={{
        fontSize: 10.5,
        lineHeight: 1.6,
        padding: '7px 10px',
        borderRadius: 7,
        marginBottom: 8,
        color: danger ? 'var(--proto-danger)' : 'var(--proto-amber)',
        background: danger ? 'var(--proto-danger-bg)' : 'var(--proto-amber-bg)',
      }}
    >
      {children}
    </div>
  );
}

function IssueList({ issues, tone }: { issues: readonly ThreadTemplateIssue[]; tone: 'danger' | 'warn' }) {
  const color = tone === 'danger' ? 'var(--proto-danger)' : 'var(--proto-amber)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {issues.map((issue, i) => (
        <div key={`${issue.path}:${i}`} data-issue={tone} style={{ display: 'flex', gap: 8, fontSize: 10.5 }}>
          <span style={{ font: `600 9.5px ${MONO}`, color, flex: 'none', minWidth: 128, wordBreak: 'break-all' }}>
            {issue.path}
          </span>
          <span style={{ color: 'var(--proto-muted)', lineHeight: 1.6 }}>{issue.message}</span>
        </div>
      ))}
    </div>
  );
}

function RefRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '4px 0', fontSize: 10.5 }}>
      <span style={{ color: 'var(--proto-muted-3)', minWidth: 168, flex: 'none' }}>{k}</span>
      <span style={{ color: 'var(--proto-ink-2)', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}

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
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        borderRadius: 7,
        cursor: 'pointer',
        background: selected ? 'var(--proto-accent-bg)' : 'transparent',
      }}
    >
      <KindBadge kind={entry.kind} />
      <span
        style={{
          font: `600 10.5px ${MONO}`,
          color: selected ? 'var(--proto-accent)' : 'var(--proto-ink-2)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.name}
      </span>
      {!entry.valid ? (
        <span
          data-invalid=""
          title={`${entry.errorCount}`}
          style={{
            marginLeft: 'auto',
            font: `600 9px ${MONO}`,
            color: 'var(--proto-danger)',
            flex: 'none',
          }}
        >
          {L.ttInvalidBadge}
        </span>
      ) : null}
    </div>
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
  const counts = countByFilter(entries, search);
  return (
    <SCard
      style={{ width: LIST_WIDTH, flex: 'none', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <div style={{ padding: '9px 10px 7px', borderBottom: '1px solid var(--proto-line-2)', flex: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ fontSize: 11.5, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.ttEditorTitle}</span>
          <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-faint)' }}>{entries.length}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {TEMPLATE_FILTER_KEYS.map((key) => {
            const active = key === filter;
            return (
              <span
                key={key}
                role="button"
                data-template-filter={key}
                data-active={active ? '' : undefined}
                onClick={() => onFilter(key)}
                style={{
                  font: `500 9.5px ${MONO}`,
                  padding: '2px 7px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: active ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
                  background: active ? 'var(--proto-accent-bg)' : 'transparent',
                  border: `1px solid ${active ? 'var(--proto-accent-border)' : 'var(--proto-line-2)'}`,
                }}
              >
                {L[FILTER_LABEL[key]]}
                <span style={{ color: 'var(--proto-faint)', marginLeft: 4 }}>{counts[key]}</span>
              </span>
            );
          })}
        </div>
        <input
          data-template-search=""
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={L.ttSearchPh}
          style={{ ...S_CONTROL_STYLE, marginTop: 7, padding: '4px 8px' }}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 6px' }}>
        {visible.length === 0 ? (
          <div data-templates-empty="" style={{ padding: '14px 8px', fontSize: 10.5, color: 'var(--proto-faint)' }}>
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

      <div
        style={{
          flex: 'none',
          borderTop: '1px solid var(--proto-line-2)',
          padding: '8px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--proto-muted-3)', flex: 'none' }}>
          + {L.ttNew}
        </span>
        {(['template', 'agent', 'shell'] as const).map((kind) => (
          <span
            key={kind}
            role="button"
            data-create-kind={kind}
            onClick={() => onStartCreate(kind)}
            style={{ font: `500 9.5px ${MONO}`, color: 'var(--proto-accent)', cursor: 'pointer' }}
          >
            {kind}
          </span>
        ))}
      </div>
    </SCard>
  );
}

// ── detail pane ───────────────────────────────────────────────────────────────────────────────

export interface TemplateDetailPaneProps {
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
}

export function TemplateDetailPane(props: TemplateDetailPaneProps) {
  const L = useVocab();
  const { detail, creating, text, loaded } = props;
  const kind = creating?.kind ?? detail?.kind ?? null;
  const name = creating ? props.draftName : (detail?.name ?? '');

  if (!kind) {
    return (
      <SCard
        style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <span data-template-detail-empty="" style={{ fontSize: 11, color: 'var(--proto-faint)' }}>
          {L.ttSelectPrompt}
        </span>
      </SCard>
    );
  }

  const gate = saveGate({ text, loaded, name, creating: creating !== null });
  const nameError = creating ? validateName(props.draftName) : null;
  // Live validation (from the Validate button) wins; otherwise show what the server said on load.
  const issues = props.liveIssues ?? { errors: detail?.errors ?? [], warnings: detail?.warnings ?? [] };
  const parseError = parseEditor(text).parseError;
  const dirty = isDirty(text, loaded);
  const deleteBlocked = deleteBlockedReason(detail);
  const showRunningWarn = !creating && needsRunningConfirm(detail);
  const showForkWarn = !creating && dirty && forksFromDefaults(detail);

  const hint =
    gate.reason === 'parse' ? L.ttHintParse : gate.reason === 'name' ? L.ttHintName : gate.reason === 'clean' ? L.ttHintClean : null;

  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: 'body', label: L.ttTabBody },
    { key: 'validation', label: L.ttTabValidation, badge: issues.errors.length + issues.warnings.length },
    { key: 'references', label: L.ttTabReferences },
  ];

  return (
    <SCard
      data-template-detail={`${kind}:${name}`}
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <div style={{ padding: '10px 14px 0', flex: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <KindBadge kind={kind} />
          {creating ? (
            <input
              data-template-name=""
              value={props.draftName}
              onChange={(e) => props.onDraftName(e.target.value)}
              placeholder={L.ttNamePh}
              style={{ ...S_CONTROL_STYLE, width: 220, padding: '4px 8px' }}
            />
          ) : (
            <span style={{ font: `650 12px ${MONO}`, color: 'var(--proto-ink)' }}>{name}</span>
          )}
          {detail && !creating ? <OriginBadge origin={detail.origin} /> : null}
          {dirty ? (
            <span data-dirty="" style={{ font: `500 9px ${MONO}`, color: 'var(--proto-amber)' }}>
              ●
            </span>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--proto-line-2)' }}>
          {tabs.map((tab) => {
            const active = tab.key === props.tab;
            return (
              <span
                key={tab.key}
                role="button"
                data-template-tab={tab.key}
                data-active={active ? '' : undefined}
                onClick={() => props.onTab(tab.key)}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '5px 10px',
                  cursor: 'pointer',
                  color: active ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
                  borderBottom: `2px solid ${active ? 'var(--proto-accent)' : 'transparent'}`,
                  marginBottom: -1,
                }}
              >
                {tab.label}
                {tab.badge ? <span style={{ marginLeft: 5, color: 'var(--proto-faint)' }}>{tab.badge}</span> : null}
              </span>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 14px' }}>
        {nameError && creating ? <Banner tone="danger">{nameError}</Banner> : null}
        {showRunningWarn ? (
          <Banner tone="warn">
            {detail?.runningThreads} {L.ttRunningWarn}
          </Banner>
        ) : null}
        {showForkWarn ? <Banner tone="warn">{L.ttForkWarn}</Banner> : null}

        {props.tab === 'body' ? (
          <>
            {parseError ? <Banner tone="danger">{parseError}</Banner> : null}
            <textarea
              data-template-body=""
              value={text}
              spellCheck={false}
              onChange={(e) => props.onText(e.target.value)}
              onKeyDown={(e) => {
                // Tab indents instead of leaving the field — this is a code editor, however plain.
                if (e.key !== 'Tab') return;
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart: start, selectionEnd: end, value } = el;
                props.onText(`${value.slice(0, start)}  ${value.slice(end)}`);
                requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
              }}
              style={{
                ...S_CONTROL_STYLE,
                minHeight: 320,
                height: '100%',
                resize: 'vertical',
                lineHeight: 1.65,
                whiteSpace: 'pre',
                overflowWrap: 'normal',
                overflowX: 'auto',
              }}
            />
          </>
        ) : null}

        {props.tab === 'validation' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <SectionLabel>{L.ttErrors}</SectionLabel>
              {issues.errors.length === 0 ? (
                <Muted>{L.ttNoErrors}</Muted>
              ) : (
                <IssueList issues={issues.errors} tone="danger" />
              )}
            </div>
            <div>
              <SectionLabel>{L.ttWarnings}</SectionLabel>
              {issues.warnings.length === 0 ? (
                <Muted>{L.ttNoWarnings}</Muted>
              ) : (
                <IssueList issues={issues.warnings} tone="warn" />
              )}
            </div>
            <Muted>{L.ttErrorsBlock}</Muted>
          </div>
        ) : null}

        {props.tab === 'references' ? (
          <div>
            {detail ? (
              <>
                <RefRow k={L.ttFilePath} v={<span style={{ font: `400 10px ${MONO}` }}>{detail.filePath}</span>} />
                <RefRow
                  k={L.ttUsedBy}
                  v={detail.usedByTemplates.length > 0 ? detail.usedByTemplates.join(', ') : L.ttUsedByNone}
                />
                <RefRow k={L.ttRunningThreads} v={detail.runningThreads} />
                <RefRow k={L.ttReferencingTasks} v={detail.referencingTasks} />
                {detail.expanded ? (
                  <div style={{ marginTop: 12 }}>
                    <SectionLabel>{L.ttExpanded}</SectionLabel>
                    <Muted>{L.ttExpandedNote}</Muted>
                    <pre
                      data-template-expanded=""
                      style={{
                        font: `400 10px ${MONO}`,
                        color: 'var(--proto-muted)',
                        background: 'var(--proto-alt)',
                        border: '1px solid var(--proto-line-2)',
                        borderRadius: 7,
                        padding: 10,
                        marginTop: 6,
                        overflow: 'auto',
                      }}
                    >
                      {formatBody(detail.expanded)}
                    </pre>
                  </div>
                ) : null}
              </>
            ) : (
              <Muted>{L.ttSelectPrompt}</Muted>
            )}
          </div>
        ) : null}
      </div>

      <div
        style={{
          flex: 'none',
          borderTop: '1px solid var(--proto-line-2)',
          padding: '9px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <SButton
          tone="accent"
          disabled={!gate.canSave || props.busy}
          onClick={props.onSave}
          data-action="save"
        >
          {props.armedSave ? L.ttSaveConfirm : L.ttSave}
        </SButton>
        <SButton tone="neutral" disabled={props.busy} onClick={props.onValidate} data-action="validate">
          {L.ttValidate}
        </SButton>
        <SButton tone="neutral" disabled={!dirty || props.busy} onClick={props.onRevert} data-action="revert">
          {L.ttRevert}
        </SButton>
        <SButton tone="neutral" disabled={props.busy} onClick={props.onFormat} data-action="format">
          {L.ttFormat}
        </SButton>
        {creating ? (
          <SButton tone="neutral" onClick={props.onCancelCreate} data-action="cancel-create">
            {L.ttCancel}
          </SButton>
        ) : (
          <>
            <SButton tone="neutral" disabled={props.busy} onClick={props.onDuplicate} data-action="duplicate">
              {L.ttDuplicate}
            </SButton>
            <SButton
              tone="danger"
              disabled={deleteBlocked !== null || props.busy}
              onClick={props.onDelete}
              data-action="delete"
              title={
                deleteBlocked === 'dependents'
                  ? L.ttDeleteBlockedDependents
                  : deleteBlocked === 'running'
                    ? L.ttDeleteBlockedRunning
                    : undefined
              }
            >
              {props.armedDelete ? L.ttDeleteConfirm : L.ttDelete}
            </SButton>
          </>
        )}
        {hint ? (
          <span data-save-hint="" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--proto-faint)' }}>
            {hint}
          </span>
        ) : null}
      </div>
    </SCard>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: '.06em',
        color: 'var(--proto-muted-3)',
        textTransform: 'uppercase',
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function Muted({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ fontSize: 10.5, color: 'var(--proto-faint)', lineHeight: 1.6, ...style }}>{children}</div>;
}

// ── container ─────────────────────────────────────────────────────────────────────────────────

export function TemplatesPanel() {
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
  }, [selection?.kind, selection?.name, creating?.kind]);

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
    <div
      data-settings-panel="templates"
      style={{ marginTop: 12, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0, alignItems: 'stretch' }}>
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
      <div style={{ flex: 'none', paddingTop: 8, fontSize: 10, color: 'var(--proto-faint)', lineHeight: 1.6 }}>
        {L.ttFootNote}
      </div>
    </div>
  );
}
