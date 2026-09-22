// input:  hook view-model, settings atoms
// output: hook detail, test controls and stable log surfaces
// pos:    Responsive detail pane for desktop hooks
// >>> Once updated, update this header and parent AGENTS.md <<<

import type { CSSProperties, ReactNode } from 'react';
import type { HookDetail, HookScriptInfo, HooksTestReturn } from '@cortex-agent/ui-contract';
import { useVocab, type Vocab } from '@/i18n';
import {
  MonoKV,
  SButton,
  SLinkAction,
  SNotice,
  SPill,
  SSectionLabel,
  S_CONTROL_STYLE,
  Toggle,
  type SPillTone,
} from './settings-ui';
import {
  CONTROL_ERROR_STYLE,
  DETAIL_PANE_STYLE,
  NoticeStack,
  PANE_BODY_STYLE,
  PANE_HEADER_STYLE,
  PaneFooter,
} from './master-detail-ui';
import { HookEditor } from './HookEditorForm';
import {
  claudeAlternativeEvent,
  hasClaudeMountGap,
  hookCapability,
  hookEventOptions,
  isHookFormDirty,
  isHookFormValid,
  isPayloadParseable,
  matcherKindForEvent,
  samplePayloadForEvent,
  validateHookForm,
  type HookCapability,
  type HookFormState,
  type HookMountTarget,
} from './hooks-panel-vm';

const MONO = "'IBM Plex Mono',monospace";

const MOUNT_TONE: Record<HookMountTarget, SPillTone> = {
  claude: 'accent',
  pi: 'success',
  server: 'amber',
};

const FACTS_STYLE: CSSProperties = {
  font: `400 12px/1.7 ${MONO}`, color: 'var(--proto-muted)',
};

// ── small presentational atoms ────────────────────────────────────────────────────────────────

/** The list row carries mount targets too, which is why it is exported from the pane below. */
export function MountBadge({ target }: { target: HookMountTarget }) {
  return <SPill data-hook-mount={target} tone={MOUNT_TONE[target]}>{target}</SPill>;
}

function SourceBadge({ source }: { source: HookDetail['source'] }) {
  return <SPill data-hook-source={source} tone="neutral">{source}</SPill>;
}

function Mono({ children }: { children: ReactNode }) {
  return <span style={{ font: `500 12px ${MONO}`, color: 'var(--proto-ink-2)', overflowWrap: 'anywhere' }}>{children}</span>;
}

// ── read-only declaration ─────────────────────────────────────────────────────────────────────

function declarationRows(hook: HookDetail, L: Vocab): { k: string; v: ReactNode }[] {
  const rows: { k: string; v: ReactNode }[] = [
    { k: L.hkFieldEvent, v: hook.event },
    {
      k: matcherKindForEvent(hook.event) === 'filters' ? L.hkFieldFilters : L.hkFieldMatcher,
      v: hook.matcherFilters ? JSON.stringify(hook.matcherFilters) : hook.matcher ?? L.hkNoMatcher,
    },
    {
      k: hook.run.command !== null ? L.hkFieldCommand : L.hkFieldScript,
      v: hook.run.command ?? hook.run.script ?? '—',
    },
    { k: L.hkFieldTimeout, v: hook.run.timeoutSec == null ? '—' : `${hook.run.timeoutSec}s` },
    { k: L.hkFieldBackends, v: hook.scope?.backends?.join(' · ') ?? L.hkUnscoped },
    { k: L.hkFieldRequiresTool, v: hook.scope?.requiresTool ?? '—' },
    { k: L.hkFieldResult, v: hook.result ?? 'none' },
  ];
  if (hook.template !== null) {
    rows.push({ k: L.hkFieldTemplate, v: `${hook.template} · ${hook.phase ?? '—'}` });
  }
  return rows;
}

function ReadOnlyDeclaration({ hook }: { hook: HookDetail }) {
  const L = useVocab();
  return (
    <div style={FACTS_STYLE}>
      {declarationRows(hook, L).map((row) => (
        <MonoKV key={row.k} k={row.k} value={row.v} />
      ))}
    </div>
  );
}

// ── the test runner ───────────────────────────────────────────────────────────────────────────

// The log stays sealed while its frame and toolbar share the card material.
const RESULT_CARD_STYLE: CSSProperties = {
  marginTop: 10, background: 'var(--material-card-bg)', borderRadius: 'var(--r-control)',
  boxShadow: 'var(--material-card-shadow)', overflow: 'hidden',
};

function TestStream({ label, text, tone }: { label: string; text: string; tone?: 'danger' }) {
  const L = useVocab();
  const empty = text.trim() === '';
  const color = empty ? 'var(--proto-muted-3)'
    : tone === 'danger' ? 'var(--proto-danger)' : 'var(--proto-ink-2)';
  return (
    <div style={{ borderTop: '1px solid var(--proto-line-2)', padding: '8px 12px', background: 'var(--proto-card)' }}>
      <div style={{ font: `600 12px ${MONO}`, color: 'var(--proto-muted-3)', marginBottom: 4 }}>{label}</div>
      <pre style={{
        margin: 0, font: `400 12px/1.65 ${MONO}`, color, whiteSpace: 'pre-wrap',
        wordBreak: 'break-word', maxHeight: 130, overflow: 'auto',
      }}>
        {empty ? L.hkTestNoOutput : text}
      </pre>
    </div>
  );
}

function TestResult({ result }: { result: HooksTestReturn }) {
  return (
    <div data-hook-test-result="" style={RESULT_CARD_STYLE}>
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 12px',
        background: 'var(--material-inset-bg)', overflowWrap: 'anywhere', font: `500 12px ${MONO}`, color: 'var(--proto-muted)',
      }}>
        <span
          data-hook-test-exit={result.exitCode === null ? '' : String(result.exitCode)}
          style={{ color: result.ok ? 'var(--proto-success)' : 'var(--proto-danger)', fontWeight: 700 }}
        >
          exit {result.exitCode ?? '—'}
        </span>
        {result.error !== null ? <span style={{ color: 'var(--proto-danger)' }}>{result.error}</span> : null}
      </div>
      <TestStream label="stdout" text={result.stdout} />
      <TestStream label="stderr" text={result.stderr} tone="danger" />
    </div>
  );
}

function TestRunnerHeader({ onReset, onClose }: { onReset: () => void; onClose: () => void }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{L.hkTestTitle}</span>
      <SLinkAction data-action="reset-test-payload" onClick={onReset}>{L.hkTestReset}</SLinkAction>
      <span style={{ marginLeft: 'auto' }}>
        <SLinkAction data-action="close-test" tone="muted" onClick={onClose}>{L.hkTestClose}</SLinkAction>
      </span>
    </div>
  );
}

function PayloadField({ payload, error, onPayloadChange }: {
  payload: string;
  error: boolean;
  onPayloadChange: (value: string) => void;
}) {
  const L = useVocab();
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--proto-muted-2)', margin: '12px 0 4px' }}>{L.hkTestPayload}</div>
      <textarea
        data-hook-test-payload=""
        value={payload}
        onChange={(e) => onPayloadChange(e.target.value)}
        rows={6}
        style={{ ...(error ? CONTROL_ERROR_STYLE : S_CONTROL_STYLE), background: 'var(--proto-card)', fontFamily: MONO, height: 'auto', resize: 'vertical', lineHeight: 1.6 }}
      />
      {error ? (
        <div data-hook-payload-error="" style={{ fontSize: 12, color: 'var(--proto-danger)', marginTop: 4 }}>
          {L.hkPayloadInvalid}
        </div>
      ) : null}
    </>
  );
}

function TestRunner({ hook, payload, result, pending, onPayloadChange, onRun, onClose, onReset }: {
  hook: HookDetail;
  payload: string;
  result: HooksTestReturn | null;
  pending: boolean;
  onPayloadChange: (value: string) => void;
  onRun: () => void;
  onClose: () => void;
  onReset: () => void;
}) {
  const L = useVocab();
  const runnable = !pending && isPayloadParseable(payload);
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--proto-line-2)', paddingTop: 14 }}>
      <TestRunnerHeader onReset={onReset} onClose={onClose} />
      {/* A blocking hook posts a card to the message platform and parks the run until it is
          answered. The server caps a UI test at 15s, but the user still deserves the warning. */}
      {hook.blocking !== null ? (
        <NoticeStack style={{ marginTop: 10 }}>
          <SNotice data-hook-blocking-warning="" tone="amber">{L.hkTestBlockingWarn}</SNotice>
        </NoticeStack>
      ) : null}
      <PayloadField
        payload={payload} onPayloadChange={onPayloadChange}
        error={payload.trim() !== '' && !isPayloadParseable(payload)}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 }}>
        <SButton data-action="run-test" tone="accent" disabled={!runnable} onClick={onRun}>
          {L.hkTestRun}
        </SButton>
        <span style={{ font: `400 12px ${MONO}`, color: 'var(--proto-muted-3)', minWidth: 0, overflowWrap: 'anywhere' }}>
          {hook.run.command ?? hook.run.script ?? '—'}
        </span>
      </div>
      {result !== null ? <TestResult result={result} /> : null}
    </div>
  );
}

// ── detail shell ──────────────────────────────────────────────────────────────────────────────

export interface HookDetailPaneProps {
  hooks: HookDetail[];
  scripts: HookScriptInfo[];
  hooksDir: string;
  /** The editor's working copy — null when nothing is selected and nothing is being created. */
  draft: HookFormState | null;
  creating: boolean;
  armedDelete: boolean;
  saving: boolean;
  testOpen: boolean;
  testPayload: string;
  testResult: HooksTestReturn | null;
  testPending: boolean;
  onCancelCreate: () => void;
  onDraftChange: (next: HookFormState) => void;
  onToggleEnabled: (hook: HookDetail, next: boolean) => void;
  onSave: () => void;
  onRevert: () => void;
  onArmDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onOpenTest: () => void;
  onCloseTest: () => void;
  onTestPayloadChange: (value: string) => void;
  onRunTest: () => void;
}

function EmptyDetail() {
  const L = useVocab();
  return (
    <div className="settings-detail-pane" style={{ ...DETAIL_PANE_STYLE, alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ fontSize: 12, color: 'var(--proto-muted-3)' }}>{L.hkSelectHint}</span>
    </div>
  );
}

function DetailHeader({ hook, draft, creating, dirty, saving, onToggleEnabled }: {
  hook: HookDetail | null;
  draft: HookFormState;
  creating: boolean;
  dirty: boolean;
  saving: boolean;
  onToggleEnabled: (hook: HookDetail, next: boolean) => void;
}) {
  const L = useVocab();
  const canToggle = hook !== null && hookCapability(hook).canToggle;
  return (
    <div style={{ ...PANE_HEADER_STYLE, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <span style={{ font: `600 13px ${MONO}`, color: 'var(--proto-ink)', minWidth: 0, overflowWrap: 'anywhere' }}>
        {creating ? draft.id || L.hkCreate : hook?.id}
      </span>
      {hook ? <SourceBadge source={hook.source} /> : null}
      {hook?.mountsOn.map((target) => <MountBadge key={target} target={target} />)}
      {dirty && !creating ? <SPill tone="amber">{L.hkDirty}</SPill> : null}
      {hook !== null && canToggle ? (
        <span
          data-hook-toggle=""
          data-hook-enabled={hook.enabled ? '' : undefined}
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}
        >
          <span style={{ fontSize: 12, color: 'var(--proto-muted-2)' }}>
            {hook.enabled ? L.stHookEnabled : L.stHookDisabled}
          </span>
          <Toggle on={hook.enabled} onClick={saving ? undefined : () => onToggleEnabled(hook, !hook.enabled)} />
        </span>
      ) : null}
    </div>
  );
}

/** Persistent inline explanations — never toasts, because these constraints do not expire. */
function CapabilityNotices({ hook, note }: { hook: HookDetail | null; note: HookCapability['note'] | undefined }) {
  const L = useVocab();
  const alternative = hook ? claudeAlternativeEvent(hook.event) : null;
  const notices = [
    note === 'managed'
      ? <SNotice key="managed" data-hook-note="managed" tone="amber">{L.hkNoteManaged}</SNotice>
      : null,
    note === 'template-scoped' ? (
      <SNotice key="template" data-hook-note="template-scoped" tone="accent">
        {L.hkNoteTemplate}{hook?.template ? <Mono> · {hook.template}</Mono> : null}
      </SNotice>
    ) : null,
    hook !== null && hasClaudeMountGap(hook) ? (
      <SNotice key="gap" data-hook-claude-gap="" tone="amber">
        {L.hkClaudeGap} {alternative ? <Mono>{alternative}</Mono> : null}
      </SNotice>
    ) : null,
    hook?.scriptExists === false
      ? <SNotice key="missing" data-hook-script-missing="" tone="danger">{L.hkScriptMissing}</SNotice>
      : null,
  ].filter((notice) => notice !== null);
  if (notices.length === 0) return null;
  return <NoticeStack style={{ marginBottom: 6 }}>{notices}</NoticeStack>;
}

/** Structural facts the API never accepts as input, shown so the declaration reads whole. */
function RegistryFacts({ hook }: { hook: HookDetail }) {
  const L = useVocab();
  return (
    <>
      <SSectionLabel>{L.hkSecRegistry}</SSectionLabel>
      <div style={FACTS_STYLE}>
        <MonoKV k={L.hkFieldSource} value={hook.source} />
        <MonoKV k={L.hkFieldFile} value={hook.fileName ?? '—'} />
        <MonoKV k={L.hkFieldOrder} value={String(hook.order)} />
        <MonoKV k={L.hkFieldVersion} value={hook.version ?? '—'} />
        <MonoKV
          k={L.hkFieldBlocking}
          value={hook.blocking === null ? '—' : `${hook.blocking.mode} · ${hook.blocking.ttlMin} min`}
        />
        <MonoKV k={L.hkFieldMountsOn} value={hook.mountsOn.join(' · ') || '—'} />
      </div>
      {hook.appliesAt !== null ? (
        <div
          data-hook-applies-at={hook.appliesAt}
          style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--proto-muted-2)', marginTop: 9 }}
        >
          {hook.appliesAt === 'server-restart' ? L.hkAppliesRestart : L.hkAppliesNextAgent}
        </div>
      ) : null}
    </>
  );
}

function DeleteActions(props: HookDetailPaneProps) {
  const L = useVocab();
  if (!props.armedDelete) {
    return (
      <SButton data-action="arm-delete" tone="danger" disabled={props.saving} onClick={props.onArmDelete}>
        {L.hkDelete}
      </SButton>
    );
  }
  return (
    <>
      <SButton data-action="cancel-delete" tone="neutral" onClick={props.onCancelDelete}>{L.cancel}</SButton>
      <SButton data-action="confirm-delete" tone="danger" disabled={props.saving} onClick={props.onConfirmDelete}>
        {L.hkConfirmDelete}
      </SButton>
    </>
  );
}

/** Test · Revert · Save · Delete, with delete armed in two steps. */
function DetailFooter(props: HookDetailPaneProps & {
  hook: HookDetail | null;
  editing: boolean;
  dirty: boolean;
  savable: boolean;
}) {
  const L = useVocab();
  return (
    <PaneFooter hint={props.hooksDir}>
      {props.hook !== null && !props.testOpen ? (
        <SButton data-action="open-test" tone="neutral" onClick={props.onOpenTest}>{L.hkTest}</SButton>
      ) : null}
      {props.creating ? (
        <SButton data-action="cancel-create" tone="neutral" onClick={props.onCancelCreate}>
          {L.hkCancelCreate}
        </SButton>
      ) : null}
      {props.editing && !props.creating ? (
        <SButton data-action="revert" tone="neutral" disabled={!props.dirty} onClick={props.onRevert}>
          {L.hkRevert}
        </SButton>
      ) : null}
      {props.creating || props.editing ? (
        <SButton data-action="save" tone="accent" disabled={!props.savable} onClick={props.onSave}>
          {L.hkSave}
        </SButton>
      ) : null}
      {props.editing && !props.creating ? <DeleteActions {...props} /> : null}
    </PaneFooter>
  );
}

function DetailBody(props: HookDetailPaneProps & {
  hook: HookDetail | null;
  draft: HookFormState;
  editing: boolean;
  errors: ReturnType<typeof validateHookForm>;
}) {
  const L = useVocab();
  const { hook } = props;
  return (
    <div className="settings-detail-fields" style={PANE_BODY_STYLE}>
      <CapabilityNotices hook={hook} note={hook ? hookCapability(hook).note : undefined} />
      {props.editing ? (
        <HookEditor
          draft={props.draft}
          creating={props.creating}
          errors={props.errors}
          scripts={props.scripts}
          eventOptions={hookEventOptions(props.hooks)}
          onDraftChange={props.onDraftChange}
        />
      ) : hook ? (
        <>
          <SSectionLabel>{L.hkSecDeclaration}</SSectionLabel>
          <ReadOnlyDeclaration hook={hook} />
        </>
      ) : null}
      {hook ? <RegistryFacts hook={hook} /> : null}
      {props.testOpen && hook !== null ? (
        <TestRunner
          hook={hook}
          payload={props.testPayload}
          result={props.testResult}
          pending={props.testPending}
          onPayloadChange={props.onTestPayloadChange}
          onRun={props.onRunTest}
          onClose={props.onCloseTest}
          onReset={() => props.onTestPayloadChange(samplePayloadForEvent(hook.event))}
        />
      ) : null}
    </div>
  );
}

export function HookDetailPane(props: HookDetailPaneProps & { hook: HookDetail | null }) {
  const { hook, draft, creating } = props;
  if (draft === null || (hook === null && !creating)) return <EmptyDetail />;

  const editing = creating || (hook !== null && hookCapability(hook).canEdit);
  const errors = validateHookForm(draft, {
    mode: creating ? 'create' : 'update',
    existingIds: props.hooks.map((h) => h.id),
  });
  const dirty = creating ? true : hook !== null && isHookFormDirty(draft, hook);
  const savable = editing && dirty && isHookFormValid(errors) && !props.saving;

  return (
    <div className="settings-detail-pane" style={DETAIL_PANE_STYLE}>
      <DetailHeader
        hook={hook} draft={draft} creating={creating} dirty={dirty}
        saving={props.saving} onToggleEnabled={props.onToggleEnabled}
      />
      <DetailBody {...props} draft={draft} editing={editing} errors={errors} />
      <DetailFooter {...props} editing={editing} dirty={dirty} savable={savable} />
    </div>
  );
}
