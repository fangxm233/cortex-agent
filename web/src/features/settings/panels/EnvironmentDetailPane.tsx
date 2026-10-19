import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import type { EnvironmentDetail, EnvironmentIssue } from '@cortex-agent/ui-contract';
import { useVocab, type Vocab } from '@/i18n';
import {
  SButton,
  SCount,
  SDot,
  SMeta,
  SNotice,
  SSectionLabel,
  SSegmented,
  S_CONTROL_STYLE,
} from '@/features/settings/ui/settings-ui';
import {
  DETAIL_PANE_STYLE,
  NoticeStack,
  PANE_BODY_STYLE,
  PANE_HEADER_STYLE,
  PaneFooter,
} from '@/features/settings/ui/master-detail-ui';
import { PluginAssignPanel } from './PluginAssignPanel';
import { EnvironmentPromptPanel } from './EnvironmentPromptPanel';
import {
  canDelete,
  forksFromDefaults,
  isDirty,
  parseEditor,
  saveGate,
  validateName,
} from '@/features/settings/vm/environments-panel-vm';

const MONO = "'IBM Plex Mono',monospace";

export type Tab = 'body' | 'prompt' | 'validation' | 'plugins';

const ORIGIN_LABEL: Record<EnvironmentDetail['origin'], keyof Vocab> = {
  stock: 'ttOriginStock',
  modified: 'ttOriginModified',
  custom: 'ttOriginCustom',
};

const ORIGIN_TITLE: Record<EnvironmentDetail['origin'], keyof Vocab> = {
  stock: 'ttOriginStockTitle',
  modified: 'ttOriginModifiedTitle',
  custom: 'ttOriginCustomTitle',
};

/** Plugin assignment is a field of the environment file, so a not-yet-created environment has
 *  nothing to assign against. */
export function showsPluginTab(creating: boolean): boolean {
  return !creating;
}

/** Same rule, plus a server old enough not to report the prompt has no tab to offer. */
export function showsPromptTab(creating: boolean, detail: EnvironmentDetail | null): boolean {
  return !creating && !!detail?.systemPrompt;
}

// ── small pieces ──────────────────────────────────────────────────────────────────────────────

function OriginBadge({ origin }: { origin: EnvironmentDetail['origin'] }) {
  const L = useVocab();
  return (
    <SMeta data-origin={origin} title={L[ORIGIN_TITLE[origin]]}>
      {L[ORIGIN_LABEL[origin]]}
    </SMeta>
  );
}

function IssueList({ issues, tone }: { issues: readonly EnvironmentIssue[]; tone: 'danger' | 'warn' }) {
  const color = tone === 'danger' ? 'var(--proto-danger)' : 'var(--proto-amber-fg)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {issues.map((issue, i) => (
        <div key={`${issue.path}:${i}`} data-issue={tone} className="settings-environment-issue">
          <span style={{ font: `600 12px ${MONO}`, color, minWidth: 0, overflowWrap: 'anywhere' }}>
            {issue.path}
          </span>
          <span style={{ color: 'var(--proto-muted)', lineHeight: 1.6 }}>{issue.message}</span>
        </div>
      ))}
    </div>
  );
}

function Muted({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ fontSize: 12, color: 'var(--proto-muted-2)', lineHeight: 1.6, overflowWrap: 'anywhere', ...style }}>{children}</div>;
}

const EDITOR_STYLE: CSSProperties = {
  ...S_CONTROL_STYLE,
  // Source text needs a sealed reading surface, unlike the unboxed pane around it.
  background: 'var(--proto-card)',
  fontFamily: MONO,
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
  name: string;
  creating: boolean;
  draftName: string;
  origin: EnvironmentDetail['origin'] | null;
  dirty: boolean;
  onDraftName: (value: string) => void;
}) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      {props.creating ? (
        <input
          data-environment-name=""
          value={props.draftName}
          onChange={(e) => props.onDraftName(e.target.value)}
          placeholder={L.ttNamePh}
          style={{ ...S_CONTROL_STYLE, width: 220, maxWidth: '100%' }}
        />
      ) : (
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)', minWidth: 0, overflowWrap: 'anywhere' }}>{props.name}</span>
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
      <SSegmented<Tab> value={tab} options={options} onChange={onTab} dataAttr="data-environment-tab" />
    </div>
  );
}

// ── tab bodies ────────────────────────────────────────────────────────────────────────────────

function DetailNotices({ nameError, forkWarn }: { nameError: string | null; forkWarn: boolean }) {
  const L = useVocab();
  const notices = [
    nameError !== null
      ? <SNotice key="name" data-banner="danger" tone="danger">{nameError}</SNotice>
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
        data-environment-body=""
        value={text}
        spellCheck={false}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={indent}
        style={EDITOR_STYLE}
      />
    </>
  );
}

function ValidationTab({ issues }: { issues: { errors: EnvironmentIssue[]; warnings: EnvironmentIssue[] } }) {
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

// ── footer ────────────────────────────────────────────────────────────────────────────────────

function EntityActions(props: EnvironmentDetailPaneProps & { name: string }) {
  const L = useVocab();
  if (props.creating) {
    return (
      <SButton tone="neutral" onClick={props.onCancelCreate} data-action="cancel-create">{L.ttCancel}</SButton>
    );
  }
  const deletable = canDelete(props.name);
  return (
    <>
      <SButton tone="neutral" disabled={props.busy} onClick={props.onDuplicate} data-action="duplicate">
        {L.ttDuplicate}
      </SButton>
      <SButton
        tone="danger"
        disabled={!deletable || props.busy}
        onClick={props.onDelete}
        data-action="delete"
        title={deletable ? undefined : L.ttDeleteBlockedDefault}
      >
        {props.armedDelete ? L.ttDeleteConfirm : L.ttDelete}
      </SButton>
    </>
  );
}

function DetailFooter(props: EnvironmentDetailPaneProps & {
  name: string;
  canSave: boolean;
  dirty: boolean;
  hint: string | null;
}) {
  const L = useVocab();
  return (
    <PaneFooter hint={props.hint !== null ? <span data-save-hint="">{props.hint}</span> : null}>
      <SButton tone="primary" disabled={!props.canSave || props.busy} onClick={props.onSave} data-action="save">
        {L.ttSave}
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

export interface EnvironmentDetailPaneProps {
  detail: EnvironmentDetail | null;
  creating: boolean;
  draftName: string;
  text: string;
  loaded: string;
  tab: Tab;
  liveIssues: { errors: EnvironmentIssue[]; warnings: EnvironmentIssue[] } | null;
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
  promptDraft: string | null;
  onPromptDraft: (value: string | null) => void;
}

function tabsFor(L: Vocab, creating: boolean, detail: EnvironmentDetail | null, issueCount: number) {
  return [
    { key: 'body' as Tab, label: L.ttTabBody },
    ...(showsPromptTab(creating, detail) ? [{ key: 'prompt' as Tab, label: L.ttTabPrompt }] : []),
    { key: 'validation' as Tab, label: L.ttTabValidation, badge: issueCount },
    ...(showsPluginTab(creating) ? [{ key: 'plugins' as Tab, label: L.ttTabPlugins }] : []),
  ];
}

function EmptyDetail() {
  const L = useVocab();
  return (
    <div className="settings-detail-pane" style={{ ...DETAIL_PANE_STYLE, alignItems: 'center', justifyContent: 'center' }}>
      <span data-environment-detail-empty="" style={{ fontSize: 12, color: 'var(--proto-muted-3)' }}>
        {L.ttSelectPrompt}
      </span>
    </div>
  );
}

function PromptTab(props: EnvironmentDetailPaneProps & { name: string; dirty: boolean }) {
  const prompt = showsPromptTab(props.creating, props.detail) ? props.detail?.systemPrompt : null;
  if (!prompt) return null;
  return (
    <EnvironmentPromptPanel
      name={props.name} prompt={prompt} draft={props.promptDraft} bodyDirty={props.dirty}
      onDraft={props.onPromptDraft} onSaved={props.onPluginSaved}
    />
  );
}

function DetailBody(props: EnvironmentDetailPaneProps & {
  name: string;
  dirty: boolean;
  issues: { errors: EnvironmentIssue[]; warnings: EnvironmentIssue[] };
}) {
  const L = useVocab();
  return (
    <div className="settings-detail-fields" style={PANE_BODY_STYLE}>
      <DetailNotices
        nameError={props.creating ? validateName(props.draftName, L) : null}
        forkWarn={!props.creating && props.dirty && forksFromDefaults(props.detail)}
      />
      {props.tab === 'body' ? (
        <BodyTab text={props.text} parseError={parseEditor(props.text, L).parseError} onText={props.onText} />
      ) : null}
      {props.tab === 'prompt' ? <PromptTab {...props} /> : null}
      {props.tab === 'validation' ? <ValidationTab issues={props.issues} /> : null}
      {props.tab === 'plugins' && showsPluginTab(props.creating) ? (
        <PluginAssignPanel
          scope={{ name: props.name }}
          locked={props.dirty}
          onDirtyChange={props.onPluginDirtyChange}
          onSaved={props.onPluginSaved}
        />
      ) : null}
    </div>
  );
}

function saveHint(reason: string | null, L: Vocab): string | null {
  if (reason === 'parse') return L.ttHintParse;
  if (reason === 'name') return L.ttHintName;
  if (reason === 'clean') return L.ttHintClean;
  return null;
}

export function EnvironmentDetailPane(props: EnvironmentDetailPaneProps) {
  const L = useVocab();
  const { detail, creating, text, loaded } = props;
  if (!creating && !detail) return <EmptyDetail />;
  const name = creating ? props.draftName : (detail?.name ?? '');

  const gate = saveGate({ text, loaded, name, creating });
  // Live validation (from the Validate button) wins; otherwise show what the server said on load.
  const issues = props.liveIssues ?? { errors: detail?.errors ?? [], warnings: detail?.warnings ?? [] };
  const dirty = isDirty(text, loaded);
  const tabs = tabsFor(L, creating, detail, issues.errors.length + issues.warnings.length);

  return (
    <div className="settings-detail-pane" data-environment-detail={name} style={DETAIL_PANE_STYLE}>
      <div style={PANE_HEADER_STYLE}>
        <DetailIdentity
          name={name} creating={creating} draftName={props.draftName}
          origin={detail && !creating ? detail.origin : null} dirty={dirty} onDraftName={props.onDraftName}
        />
        <DetailTabs tabs={tabs} tab={props.tab} onTab={props.onTab} />
      </div>
      <DetailBody {...props} name={name} dirty={dirty} issues={issues} />
      <DetailFooter {...props} name={name} canSave={gate.canSave} dirty={dirty} hint={saveHint(gate.reason, L)} />
    </div>
  );
}
