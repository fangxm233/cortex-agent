// input:  hook view-model, settings atoms
// output: hook trigger, action, scope and advanced fields
// pos:    Responsive hook declaration form
// >>> Once updated, update this header and parent AGENTS.md <<<

import { Select } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import {
  RadioDot,
  SChip,
  SFieldRow,
  SLinkAction,
  SSectionLabel,
  S_CONTROL_DISABLED_STYLE,
  S_CONTROL_STYLE,
} from '@/features/settings/ui/settings-ui';
import { CONTROL_ERROR_STYLE } from '@/features/settings/ui/master-detail-ui';
import {
  isResultLocked,
  legalResultsForEvent,
  matcherKindForEvent,
  reconcileResultForEvent,
  validateHookForm,
  validateMatcherRegex,
  type HookFieldError,
  type HookFormState,
  type HookResultMode,
} from '@/features/settings/vm/hooks-panel-vm';
import type { HookScriptInfo } from '@cortex-agent/ui-contract';

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

// ── fields ───────────────────────────────────────────────────────────────────────────────────

type FilterRows = HookFormState['filters'];

function FilterRow({ row, index, rows, setRows }: {
  row: FilterRows[number];
  index: number;
  rows: FilterRows;
  setRows: (next: FilterRows) => void;
}) {
  const L = useVocab();
  const edit = (patch: Partial<FilterRows[number]>) =>
    setRows(rows.map((r, j) => (index === j ? { ...r, ...patch } : r)));
  return (
    <div className="settings-key-value-fields" style={{ marginBottom: 8 }}>
      <input
        data-hook-filter-key={index} value={row.key} placeholder={L.hkFilterKeyPh}
        onChange={(e) => edit({ key: e.target.value })} style={{ ...S_CONTROL_STYLE, flex: 1 }}
      />
      <input
        data-hook-filter-value={index} value={row.value} placeholder={L.hkFilterValuePh}
        onChange={(e) => edit({ value: e.target.value })} style={{ ...S_CONTROL_STYLE, flex: 1 }}
      />
      <SLinkAction
        data-hook-filter-remove={index} tone="muted" title={L.hkRemoveFilter}
        onClick={() => setRows(rows.filter((_, j) => j !== index))}
      >
        ×
      </SLinkAction>
    </div>
  );
}

function FilterEditor({ draft, onDraftChange }: {
  draft: HookFormState;
  onDraftChange: (next: HookFormState) => void;
}) {
  const L = useVocab();
  const rows = draft.filters;
  const setRows = (next: FilterRows) => onDraftChange({ ...draft, filters: next });
  return (
    <div data-hook-filters-editor="">
      {rows.map((row, i) => (
        <FilterRow key={i} row={row} index={i} rows={rows} setRows={setRows} />
      ))}
      <SLinkAction data-action="add-filter" onClick={() => setRows([...rows, { key: '', value: '' }])}>
        + {L.hkAddFilter}
      </SLinkAction>
    </div>
  );
}

function TriggerFields({ draft, errors, onDraftChange, err }: EditorSectionProps) {
  const L = useVocab();
  const matcherKind = matcherKindForEvent(draft.event);
  const regexError = matcherKind === 'regex' ? validateMatcherRegex(draft.matcher) : null;
  if (matcherKind === 'regex') {
    return (
      <MatcherField
        hint={regexError ? `${L.hkMatcherInvalid} — ${regexError}` : L.hkMatcherRegexHint}
        tone={regexError ? 'danger' : 'muted'}
        draft={draft}
        error={regexError !== null}
        onDraftChange={onDraftChange}
      />
    );
  }
  return (
    <SFieldRow
      label={L.hkFieldFilters}
      hint={err(errors.filters) ?? L.hkMatcherFiltersHint}
      hintTone={errors.filters ? 'danger' : 'muted'}
    >
      <FilterEditor draft={draft} onDraftChange={onDraftChange} />
    </SFieldRow>
  );
}

function MatcherField({ hint, tone, draft, error, onDraftChange }: {
  hint: string;
  tone: 'muted' | 'danger';
  draft: HookFormState;
  error: boolean;
  onDraftChange: (next: HookFormState) => void;
}) {
  const L = useVocab();
  return (
    <SFieldRow label={L.hkFieldMatcher} hint={hint} hintTone={tone}>
      <input
        data-hook-field="matcher"
        data-hook-matcher-error={error ? '' : undefined}
        value={draft.matcher}
        placeholder={L.hkNoMatcher}
        onChange={(e) => onDraftChange({ ...draft, matcher: e.target.value })}
        style={error ? CONTROL_ERROR_STYLE : S_CONTROL_STYLE}
      />
    </SFieldRow>
  );
}

function RunKindPicker({ draft, onDraftChange }: {
  draft: HookFormState;
  onDraftChange: (next: HookFormState) => void;
}) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, paddingTop: 4 }}>
      {(['script', 'command'] as const).map((kind) => (
        <span
          key={kind}
          data-hook-run-kind={kind}
          onClick={() => onDraftChange({ ...draft, runKind: kind })}
          role="button"
          style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}
        >
          <RadioDot selected={draft.runKind === kind} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink-2)' }}>
            {kind === 'script' ? L.hkFieldScript : L.hkFieldCommand}
          </span>
        </span>
      ))}
    </div>
  );
}

/** One field, two shapes: a script name completed from disk, or a free-form shell command. */
function RunTargetField({ draft, scripts, onDraftChange }: {
  draft: HookFormState;
  scripts: HookScriptInfo[];
  onDraftChange: (next: HookFormState) => void;
}) {
  const L = useVocab();
  if (draft.runKind !== 'script') {
    return (
      <SFieldRow label={L.hkFieldCommand}>
        <input
          data-hook-field="command"
          value={draft.command}
          onChange={(e) => onDraftChange({ ...draft, command: e.target.value })}
          style={S_CONTROL_STYLE}
        />
      </SFieldRow>
    );
  }
  return (
    <SFieldRow label={L.hkFieldScript}>
      <input
        data-hook-field="script"
        list={SCRIPT_LIST_ID}
        value={draft.script}
        onChange={(e) => onDraftChange({ ...draft, script: e.target.value })}
        style={S_CONTROL_STYLE}
      />
      <datalist id={SCRIPT_LIST_ID}>
        {scripts.map((script) => <option key={script.name} value={script.name} />)}
      </datalist>
    </SFieldRow>
  );
}

function ActionFields({ draft, errors, scripts, onDraftChange, err }: EditorSectionProps & {
  scripts: HookScriptInfo[];
}) {
  const L = useVocab();
  return (
    <>
      <SFieldRow label={L.hkFieldRun} hint={err(errors.run)} hintTone="danger">
        <RunKindPicker draft={draft} onDraftChange={onDraftChange} />
      </SFieldRow>
      <RunTargetField draft={draft} scripts={scripts} onDraftChange={onDraftChange} />
      <SFieldRow label={L.hkFieldTimeout} hint={err(errors.timeoutSec)} hintTone="danger">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <input
            data-hook-field="timeout"
            value={draft.timeoutSec}
            placeholder="30"
            onChange={(e) => onDraftChange({ ...draft, timeoutSec: e.target.value })}
            style={{ ...S_CONTROL_STYLE, width: 92 }}
          />
          <span style={{ fontSize: 12, color: 'var(--proto-muted-2)' }}>{L.hkSeconds}</span>
        </div>
      </SFieldRow>
    </>
  );
}

function BackendChips({ draft, onDraftChange }: {
  draft: HookFormState;
  onDraftChange: (next: HookFormState) => void;
}) {
  const toggle = (backend: 'claude' | 'pi', on: boolean) =>
    onDraftChange({
      ...draft,
      backends: on ? draft.backends.filter((b) => b !== backend) : [...draft.backends, backend],
    });
  return (
    <div data-hook-field="backends" style={{ display: 'flex', gap: 6, paddingTop: 2 }}>
      {(['claude', 'pi'] as const).map((backend) => {
        const on = draft.backends.includes(backend);
        return (
          <SChip
            key={backend}
            data-hook-backend={backend}
            data-active={on ? '' : undefined}
            active={on}
            onClick={() => toggle(backend, on)}
          >
            {backend}
          </SChip>
        );
      })}
    </div>
  );
}

function ScopeFields({ draft, onDraftChange }: {
  draft: HookFormState;
  onDraftChange: (next: HookFormState) => void;
}) {
  const L = useVocab();
  return (
    <>
      <SFieldRow label={L.hkFieldBackends} hint={draft.backends.length === 0 ? L.hkUnscoped : undefined}>
        <BackendChips draft={draft} onDraftChange={onDraftChange} />
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
    </>
  );
}

function ResultField({ draft, errors, onDraftChange, err }: EditorSectionProps) {
  const L = useVocab();
  const locked = isResultLocked(draft.event);
  return (
    <SFieldRow
      label={L.hkFieldResult}
      hint={locked ? L.hkResultLocked : err(errors.result)}
      hintTone={errors.result ? 'danger' : 'muted'}
    >
      <Select popupClassName="settings-surface settings-select-popup"
        data-hook-field="result"
        data-hook-result-locked={locked ? '' : undefined}
        aria-label={L.hkFieldResult}
        disabled={locked}
        value={draft.result}
        options={legalResultsForEvent(draft.event).map((mode) => ({ value: mode, label: mode }))}
        onValueChange={(result: HookResultMode) => onDraftChange({ ...draft, result })}
        style={locked ? S_CONTROL_DISABLED_STYLE : S_CONTROL_STYLE}
      />
    </SFieldRow>
  );
}

interface EditorSectionProps {
  draft: HookFormState;
  errors: ReturnType<typeof validateHookForm>;
  onDraftChange: (next: HookFormState) => void;
  err: (key: HookFieldError | undefined) => string | undefined;
}

export function HookEditor({
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
  const err = (key: HookFieldError | undefined) => (key ? L[FIELD_ERROR_LABEL[key]] : undefined);
  const section = { draft, errors, onDraftChange, err };

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
          {eventOptions.map((event) => <option key={event} value={event} />)}
        </datalist>
      </SFieldRow>
      <TriggerFields {...section} />

      <SSectionLabel>{L.hkSecAction}</SSectionLabel>
      <ActionFields {...section} scripts={scripts} />

      <SSectionLabel>{L.hkSecScope}</SSectionLabel>
      <ScopeFields draft={draft} onDraftChange={onDraftChange} />

      <SSectionLabel>{L.hkSecAdvanced}</SSectionLabel>
      <ResultField {...section} />
    </>
  );
}
