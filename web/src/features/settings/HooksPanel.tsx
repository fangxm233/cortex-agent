// input:  hooks data, form state, mutations and shared Select
// output: full-height hook editor with gating and test runner
// pos:    Settings view for the declarative hook registry
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  HookDetail,
  HookScriptInfo,
  HooksTestReturn,
} from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { Select, useToast } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import {
  MonoKV,
  RadioDot,
  SButton,
  SCard,
  SFieldRow,
  SSectionLabel,
  S_CONTROL_DISABLED_STYLE,
  S_CONTROL_STYLE,
  Toggle,
} from './settings-ui';
import {
  HOOK_FILTER_KEYS,
  buildHookCreateArgs,
  buildHookUpdateArgs,
  claudeAlternativeEvent,
  countHooksByFilter,
  emptyHookForm,
  filterHooks,
  formStateFromDetail,
  groupHooks,
  hasClaudeMountGap,
  hookCapability,
  hookEventOptions,
  isHookFormDirty,
  isHookFormValid,
  isPayloadParseable,
  isResultLocked,
  legalResultsForEvent,
  matcherKindForEvent,
  reconcileResultForEvent,
  resolveSelectedHookId,
  samplePayloadForEvent,
  validateHookForm,
  validateMatcherRegex,
  type HookFieldError,
  type HookFilterKey,
  type HookFilterValue,
  type HookFormState,
  type HookMountTarget,
  type HookResultMode,
} from './hooks-panel-vm';

// Hooks panel (plan §5): master–detail inside the settings content pane, replacing the flat
// read-only card. The value this adds over `cortex-hook` is making "will this hook actually fire?"
// visible — mount targets, apply time, result legality, load order and a missing script are all
// surfaced on the surface itself rather than left in the debugging chapter of the docs.
//
// Capability is gated by `source`, never by hope: managed entries expose only the toggle (a later
// hook sync restores the shipped enabled state, so editing the rest would be a lie), and
// template-scoped entries are read-only because the writer rejects them outright.
//
// No optimistic updates: every mutation invalidates hooks.list and reports through a toast.

const MONO = "'IBM Plex Mono',monospace";
const LIST_WIDTH = 288;

const MOUNT_TONE: Record<HookMountTarget, { bg: string; fg: string }> = {
  claude: { bg: 'var(--proto-accent-bg)', fg: 'var(--proto-accent)' },
  pi: { bg: 'var(--proto-success-bg)', fg: 'var(--proto-success)' },
  server: { bg: 'var(--proto-amber-bg)', fg: 'var(--proto-amber)' },
};

const FILTER_LABEL: Record<HookFilterKey, keyof Vocab> = {
  all: 'hkFilterAll',
  agent: 'hkFilterAgent',
  claude: 'hkFilterClaude',
  pi: 'hkFilterPi',
  server: 'hkFilterServer',
  template: 'hkFilterTemplate',
};

const FIELD_ERROR_LABEL: Record<HookFieldError, keyof Vocab> = {
  'id-required': 'hkErrIdRequired',
  'id-taken': 'hkErrIdTaken',
  'event-required': 'hkErrEventRequired',
  'matcher-invalid': 'hkMatcherInvalid',
  'filters-empty-key': 'hkErrFiltersEmptyKey',
  'filters-duplicate-key': 'hkErrFiltersDuplicate',
  'run-required': 'hkErrRunRequired',
  'timeout-invalid': 'hkErrTimeout',
  'result-illegal': 'hkErrResult',
};

const SCRIPT_LIST_ID = 'cortex-hook-scripts';
const EVENT_LIST_ID = 'cortex-hook-events';

// ── small presentational atoms ────────────────────────────────────────────────────────────────

function MountBadge({ target }: { target: HookMountTarget }) {
  const tone = MOUNT_TONE[target];
  return (
    <span
      data-hook-mount={target}
      style={{
        font: `600 8.5px ${MONO}`,
        padding: '1px 5px',
        borderRadius: 999,
        background: tone.bg,
        color: tone.fg,
        flex: 'none',
      }}
    >
      {target}
    </span>
  );
}

function SourceBadge({ source }: { source: HookDetail['source'] }) {
  const managed = source === 'managed';
  return (
    <span
      data-hook-source={source}
      style={{
        font: `600 9px ${MONO}`,
        padding: '1px 6px',
        borderRadius: 999,
        background: managed ? 'var(--proto-line-2)' : 'var(--proto-alt)',
        color: 'var(--proto-muted)',
        flex: 'none',
      }}
    >
      {source}
    </span>
  );
}

/** A persistent inline explanation — never a toast, because the constraint does not expire. */
function InlineNote({
  tone,
  children,
  ...rest
}: {
  tone: 'amber' | 'accent' | 'danger';
  children: ReactNode;
} & Record<string, unknown>) {
  const palette = {
    amber: { bg: 'var(--proto-amber-bg)', border: 'var(--proto-amber-border)', fg: 'var(--proto-amber-fg)' },
    accent: { bg: 'var(--proto-accent-bg)', border: 'var(--proto-accent-border)', fg: 'var(--proto-accent)' },
    danger: { bg: 'var(--proto-danger-bg)', border: 'var(--proto-danger-bg)', fg: 'var(--proto-danger)' },
  }[tone];
  return (
    <div
      {...rest}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
        padding: '7px 10px',
        borderRadius: 8,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        marginTop: 10,
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: palette.fg,
          flex: 'none',
          marginTop: 5,
        }}
      />
      <span style={{ fontSize: 10.5, lineHeight: 1.6, color: palette.fg, minWidth: 0 }}>{children}</span>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span style={{ font: `500 10px ${MONO}`, color: 'var(--proto-ink-2)' }}>{children}</span>;
}

// ── left column: chips, search, grouped list ──────────────────────────────────────────────────

function HookRow({
  hook,
  selected,
  onSelect,
}: {
  hook: HookDetail;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const L = useVocab();
  const broken = hook.scriptExists === false;
  return (
    <div
      data-hook-row={hook.id}
      data-hook-active={selected ? '' : undefined}
      onClick={() => onSelect(hook.id)}
      role="button"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
        padding: '7px 9px',
        borderRadius: 8,
        background: selected ? 'var(--proto-accent-bg)' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <span
        data-hook-order={hook.order}
        style={{ font: `500 9.5px ${MONO}`, color: 'var(--proto-faint)', flex: 'none', paddingTop: 1 }}
      >
        {String(hook.order).padStart(2, '0')}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{
              font: `600 10.5px ${MONO}`,
              color: selected ? 'var(--proto-accent)' : 'var(--proto-ink-2)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {hook.id}
          </span>
          {broken ? (
            <span
              data-hook-broken=""
              title={L.hkScriptMissing}
              style={{
                font: `600 8.5px ${MONO}`,
                padding: '0 5px',
                borderRadius: 999,
                background: 'var(--proto-danger-bg)',
                color: 'var(--proto-danger)',
                flex: 'none',
              }}
            >
              {L.hkBroken}
            </span>
          ) : null}
        </div>
        <div style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-2)', marginTop: 2, overflowWrap: 'anywhere' }}>
          {hook.event}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
          {hook.mountsOn.map((target) => (
            <MountBadge key={target} target={target} />
          ))}
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 9,
              fontWeight: 650,
              color: hook.enabled ? 'var(--proto-success)' : 'var(--proto-muted-2)',
              flex: 'none',
            }}
          >
            {hook.enabled ? L.stHookEnabled : L.stHookDisabled}
          </span>
        </div>
      </div>
    </div>
  );
}

function HookList({
  hooks,
  visible,
  filter,
  search,
  selectedId,
  onFilter,
  onSearch,
  onSelect,
  onStartCreate,
}: {
  hooks: HookDetail[];
  visible: HookDetail[];
  filter: HookFilterKey;
  search: string;
  selectedId: string | null;
  onFilter: (key: HookFilterKey) => void;
  onSearch: (value: string) => void;
  onSelect: (id: string) => void;
  onStartCreate: () => void;
}) {
  const L = useVocab();
  const counts = countHooksByFilter(hooks, search);
  const groups = groupHooks(visible);
  return (
    <SCard style={{ width: LIST_WIDTH, flex: 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '9px 10px 7px', borderBottom: '1px solid var(--proto-line-2)', flex: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ fontSize: 11.5, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.stAgentHooks}</span>
          <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-faint)' }}>{hooks.length}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {HOOK_FILTER_KEYS.map((key) => {
            const active = key === filter;
            return (
              <span
                key={key}
                onClick={() => onFilter(key)}
                role="button"
                data-hook-filter={key}
                data-active={active ? '' : undefined}
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
          data-hook-search=""
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={L.hkSearchPh}
          style={{ ...S_CONTROL_STYLE, marginTop: 7, padding: '4px 8px' }}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 6px' }}>
        {hooks.length === 0 || visible.length === 0 ? (
          <div
            data-hooks-empty=""
            style={{ padding: '14px 8px', fontSize: 10.5, color: 'var(--proto-faint)', lineHeight: 1.7 }}
          >
            {hooks.length === 0 ? L.stNoHooks : L.hkNoMatch}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.key} style={{ marginBottom: 4 }}>
              <div
                data-hook-group={group.key}
                style={{
                  font: `600 9px ${MONO}`,
                  letterSpacing: '.05em',
                  color: 'var(--proto-muted-3)',
                  padding: '7px 9px 3px',
                }}
              >
                {group.key === 'template' ? 'template' : `${group.key}:`}
              </div>
              {group.hooks.map((hook) => (
                <HookRow
                  key={hook.id}
                  hook={hook}
                  selected={hook.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </div>
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
        <span
          data-action="create"
          onClick={onStartCreate}
          role="button"
          style={{ fontSize: 11, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer', flex: 'none' }}
        >
          + {L.hkCreate}
        </span>
        <span style={{ marginLeft: 'auto', font: `400 9px ${MONO}`, color: 'var(--proto-faint)' }}>
          {L.hkOrderNote}
        </span>
      </div>
    </SCard>
  );
}

// ── right column: read-only declaration ───────────────────────────────────────────────────────

function ReadOnlyDeclaration({ hook }: { hook: HookDetail }) {
  const L = useVocab();
  const rows: { k: string; v: ReactNode }[] = [
    { k: L.hkFieldEvent, v: hook.event },
    {
      k: matcherKindForEvent(hook.event) === 'filters' ? L.hkFieldFilters : L.hkFieldMatcher,
      v: hook.matcherFilters
        ? JSON.stringify(hook.matcherFilters)
        : hook.matcher ?? L.hkNoMatcher,
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
  return (
    <div style={{ font: `400 10px/2 ${MONO}`, color: 'var(--proto-muted)', marginTop: 4 }}>
      {rows.map((row) => (
        <MonoKV key={row.k} k={row.k} value={row.v} />
      ))}
    </div>
  );
}

// ── right column: the editor ──────────────────────────────────────────────────────────────────

function FilterEditor({
  draft,
  onDraftChange,
}: {
  draft: HookFormState;
  onDraftChange: (next: HookFormState) => void;
}) {
  const L = useVocab();
  const rows = draft.filters;
  const setRows = (next: typeof rows) => onDraftChange({ ...draft, filters: next });
  return (
    <div data-hook-filters-editor="">
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 5, marginBottom: 4 }}>
          <input
            data-hook-filter-key={i}
            value={row.key}
            placeholder={L.hkFilterKeyPh}
            onChange={(e) =>
              setRows(rows.map((r, j) => (i === j ? { ...r, key: e.target.value } : r)))
            }
            style={{ ...S_CONTROL_STYLE, flex: 1 }}
          />
          <input
            data-hook-filter-value={i}
            value={row.value}
            placeholder={L.hkFilterValuePh}
            onChange={(e) =>
              setRows(rows.map((r, j) => (i === j ? { ...r, value: e.target.value } : r)))
            }
            style={{ ...S_CONTROL_STYLE, flex: 1 }}
          />
          <span
            data-hook-filter-remove={i}
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
            role="button"
            title={L.hkRemoveFilter}
            style={{
              font: `500 11px ${MONO}`,
              color: 'var(--proto-muted-3)',
              cursor: 'pointer',
              padding: '5px 6px',
              flex: 'none',
            }}
          >
            ×
          </span>
        </div>
      ))}
      <span
        data-action="add-filter"
        onClick={() => setRows([...rows, { key: '', value: '' }])}
        role="button"
        style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer' }}
      >
        + {L.hkAddFilter}
      </span>
    </div>
  );
}

function HookEditor({
  draft,
  creating,
  errors,
  scripts,
  eventOptions,
  onDraftChange,
}: {
  draft: HookFormState;
  creating: boolean;
  errors: ReturnType<typeof validateHookForm>;
  scripts: HookScriptInfo[];
  eventOptions: string[];
  onDraftChange: (next: HookFormState) => void;
}) {
  const L = useVocab();
  const err = (key: HookFieldError | undefined): string | undefined =>
    key ? L[FIELD_ERROR_LABEL[key]] : undefined;
  const matcherKind = matcherKindForEvent(draft.event);
  const regexError = matcherKind === 'regex' ? validateMatcherRegex(draft.matcher) : null;
  const legal = legalResultsForEvent(draft.event);
  const locked = isResultLocked(draft.event);

  return (
    <>
      <SSectionLabel>{L.hkSecTrigger}</SSectionLabel>
      {creating ? (
        <SFieldRow label={L.hkFieldId} hint={err(errors.id)} hintTone="danger">
          <input
            data-hook-field="id"
            value={draft.id}
            onChange={(e) => onDraftChange({ ...draft, id: e.target.value })}
            style={S_CONTROL_STYLE}
          />
        </SFieldRow>
      ) : null}
      <SFieldRow label={L.hkFieldEvent} hint={err(errors.event)} hintTone="danger">
        <input
          data-hook-field="event"
          list={EVENT_LIST_ID}
          value={draft.event}
          onChange={(e) => {
            const event = e.target.value;
            // The result select is constrained per event, so a stale illegal mode is dropped here
            // rather than sent to the loader to be rejected.
            onDraftChange({ ...draft, event, result: reconcileResultForEvent(draft.result, event) });
          }}
          style={S_CONTROL_STYLE}
        />
        <datalist id={EVENT_LIST_ID}>
          {eventOptions.map((event) => (
            <option key={event} value={event} />
          ))}
        </datalist>
      </SFieldRow>
      {matcherKind === 'regex' ? (
        <SFieldRow
          label={L.hkFieldMatcher}
          hint={regexError ? `${L.hkMatcherInvalid} — ${regexError}` : L.hkMatcherRegexHint}
          hintTone={regexError ? 'danger' : 'muted'}
        >
          <input
            data-hook-field="matcher"
            data-hook-matcher-error={regexError ? '' : undefined}
            value={draft.matcher}
            placeholder={L.hkNoMatcher}
            onChange={(e) => onDraftChange({ ...draft, matcher: e.target.value })}
            style={
              regexError ? { ...S_CONTROL_STYLE, borderColor: 'var(--proto-danger)' } : S_CONTROL_STYLE
            }
          />
        </SFieldRow>
      ) : (
        <SFieldRow
          label={L.hkFieldFilters}
          hint={err(errors.filters) ?? L.hkMatcherFiltersHint}
          hintTone={errors.filters ? 'danger' : 'muted'}
        >
          <FilterEditor draft={draft} onDraftChange={onDraftChange} />
        </SFieldRow>
      )}

      <SSectionLabel>{L.hkSecAction}</SSectionLabel>
      <SFieldRow label={L.hkFieldRun} hint={err(errors.run)} hintTone="danger">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingTop: 3 }}>
          {(['script', 'command'] as const).map((kind) => (
            <span
              key={kind}
              data-hook-run-kind={kind}
              onClick={() => onDraftChange({ ...draft, runKind: kind })}
              role="button"
              style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
            >
              <RadioDot selected={draft.runKind === kind} />
              <span style={{ font: `500 10.5px ${MONO}`, color: 'var(--proto-ink-2)' }}>
                {kind === 'script' ? L.hkFieldScript : L.hkFieldCommand}
              </span>
            </span>
          ))}
        </div>
      </SFieldRow>
      {draft.runKind === 'script' ? (
        <SFieldRow label={L.hkFieldScript}>
          <input
            data-hook-field="script"
            list={SCRIPT_LIST_ID}
            value={draft.script}
            onChange={(e) => onDraftChange({ ...draft, script: e.target.value })}
            style={S_CONTROL_STYLE}
          />
          <datalist id={SCRIPT_LIST_ID}>
            {scripts.map((script) => (
              <option key={script.name} value={script.name} />
            ))}
          </datalist>
        </SFieldRow>
      ) : (
        <SFieldRow label={L.hkFieldCommand}>
          <input
            data-hook-field="command"
            value={draft.command}
            onChange={(e) => onDraftChange({ ...draft, command: e.target.value })}
            style={S_CONTROL_STYLE}
          />
        </SFieldRow>
      )}
      <SFieldRow label={L.hkFieldTimeout} hint={err(errors.timeoutSec)} hintTone="danger">
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <input
            data-hook-field="timeout"
            value={draft.timeoutSec}
            placeholder="30"
            onChange={(e) => onDraftChange({ ...draft, timeoutSec: e.target.value })}
            style={{ ...S_CONTROL_STYLE, width: 92 }}
          />
          <span style={{ fontSize: 10, color: 'var(--proto-faint)' }}>{L.hkSeconds}</span>
        </div>
      </SFieldRow>

      <SSectionLabel>{L.hkSecScope}</SSectionLabel>
      <SFieldRow label={L.hkFieldBackends} hint={draft.backends.length === 0 ? L.hkUnscoped : undefined}>
        <div data-hook-field="backends" style={{ display: 'flex', gap: 5, paddingTop: 2 }}>
          {(['claude', 'pi'] as const).map((backend) => {
            const on = draft.backends.includes(backend);
            return (
              <span
                key={backend}
                data-hook-backend={backend}
                data-active={on ? '' : undefined}
                onClick={() =>
                  onDraftChange({
                    ...draft,
                    backends: on
                      ? draft.backends.filter((b) => b !== backend)
                      : [...draft.backends, backend],
                  })
                }
                role="button"
                style={{
                  font: `500 10px ${MONO}`,
                  padding: '3px 9px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: on ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
                  background: on ? 'var(--proto-accent-bg)' : 'var(--proto-card)',
                  border: `1px solid ${on ? 'var(--proto-accent-border)' : 'var(--proto-line)'}`,
                }}
              >
                {backend}
              </span>
            );
          })}
        </div>
      </SFieldRow>
      <SFieldRow label={L.hkFieldRequiresTool}>
        <input
          data-hook-field="requiresTool"
          value={draft.requiresTool}
          placeholder="—"
          onChange={(e) => onDraftChange({ ...draft, requiresTool: e.target.value })}
          style={S_CONTROL_STYLE}
        />
      </SFieldRow>

      <SSectionLabel>{L.hkSecAdvanced}</SSectionLabel>
      <SFieldRow
        label={L.hkFieldResult}
        hint={locked ? L.hkResultLocked : err(errors.result)}
        hintTone={errors.result ? 'danger' : 'muted'}
      >
        <Select
          data-hook-field="result"
          data-hook-result-locked={locked ? '' : undefined}
          aria-label={L.hkFieldResult}
          disabled={locked}
          value={draft.result}
          options={legal.map((mode) => ({ value: mode, label: mode }))}
          onValueChange={(result: HookResultMode) => onDraftChange({ ...draft, result })}
          style={locked ? S_CONTROL_DISABLED_STYLE : S_CONTROL_STYLE}
        />
      </SFieldRow>
    </>
  );
}

// ── right column: the test runner ─────────────────────────────────────────────────────────────

function TestRunner({
  hook,
  payload,
  result,
  pending,
  onPayloadChange,
  onRun,
  onClose,
  onReset,
}: {
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
  const payloadError = payload.trim() !== '' && !isPayloadParseable(payload);
  const runnable = !pending && isPayloadParseable(payload);
  return (
    <div
      style={{
        marginTop: 12,
        borderTop: '1px solid var(--proto-line-2)',
        paddingTop: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11.5, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.hkTestTitle}</span>
        <span
          data-action="reset-test-payload"
          onClick={onReset}
          role="button"
          style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-accent)', cursor: 'pointer', marginLeft: 6 }}
        >
          {L.hkTestReset}
        </span>
        <span
          data-action="close-test"
          onClick={onClose}
          role="button"
          style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)', cursor: 'pointer' }}
        >
          {L.hkTestClose}
        </span>
      </div>
      {/* A blocking hook posts a card to the message platform and parks the run until it is
          answered. The server caps a UI test at 15s, but the user still deserves the warning. */}
      {hook.blocking !== null ? (
        <InlineNote data-hook-blocking-warning="" tone="amber">
          {L.hkTestBlockingWarn}
        </InlineNote>
      ) : null}
      <div style={{ fontSize: 10, color: 'var(--proto-faint)', margin: '8px 0 4px' }}>{L.hkTestPayload}</div>
      <textarea
        data-hook-test-payload=""
        value={payload}
        onChange={(e) => onPayloadChange(e.target.value)}
        rows={6}
        style={{
          ...S_CONTROL_STYLE,
          resize: 'vertical',
          lineHeight: 1.6,
          borderColor: payloadError ? 'var(--proto-danger)' : 'var(--proto-line)',
        }}
      />
      {payloadError ? (
        <div data-hook-payload-error="" style={{ fontSize: 9.5, color: 'var(--proto-danger)', marginTop: 3 }}>
          {L.hkPayloadInvalid}
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <SButton data-action="run-test" tone="accent" disabled={!runnable} onClick={onRun}>
          {L.hkTestRun}
        </SButton>
        <span style={{ font: `400 9px ${MONO}`, color: 'var(--proto-faint)' }}>
          {hook.run.command ?? hook.run.script ?? '—'}
        </span>
      </div>
      {result !== null ? (
        <div
          data-hook-test-result=""
          style={{
            marginTop: 9,
            border: '1px solid var(--proto-line-2)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              background: 'var(--proto-alt)',
              font: `500 9.5px ${MONO}`,
              color: 'var(--proto-muted)',
            }}
          >
            <span
              data-hook-test-exit={result.exitCode === null ? '' : String(result.exitCode)}
              style={{ color: result.ok ? 'var(--proto-success)' : 'var(--proto-danger)', fontWeight: 700 }}
            >
              exit {result.exitCode ?? '—'}
            </span>
            {result.error !== null ? (
              <span style={{ color: 'var(--proto-danger)' }}>{result.error}</span>
            ) : null}
          </div>
          <TestStream label="stdout" text={result.stdout} />
          <TestStream label="stderr" text={result.stderr} tone="danger" />
        </div>
      ) : null}
    </div>
  );
}

function TestStream({ label, text, tone }: { label: string; text: string; tone?: 'danger' }) {
  const L = useVocab();
  const empty = text.trim() === '';
  return (
    <div style={{ borderTop: '1px solid var(--proto-line-2)', padding: '6px 10px' }}>
      <div style={{ font: `600 9px ${MONO}`, color: 'var(--proto-muted-3)', marginBottom: 3 }}>{label}</div>
      <pre
        style={{
          margin: 0,
          font: `400 10px/1.65 ${MONO}`,
          color: empty
            ? 'var(--proto-faint)'
            : tone === 'danger'
              ? 'var(--proto-danger)'
              : 'var(--proto-ink-2)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 130,
          overflow: 'auto',
        }}
      >
        {empty ? L.hkTestNoOutput : text}
      </pre>
    </div>
  );
}

// ── right column: detail shell ────────────────────────────────────────────────────────────────

const FOOTER_STYLE: CSSProperties = {
  flex: 'none',
  borderTop: '1px solid var(--proto-line-2)',
  padding: '9px 14px',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

function HookDetailPane(props: HooksPanelViewProps & { hook: HookDetail | null }) {
  const L = useVocab();
  const { hook, draft, creating } = props;

  if (draft === null || (hook === null && !creating)) {
    return (
      <SCard style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 11.5, color: 'var(--proto-muted-3)' }}>{L.hkSelectHint}</span>
      </SCard>
    );
  }

  const capability = hook ? hookCapability(hook) : null;
  const editing = creating || (capability?.canEdit ?? false);
  const errors = validateHookForm(draft, {
    mode: creating ? 'create' : 'update',
    existingIds: props.hooks.map((h) => h.id),
  });
  const dirty = creating ? true : hook !== null && isHookFormDirty(draft, hook);
  const savable = editing && dirty && isHookFormValid(errors) && !props.saving;
  const claudeGap = hook !== null && hasClaudeMountGap(hook);
  const alternative = hook ? claudeAlternativeEvent(hook.event) : null;
  const appliesAt = hook?.appliesAt ?? null;

  return (
    <SCard style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* header — identity, source, mount targets and the one write managed entries do allow */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          borderBottom: '1px solid var(--proto-line-2)',
        }}
      >
        <span style={{ font: `600 12px ${MONO}`, color: 'var(--proto-ink)', minWidth: 0, overflowWrap: 'anywhere' }}>
          {creating ? draft.id || L.hkCreate : hook?.id}
        </span>
        {hook ? <SourceBadge source={hook.source} /> : null}
        {hook?.mountsOn.map((target) => (
          <MountBadge key={target} target={target} />
        ))}
        {dirty && !creating ? (
          <span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--proto-amber)' }}>{L.hkDirty}</span>
        ) : null}
        {hook && capability?.canToggle ? (
          <span
            data-hook-toggle=""
            data-hook-enabled={hook.enabled ? '' : undefined}
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, flex: 'none' }}
          >
            <span style={{ fontSize: 10, color: 'var(--proto-muted-2)' }}>
              {hook.enabled ? L.stHookEnabled : L.stHookDisabled}
            </span>
            <Toggle
              on={hook.enabled}
              onClick={props.saving ? undefined : () => props.onToggleEnabled(hook, !hook.enabled)}
            />
          </span>
        ) : null}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 14px 12px' }}>
        {/* capability notes — persistent, because the constraint does not go away */}
        {capability?.note === 'managed' ? (
          <InlineNote data-hook-note="managed" tone="amber">
            {L.hkNoteManaged}
          </InlineNote>
        ) : null}
        {capability?.note === 'template-scoped' ? (
          <InlineNote data-hook-note="template-scoped" tone="accent">
            {L.hkNoteTemplate}
            {hook?.template ? <Mono> · {hook.template}</Mono> : null}
          </InlineNote>
        ) : null}
        {claudeGap ? (
          <InlineNote data-hook-claude-gap="" tone="amber">
            {L.hkClaudeGap} {alternative ? <Mono>{alternative}</Mono> : null}
          </InlineNote>
        ) : null}
        {hook?.scriptExists === false ? (
          <InlineNote data-hook-script-missing="" tone="danger">
            {L.hkScriptMissing}
          </InlineNote>
        ) : null}

        {editing ? (
          <HookEditor
            draft={draft}
            creating={creating}
            errors={errors}
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

        {/* Structural facts the API never accepts as input, shown so the declaration reads whole. */}
        {hook ? (
          <>
            <SSectionLabel>{L.hkSecRegistry}</SSectionLabel>
            <div style={{ font: `400 10px/2 ${MONO}`, color: 'var(--proto-muted)' }}>
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
            {appliesAt !== null ? (
              <div
                data-hook-applies-at={appliesAt}
                style={{ fontSize: 10, lineHeight: 1.7, color: 'var(--proto-muted-2)', marginTop: 7 }}
              >
                {appliesAt === 'server-restart' ? L.hkAppliesRestart : L.hkAppliesNextAgent}
              </div>
            ) : null}
          </>
        ) : null}

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

      {/* footer — Test · Revert · Save · Delete, with delete armed in two steps */}
      <div style={FOOTER_STYLE}>
        <span style={{ font: `400 9px ${MONO}`, color: 'var(--proto-faint)', flex: 1, minWidth: 0 }}>
          {props.hooksDir}
        </span>
        {hook !== null && !props.testOpen ? (
          <SButton data-action="open-test" tone="neutral" onClick={props.onOpenTest}>
            {L.hkTest}
          </SButton>
        ) : null}
        {creating ? (
          <>
            <SButton data-action="cancel-create" tone="neutral" onClick={props.onCancelCreate}>
              {L.hkCancelCreate}
            </SButton>
            <SButton data-action="save" tone="accent" disabled={!savable} onClick={props.onSave}>
              {L.hkSave}
            </SButton>
          </>
        ) : editing ? (
          <>
            <SButton data-action="revert" tone="neutral" disabled={!dirty} onClick={props.onRevert}>
              {L.hkRevert}
            </SButton>
            <SButton data-action="save" tone="accent" disabled={!savable} onClick={props.onSave}>
              {L.hkSave}
            </SButton>
            {props.armedDelete ? (
              <>
                <SButton data-action="cancel-delete" tone="neutral" onClick={props.onCancelDelete}>
                  {L.cancel}
                </SButton>
                <SButton
                  data-action="confirm-delete"
                  tone="danger"
                  disabled={props.saving}
                  onClick={props.onConfirmDelete}
                >
                  {L.hkConfirmDelete}
                </SButton>
              </>
            ) : (
              <SButton data-action="arm-delete" tone="danger" disabled={props.saving} onClick={props.onArmDelete}>
                {L.hkDelete}
              </SButton>
            )}
          </>
        ) : null}
      </div>
    </SCard>
  );
}

// ── the pure view ─────────────────────────────────────────────────────────────────────────────

export interface HooksPanelViewProps {
  hooks: HookDetail[];
  scripts: HookScriptInfo[];
  hooksDir: string;
  filter: HookFilterKey;
  search: string;
  selectedId: string | null;
  /** The editor's working copy — null when nothing is selected and nothing is being created. */
  draft: HookFormState | null;
  creating: boolean;
  armedDelete: boolean;
  saving: boolean;
  testOpen: boolean;
  testPayload: string;
  testResult: HooksTestReturn | null;
  testPending: boolean;
  onFilter: (key: HookFilterKey) => void;
  onSearch: (value: string) => void;
  onSelect: (id: string) => void;
  onStartCreate: () => void;
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

export function HooksPanelView(props: HooksPanelViewProps) {
  const visible = filterHooks(props.hooks, props.filter, props.search);
  const hook = props.hooks.find((h) => h.id === props.selectedId) ?? null;
  return (
    <div
      data-settings-panel="hooks"
      style={{ marginTop: 12, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div
        data-hook-cards=""
        style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0, alignItems: 'stretch' }}
      >
        <HookList
          hooks={props.hooks}
          visible={visible}
          filter={props.filter}
          search={props.search}
          selectedId={props.selectedId}
          onFilter={props.onFilter}
          onSearch={props.onSearch}
          onSelect={props.onSelect}
          onStartCreate={props.onStartCreate}
        />
        <HookDetailPane {...props} hook={hook} />
      </div>
    </div>
  );
}

// ── container: binds hooks.list + the hooks.* mutations ───────────────────────────────────────

/**
 * The generated router input type narrows a matcherFilters value to `string | number | boolean`,
 * dropping the `null` that the zod schema, the `HookDetail` DTO and the loader all carry (the
 * schema's own `safeParse` accepts `{ k: null }`). Dropping null from the editor instead would
 * silently rewrite a legitimate `null` filter to the string `"null"` on the next save, so the value
 * is kept and the two shapes are reconciled here — the one place they meet.
 */
type WireFilters = Record<string, string | number | boolean>;

function toWireArgs<T extends { matcherFilters?: Record<string, HookFilterValue> }>(
  args: T,
): Omit<T, 'matcherFilters'> & { matcherFilters?: WireFilters } {
  return args as Omit<T, 'matcherFilters'> & { matcherFilters?: WireFilters };
}

export function HooksPanel() {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const listQuery = useQuery(trpc.hooks.list.queryOptions({}));
  const hooks = useMemo(() => listQuery.data?.hooks ?? [], [listQuery.data]);

  const [filter, setFilter] = useState<HookFilterKey>('all');
  const [search, setSearch] = useState('');
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<HookFormState>(emptyHookForm);
  /** Non-null only while the user has actually typed something — otherwise the record is the truth. */
  const [edits, setEdits] = useState<HookFormState | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testPayload, setTestPayload] = useState('');
  const [testResult, setTestResult] = useState<HooksTestReturn | null>(null);

  const visible = useMemo(() => filterHooks(hooks, filter, search), [hooks, filter, search]);
  const selectedId = creating ? null : resolveSelectedHookId(hooks, visible, requestedId);
  const selected = hooks.find((h) => h.id === selectedId) ?? null;

  // Selecting another hook drops the working copy and every transient affordance with it.
  useEffect(() => {
    setEdits(null);
    setArmedDelete(false);
    setTestOpen(false);
    setTestResult(null);
  }, [selectedId]);

  const invalidate = () => queryClient.invalidateQueries(trpc.hooks.list.queryFilter({}));
  const onWriteError = (error: { message: string }) =>
    toast({ title: `${L.hkToastWriteFailed}: ${error.message}`, tone: 'failed' });

  const setEnabled = useMutation(
    trpc.hooks.setEnabled.mutationOptions({
      onSuccess: (data, vars) => {
        invalidate();
        toast({ title: vars.enabled ? L.hkToastEnabled : L.hkToastDisabled, tone: 'done' });
        // A managed entry's enabled flag is restored by the next hook sync — the server says so.
        if (data.warning !== null) toast({ title: data.warning, tone: 'waiting' });
      },
      onError: onWriteError,
    }),
  );
  const create = useMutation(
    trpc.hooks.create.mutationOptions({
      onSuccess: (data) => {
        invalidate();
        toast({ title: `${L.hkToastCreated} · ${data.fileName}`, tone: 'done' });
        setCreating(false);
        setCreateDraft(emptyHookForm());
        setRequestedId(data.id);
      },
      onError: onWriteError,
    }),
  );
  const update = useMutation(
    trpc.hooks.update.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast({ title: L.hkToastSaved, tone: 'done' });
        setEdits(null);
      },
      onError: onWriteError,
    }),
  );
  const remove = useMutation(
    trpc.hooks.remove.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast({ title: L.hkToastDeleted, tone: 'done' });
        setArmedDelete(false);
        setRequestedId(null);
      },
      onError: onWriteError,
    }),
  );
  // hooks.test only executes an already-mounted declaration; it changes no state, so it is the one
  // mutation here that does not invalidate the list.
  const runTest = useMutation(
    trpc.hooks.test.mutationOptions({
      onSuccess: (data) => setTestResult(data),
      onError: (error) => {
        setTestResult(null);
        toast({ title: `${L.hkToastTestFailed}: ${error.message}`, tone: 'failed' });
      },
    }),
  );

  if (listQuery.isLoading) {
    return <div style={{ marginTop: 16, fontSize: 12, color: 'var(--proto-muted-3)' }}>{L.hkLoading}</div>;
  }
  if (listQuery.isError) {
    return (
      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--proto-danger)' }}>
        {L.hkLoadFailed} {listQuery.error.message}
      </div>
    );
  }

  const draft = creating ? createDraft : edits ?? (selected ? formStateFromDetail(selected) : null);

  return (
    <HooksPanelView
      hooks={hooks}
      scripts={listQuery.data?.scripts ?? []}
      hooksDir={listQuery.data?.hooksDir ?? ''}
      filter={filter}
      search={search}
      selectedId={selectedId}
      draft={draft}
      creating={creating}
      armedDelete={armedDelete}
      saving={create.isPending || update.isPending || remove.isPending || setEnabled.isPending}
      testOpen={testOpen}
      testPayload={testPayload}
      testResult={testResult}
      testPending={runTest.isPending}
      onFilter={setFilter}
      onSearch={setSearch}
      onSelect={(id) => {
        setCreating(false);
        setRequestedId(id);
      }}
      onStartCreate={() => {
        setCreating(true);
        setCreateDraft(emptyHookForm());
        setTestOpen(false);
        setArmedDelete(false);
      }}
      onCancelCreate={() => {
        setCreating(false);
        setCreateDraft(emptyHookForm());
      }}
      onDraftChange={(next) => (creating ? setCreateDraft(next) : setEdits(next))}
      onToggleEnabled={(target, next) => setEnabled.mutate({ id: target.id, enabled: next })}
      onSave={() => {
        if (draft === null) return;
        if (creating) create.mutate(toWireArgs(buildHookCreateArgs(draft)));
        else update.mutate(toWireArgs(buildHookUpdateArgs(draft)));
      }}
      onRevert={() => setEdits(null)}
      onArmDelete={() => setArmedDelete(true)}
      onCancelDelete={() => setArmedDelete(false)}
      onConfirmDelete={() => {
        if (selected !== null) remove.mutate({ id: selected.id });
      }}
      onOpenTest={() => {
        setTestOpen(true);
        setTestResult(null);
        if (selected !== null) setTestPayload(samplePayloadForEvent(selected.event));
      }}
      onCloseTest={() => {
        setTestOpen(false);
        setTestResult(null);
      }}
      onTestPayloadChange={setTestPayload}
      onRunTest={() => {
        if (selected !== null) runTest.mutate({ id: selected.id, payload: testPayload });
      }}
    />
  );
}
