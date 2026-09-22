// input:  react, the settings kit, the templates view-model
// output: the templates editor's right column — identity, tabs, body, validation, references
// pos:    Detail half of the templates master–detail panel; the list half stays in TemplatesPanel

import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import type { ThreadTemplateDetail, ThreadTemplateIssue } from '@cortex-agent/ui-contract';
import { useVocab, type Vocab } from '@/i18n';
import {
  SButton,
  SCount,
  SDot,
  SNotice,
  SPill,
  SSectionLabel,
  SSegmented,
  S_CONTROL_STYLE,
  type SPillTone,
} from './settings-ui';
import {
  DETAIL_PANE_STYLE,
  NoticeStack,
  PANE_BODY_STYLE,
  PANE_HEADER_STYLE,
  PaneFooter,
} from './master-detail-ui';
import { PluginAssignPanel } from './PluginAssignPanel';
import {
  deleteBlockedReason,
  forksFromDefaults,
  formatBody,
  isDirty,
  needsRunningConfirm,
  parseEditor,
  saveGate,
  validateName,
  type TemplateKind,
  type TemplateSelection,
} from './templates-panel-vm';

const MONO = "'IBM Plex Mono',monospace";

export type Tab = 'body' | 'validation' | 'references' | 'plugins';

const KIND_TONE: Record<TemplateKind, SPillTone> = {
  template: 'accent',
  agent: 'success',
  shell: 'amber',
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

/** Plugin assignment is a field of an agent or a template slot, so it is edited here, on the
 *  entity that owns it. Shells have no pluginDirs, and a not-yet-created entity has no file to
 *  assign against. */
export function showsPluginTab(kind: TemplateKind | null, creating: boolean): boolean {
  return !creating && (kind === 'agent' || kind === 'template');
}

// ── small pieces ──────────────────────────────────────────────────────────────────────────────

/** The list row leads with this too, which is why it is exported from the pane that defines it. */
export function KindBadge({ kind }: { kind: TemplateKind }) {
  return <SPill data-kind={kind} tone={KIND_TONE[kind]}>{kind}</SPill>;
}

function OriginBadge({ origin }: { origin: ThreadTemplateDetail['origin'] }) {
  const L = useVocab();
  return (
    <SPill data-origin={origin} title={L[ORIGIN_TITLE[origin]]} tone="neutral">
      {L[ORIGIN_LABEL[origin]]}
    </SPill>
  );
}

function IssueList({ issues, tone }: { issues: readonly ThreadTemplateIssue[]; tone: 'danger' | 'warn' }) {
  const color = tone === 'danger' ? 'var(--proto-danger)' : 'var(--proto-amber-fg)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {issues.map((issue, i) => (
        <div key={`${issue.path}:${i}`} data-issue={tone} style={{ display: 'flex', gap: 10, fontSize: 11.5 }}>
          <span style={{ font: `600 10.5px ${MONO}`, color, flex: 'none', minWidth: 140, wordBreak: 'break-all' }}>
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
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '5px 0', fontSize: 11.5 }}>
      <span style={{ color: 'var(--proto-muted-3)', minWidth: 168, flex: 'none' }}>{k}</span>
      <span style={{ color: 'var(--proto-ink-2)', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}

function Muted({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ fontSize: 11.5, color: 'var(--proto-muted-2)', lineHeight: 1.6, ...style }}>{children}</div>;
}

// Code, so it stays opaque: `--proto-card` keeps the mesh from showing through a monospace block.
const CODE_BLOCK_STYLE: CSSProperties = {
  font: `400 10.5px/1.7 ${MONO}`,
  color: 'var(--proto-muted)',
  background: 'var(--proto-card)',
  boxShadow: '0 0 0 1px var(--proto-line-2)',
  borderRadius: 'var(--r-control)',
  padding: 12,
  marginTop: 8,
  overflow: 'auto',
};

const EDITOR_STYLE: CSSProperties = {
  ...S_CONTROL_STYLE,
  minHeight: 320,
  height: '100%',
  resize: 'vertical',
  lineHeight: 1.65,
  whiteSpace: 'pre',
  overflowWrap: 'normal',
  overflowX: 'auto',
};

// ── header ────────────────────────────────────────────────────────────────────────────────────

function DetailIdentity(props: {
  kind: TemplateKind;
  name: string;
  creating: boolean;
  draftName: string;
  origin: ThreadTemplateDetail['origin'] | null;
  dirty: boolean;
  onDraftName: (value: string) => void;
}) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 11 }}>
      <KindBadge kind={props.kind} />
      {props.creating ? (
        <input
          data-template-name=""
          value={props.draftName}
          onChange={(e) => props.onDraftName(e.target.value)}
          placeholder={L.ttNamePh}
          style={{ ...S_CONTROL_STYLE, width: 220 }}
        />
      ) : (
        <span style={{ font: `650 13px ${MONO}`, color: 'var(--proto-ink)' }}>{props.name}</span>
      )}
      {props.origin !== null ? <OriginBadge origin={props.origin} /> : null}
      {props.dirty ? (
        <span data-dirty="" style={{ display: 'flex', flex: 'none' }}>
          <SDot color="var(--proto-amber)" size={7} />
        </span>
      ) : null}
    </div>
  );
}

function DetailTabs({ tabs, tab, onTab }: {
  tabs: { key: Tab; label: string; badge?: number }[];
  tab: Tab;
  onTab: (tab: Tab) => void;
}) {
  const options = tabs.map((entry) => ({
    id: entry.key,
    label: (
      <>
        {entry.label}
        {entry.badge ? <span style={{ marginLeft: 6 }}><SCount tone="amber">{entry.badge}</SCount></span> : null}
      </>
    ),
  }));
  // The track sizes to its options, so it needs a flex line of its own rather than a block.
  return (
    <div style={{ display: 'flex' }}>
      <SSegmented<Tab> value={tab} options={options} onChange={onTab} dataAttr="data-template-tab" />
    </div>
  );
}

// ── tab bodies ────────────────────────────────────────────────────────────────────────────────

function DetailNotices({ nameError, runningThreads, forkWarn }: {
  nameError: string | null;
  runningThreads: number | null;
  forkWarn: boolean;
}) {
  const L = useVocab();
  const notices = [
    nameError !== null
      ? <SNotice key="name" data-banner="danger" tone="danger">{nameError}</SNotice>
      : null,
    runningThreads !== null
      ? <SNotice key="running" data-banner="warn" tone="amber">{runningThreads} {L.ttRunningWarn}</SNotice>
      : null,
    forkWarn ? <SNotice key="fork" data-banner="warn" tone="amber">{L.ttForkWarn}</SNotice> : null,
  ].filter((notice) => notice !== null);
  if (notices.length === 0) return null;
  return <NoticeStack style={{ marginBottom: 14 }}>{notices}</NoticeStack>;
}

function BodyTab({ text, parseError, onText }: {
  text: string;
  parseError: string | null;
  onText: (value: string) => void;
}) {
  const indent = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab indents instead of leaving the field — this is a code editor, however plain.
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const el = event.currentTarget;
    const { selectionStart: start, selectionEnd: end, value } = el;
    onText(`${value.slice(0, start)}  ${value.slice(end)}`);
    requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
  };
  return (
    <>
      {parseError !== null ? (
        <NoticeStack style={{ marginBottom: 12 }}>
          <SNotice data-banner="danger" tone="danger">{parseError}</SNotice>
        </NoticeStack>
      ) : null}
      <textarea
        data-template-body=""
        value={text}
        spellCheck={false}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={indent}
        style={EDITOR_STYLE}
      />
    </>
  );
}

function ValidationTab({ issues }: {
  issues: { errors: ThreadTemplateIssue[]; warnings: ThreadTemplateIssue[] };
}) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div>
        <SSectionLabel>{L.ttErrors}</SSectionLabel>
        {issues.errors.length === 0 ? <Muted>{L.ttNoErrors}</Muted> : <IssueList issues={issues.errors} tone="danger" />}
      </div>
      <div>
        <SSectionLabel>{L.ttWarnings}</SSectionLabel>
        {issues.warnings.length === 0 ? <Muted>{L.ttNoWarnings}</Muted> : <IssueList issues={issues.warnings} tone="warn" />}
      </div>
      <Muted style={{ marginTop: 10 }}>{L.ttErrorsBlock}</Muted>
    </div>
  );
}

function ReferencesTab({ detail }: { detail: ThreadTemplateDetail | null }) {
  const L = useVocab();
  if (!detail) return <Muted>{L.ttSelectPrompt}</Muted>;
  return (
    <div>
      <RefRow k={L.ttFilePath} v={<span style={{ font: `400 10.5px ${MONO}` }}>{detail.filePath}</span>} />
      <RefRow k={L.ttUsedBy} v={detail.usedByTemplates.length > 0 ? detail.usedByTemplates.join(', ') : L.ttUsedByNone} />
      <RefRow k={L.ttRunningThreads} v={detail.runningThreads} />
      <RefRow k={L.ttReferencingTasks} v={detail.referencingTasks} />
      {detail.expanded ? (
        <div style={{ marginTop: 6 }}>
          <SSectionLabel>{L.ttExpanded}</SSectionLabel>
          <Muted>{L.ttExpandedNote}</Muted>
          <pre data-template-expanded="" style={CODE_BLOCK_STYLE}>{formatBody(detail.expanded)}</pre>
        </div>
      ) : null}
    </div>
  );
}

// ── footer ────────────────────────────────────────────────────────────────────────────────────

function deleteBlockedTitle(reason: 'dependents' | 'running' | null, L: Vocab): string | undefined {
  if (reason === 'dependents') return L.ttDeleteBlockedDependents;
  if (reason === 'running') return L.ttDeleteBlockedRunning;
  return undefined;
}

function EntityActions(props: TemplateDetailPaneProps & { deleteBlocked: 'dependents' | 'running' | null }) {
  const L = useVocab();
  if (props.creating) {
    return (
      <SButton tone="neutral" onClick={props.onCancelCreate} data-action="cancel-create">{L.ttCancel}</SButton>
    );
  }
  return (
    <>
      <SButton tone="neutral" disabled={props.busy} onClick={props.onDuplicate} data-action="duplicate">
        {L.ttDuplicate}
      </SButton>
      <SButton
        tone="danger"
        disabled={props.deleteBlocked !== null || props.busy}
        onClick={props.onDelete}
        data-action="delete"
        title={deleteBlockedTitle(props.deleteBlocked, L)}
      >
        {props.armedDelete ? L.ttDeleteConfirm : L.ttDelete}
      </SButton>
    </>
  );
}

function DetailFooter(props: TemplateDetailPaneProps & {
  canSave: boolean;
  dirty: boolean;
  deleteBlocked: 'dependents' | 'running' | null;
  hint: string | null;
}) {
  const L = useVocab();
  return (
    <PaneFooter hint={props.hint !== null ? <span data-save-hint="">{props.hint}</span> : null}>
      <SButton tone="accent" disabled={!props.canSave || props.busy} onClick={props.onSave} data-action="save">
        {props.armedSave ? L.ttSaveConfirm : L.ttSave}
      </SButton>
      <SButton tone="neutral" disabled={props.busy} onClick={props.onValidate} data-action="validate">
        {L.ttValidate}
      </SButton>
      <SButton tone="neutral" disabled={!props.dirty || props.busy} onClick={props.onRevert} data-action="revert">
        {L.ttRevert}
      </SButton>
      <SButton tone="neutral" disabled={props.busy} onClick={props.onFormat} data-action="format">
        {L.ttFormat}
      </SButton>
      <EntityActions {...props} />
    </PaneFooter>
  );
}

// ── the pane ──────────────────────────────────────────────────────────────────────────────────

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
  onPluginDirtyChange?: (dirty: boolean) => void;
  onPluginSaved?: () => void;
}

function tabsFor(L: Vocab, kind: TemplateKind, creating: boolean, issueCount: number) {
  return [
    { key: 'body' as Tab, label: L.ttTabBody },
    { key: 'validation' as Tab, label: L.ttTabValidation, badge: issueCount },
    { key: 'references' as Tab, label: L.ttTabReferences },
    ...(showsPluginTab(kind, creating) ? [{ key: 'plugins' as Tab, label: L.ttTabPlugins }] : []),
  ];
}

function EmptyDetail() {
  const L = useVocab();
  return (
    <div style={{ ...DETAIL_PANE_STYLE, alignItems: 'center', justifyContent: 'center' }}>
      <span data-template-detail-empty="" style={{ fontSize: 12, color: 'var(--proto-muted-3)' }}>
        {L.ttSelectPrompt}
      </span>
    </div>
  );
}

function DetailBody(props: TemplateDetailPaneProps & {
  kind: TemplateKind;
  name: string;
  dirty: boolean;
  issues: { errors: ThreadTemplateIssue[]; warnings: ThreadTemplateIssue[] };
}) {
  const creating = props.creating !== null;
  return (
    <div style={PANE_BODY_STYLE}>
      <DetailNotices
        nameError={creating ? validateName(props.draftName) : null}
        runningThreads={!creating && needsRunningConfirm(props.detail) ? props.detail?.runningThreads ?? 0 : null}
        forkWarn={!creating && props.dirty && forksFromDefaults(props.detail)}
      />
      {props.tab === 'body' ? (
        <BodyTab text={props.text} parseError={parseEditor(props.text).parseError} onText={props.onText} />
      ) : null}
      {props.tab === 'validation' ? <ValidationTab issues={props.issues} /> : null}
      {props.tab === 'plugins' && showsPluginTab(props.kind, creating) ? (
        <PluginAssignPanel
          scope={{ kind: props.kind as 'agent' | 'template', name: props.name }}
          locked={props.dirty}
          onDirtyChange={props.onPluginDirtyChange}
          onSaved={props.onPluginSaved}
        />
      ) : null}
      {props.tab === 'references' ? <ReferencesTab detail={props.detail} /> : null}
    </div>
  );
}

function saveHint(reason: string | null, L: Vocab): string | null {
  if (reason === 'parse') return L.ttHintParse;
  if (reason === 'name') return L.ttHintName;
  if (reason === 'clean') return L.ttHintClean;
  return null;
}

export function TemplateDetailPane(props: TemplateDetailPaneProps) {
  const L = useVocab();
  const { detail, creating, text, loaded } = props;
  const kind = creating?.kind ?? detail?.kind ?? null;
  const name = creating ? props.draftName : (detail?.name ?? '');
  if (!kind) return <EmptyDetail />;

  const gate = saveGate({ text, loaded, name, creating: creating !== null });
  // Live validation (from the Validate button) wins; otherwise show what the server said on load.
  const issues = props.liveIssues ?? { errors: detail?.errors ?? [], warnings: detail?.warnings ?? [] };
  const dirty = isDirty(text, loaded);
  const tabs = tabsFor(L, kind, creating !== null, issues.errors.length + issues.warnings.length);

  return (
    <div data-template-detail={`${kind}:${name}`} style={DETAIL_PANE_STYLE}>
      <div style={PANE_HEADER_STYLE}>
        <DetailIdentity
          kind={kind} name={name} creating={creating !== null} draftName={props.draftName}
          origin={detail && !creating ? detail.origin : null} dirty={dirty} onDraftName={props.onDraftName}
        />
        <DetailTabs tabs={tabs} tab={props.tab} onTab={props.onTab} />
      </div>
      <DetailBody {...props} kind={kind} name={name} dirty={dirty} issues={issues} />
      <DetailFooter
        {...props} canSave={gate.canSave} dirty={dirty}
        deleteBlocked={deleteBlockedReason(detail)} hint={saveHint(gate.reason, L)}
      />
    </div>
  );
}
