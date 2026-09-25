// input:  profile controller, model catalog, settings atoms
// output: responsive desktop profile list and editor
// pos:    Desktop profile comparison and editing panel
// >>> Once updated, update this header and parent AGENTS.md <<<

import '@/features/settings/ui/desktop-panels.css';
import { useState, type CSSProperties, type ReactNode } from 'react';
import type { ConfigProfileEntry, ConfigSnapshot, ModelCatalogSnapshot } from '@cortex-agent/ui-contract';
import { Select } from '@/design';
import { useVocab } from '@/i18n';
import {
  MonoKV,
  SButton,
  SCard,
  SFieldRow,
  SLinkAction,
  SNotice,
  SPill,
  SRow,
  SRowGroup,
  SSection,
  SSelectChip,
  S_CONTROL_DISABLED_STYLE,
  S_CONTROL_STYLE,
} from '@/features/settings/ui/settings-ui';
import {
  PROFILE_BACKENDS,
  THINKING_LEVELS,
  isProfileFormValid,
  profileFieldChoices,
  profileFieldErrorCopy,
  withCurrentValue,
  type ProfileBackend,
  type ProfileFormErrors,
  type ProfileFormState,
  type ProfileOptionRow,
} from '@/features/settings/vm/profiles-panel-vm';
import { useProfilesController, type ProfileFact } from '@/features/settings/controllers/useProfilesController';

// Profiles panel: the read-only table plus the default-profile picker it has always had, now with
// the three writes the file itself allows — create, edit, delete an entry of the `profiles` map.
// `config.set {section:'profiles'}` still owns defaultProfile; the picker is unchanged.
//
// Two refusals are structural, not stylistic: a profile cannot be RENAMED (mode.json binds channels
// to a profile by name and live sessions carry it, so a rename would silently orphan them), and the
// default profile cannot be DELETED (a dangling default breaks every agent start). The second is
// enforced server-side too; the row shows the reason rather than hiding the action.
//
// `extraEnv` values never reach the browser (they are environment injection and may hold a token)
// and `fallback[]` has no editor — both are shown read-only and carried over untouched by a save.
//
// model / provider / mode are PICKED from models.catalog rather than typed, and in that order:
// the provider selects the endpoint, which decides the other two lists. The catalog only offers —
// every one of the three keeps a `Custom…` escape and falls back to a plain text box when the host
// cannot enumerate that endpoint, so nothing profiles.json accepts becomes unwritable here.
//
// No optimistic updates: every mutation invalidates config.get and reports through a toast.

const MONO = "'IBM Plex Mono',monospace";

const PANEL_STACK: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 };

// ── the table ─────────────────────────────────────────────────────────────────────────────────
//
// Wide panes compare attributes in columns; narrow panes repeat the labels in each card.
// The create action stays visible in both layouts.

const COL: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '.07em',
  textTransform: 'uppercase',
  color: 'var(--proto-muted)',
};

const TABLE_ROW: CSSProperties = {
  gap: 12,
  alignItems: 'center',
  padding: '11px 16px',
};

const ROW_ACTIONS: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end', minWidth: 0 };

function Cell({ value, label, dim }: { value: string | null; label: string; dim?: boolean }) {
  return (
    <span
      className="settings-profile-cell" data-label={label}
      style={{
        font: `400 12px ${MONO}`,
        color: value ? (dim ? 'var(--proto-muted-3)' : 'var(--proto-ink-2)') : 'var(--proto-faint)',
        overflowWrap: 'anywhere',
        minWidth: 0,
      }}
    >
      {value ?? '—'}
    </span>
  );
}

function ProfileTableHead({ busy, onCreate }: { busy: boolean; onCreate: () => void }) {
  const L = useVocab();
  return (
    <div className="settings-profile-row settings-profile-head" style={{ ...TABLE_ROW, padding: '10px 16px' }}>
      <span style={COL}>{L.stColName}</span>
      <span style={COL}>{L.stColModel}</span>
      <span style={COL}>{L.stColBackend}</span>
      <span style={COL}>{L.stColMode}</span>
      <span style={COL}>{L.stColThinking}</span>
      <span style={{ textAlign: 'right' }}>
        <SLinkAction data-action="new-profile" disabled={busy} onClick={busy ? undefined : onCreate}>
          {L.pfNew}
        </SLinkAction>
      </span>
    </div>
  );
}

function ProfileRowActions({ p, fact }: { p: ProfilesPanelViewProps; fact: ProfileFact }) {
  const L = useVocab();
  const name = fact.profile.name;
  const busy = p.draft !== null;
  const pending = p.removePendingName === name;
  const blocked = busy || p.removePendingName !== null || !fact.canDelete;
  if (p.armedDelete === name) {
    return (
      <span style={ROW_ACTIONS}>
        <SLinkAction data-action="cancel-delete" onClick={p.onCancelDelete}>{L.cancel}</SLinkAction>
        <SLinkAction data-action="confirm-delete" tone="danger" disabled={pending}
          onClick={pending ? undefined : () => p.onConfirmDelete(name)}>
          {L.pfConfirmDelete}
        </SLinkAction>
      </span>
    );
  }
  return (
    <span style={ROW_ACTIONS}>
      <SLinkAction data-action="edit" disabled={busy} onClick={busy ? undefined : () => p.onStartEdit(name)}>
        {L.pfEdit}
      </SLinkAction>
      <SLinkAction data-action="duplicate" disabled={busy}
        onClick={busy ? undefined : () => p.onStartDuplicate(name)}>
        {L.pfDuplicate}
      </SLinkAction>
      <SLinkAction data-action="delete" data-delete-blocked={fact.current ? '' : undefined} tone="danger"
        title={fact.current ? L.pfDeleteDefaultBlocked : undefined} disabled={blocked}
        onClick={blocked ? undefined : () => p.onArmDelete(name)}>
        {L.pfDelete}
      </SLinkAction>
    </span>
  );
}

function ProfileRow({ p, fact }: { p: ProfilesPanelViewProps; fact: ProfileFact }) {
  const L = useVocab();
  const r = fact.profile;
  return (
    <div
      className="settings-profile-row"
      data-profile-row={r.name}
      style={{
        ...TABLE_ROW,
        background: p.editingName === r.name ? 'var(--proto-accent-bg)' : undefined,
      }}
    >
      <span className="settings-profile-name" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span style={{
          font: `600 13px ${MONO}`, color: 'var(--proto-ink)',
          overflowWrap: 'anywhere', minWidth: 0,
        }}>
          {r.name}
        </span>
        {fact.current ? <SPill tone="accent">{L.default}</SPill> : null}
      </span>
      <Cell value={r.model} label={L.stColModel} dim />
      <Cell value={r.backend} label={L.stColBackend} dim />
      <Cell value={r.mode} label={L.stColMode} />
      <Cell value={r.thinking} label={L.stColThinking} />
      <ProfileRowActions p={p} fact={fact} />
    </div>
  );
}

function ProfileTable({ p }: { p: ProfilesPanelViewProps }) {
  const L = useVocab();
  return (
    <SRowGroup className="settings-profile-table">
      <ProfileTableHead busy={p.draft !== null} onCreate={p.onStartCreate} />
      {p.profileFacts.length === 0 ? (
        <div style={{ padding: '13px 16px', fontSize: 13, color: 'var(--proto-muted-2)' }}>
          {L.stNoProfiles}
        </div>
      ) : (
        p.profileFacts.map((fact) => <ProfileRow key={fact.profile.name} p={p} fact={fact} />)
      )}
    </SRowGroup>
  );
}

// ── the default-profile row ───────────────────────────────────────────────────────────────────

// The live picker uses the shared control geometry; only identifiers retain monospace.
const PICKER_STYLE: CSSProperties = {
  ...S_CONTROL_STYLE, width: 'auto', minWidth: 132, maxWidth: '100%',
  fontFamily: MONO, fontWeight: 500, cursor: 'pointer', flex: 'none',
};

function DefaultProfileRow({ current, names, onPick }: {
  current: string | null;
  names: string[];
  onPick?: (name: string) => void;
}) {
  const L = useVocab();
  return (
    <SRowGroup>
      <SRow
        title={L.stDefaultProfile}
        desc={L.stProfReadNote}
        control={onPick ? (
          <Select popupClassName="settings-surface settings-select-popup"
            data-default-profile-select
            aria-label={L.stDefaultProfile}
            density="bare"
            value={current ?? ''}
            options={names.map((name) => ({ value: name, label: name }))}
            onValueChange={onPick}
            style={PICKER_STYLE}
          />
        ) : (
          <SSelectChip disabled title="Select a profile to write profiles.json defaultProfile">
            <span style={{ font: `500 12px ${MONO}` }}>{current ?? '—'}</span>
          </SSelectChip>
        )}
      />
    </SRowGroup>
  );
}

// ── editor ────────────────────────────────────────────────────────────────────────────────────

/** The three fields the catalog can offer a list for; the rest are fixed sets or free text. */
type ChoiceField = 'model' | 'provider' | 'mode';

/** Sentinel option value — not a legal profile value (a safe name cannot hold a NUL). */
const CUSTOM_OPTION = '\u0000custom';

function ProfileChoice({
  field,
  label,
  value,
  options,
  emptyLabel,
  custom,
  onCustom,
  onValueChange,
}: {
  field: ChoiceField;
  label: string;
  value: string;
  options: readonly string[];
  /** Label of the "" option. Omitted ⇒ the field has no legal empty value (model). */
  emptyLabel?: string;
  custom: boolean;
  onCustom: (custom: boolean) => void;
  onValueChange: (value: string) => void;
}) {
  const L = useVocab();
  // Nothing to pick from ⇒ the control IS the text box. An endpoint the host cannot enumerate
  // (a provider that is not logged in, a scan that failed) must stay writable.
  if (custom || options.length === 0) {
    return (
      <div className="settings-inline-fields" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input
          data-profile-field={field}
          data-profile-choice="custom"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          style={S_CONTROL_STYLE}
        />
        {options.length > 0 ? (
          <SLinkAction data-action={`list-${field}`} onClick={() => onCustom(false)}>
            {L.pfPickFromList}
          </SLinkAction>
        ) : null}
      </div>
    );
  }
  return (
    <Select popupClassName="settings-surface settings-select-popup"
      data-profile-field={field}
      data-profile-choice="select"
      aria-label={label}
      value={value}
      placeholder={emptyLabel ?? L.pfNotDeclared}
      options={[
        ...(emptyLabel === undefined ? [] : [{ value: '', label: emptyLabel }]),
        ...withCurrentValue(options, value).map((option) => ({ value: option, label: option })),
        { value: CUSTOM_OPTION, label: L.pfCustomValue },
      ]}
      onValueChange={(next: string) => (next === CUSTOM_OPTION ? onCustom(true) : onValueChange(next))}
      style={S_CONTROL_STYLE}
    />
  );
}

function ExtraOptionRows({ rows, onChange }: {
  rows: ProfileOptionRow[];
  onChange: (next: ProfileOptionRow[]) => void;
}) {
  const L = useVocab();
  const patch = (i: number, part: Partial<ProfileOptionRow>) => {
    const next = rows.slice();
    next[i] = { ...next[i], ...part };
    onChange(next);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map((row, i) => (
        <div key={i} className="settings-key-value-fields">
          <input
            data-profile-option-key={i}
            value={row.key}
            placeholder={L.pfOptionKeyPlaceholder}
            onChange={(e) => patch(i, { key: e.target.value })}
            style={S_CONTROL_STYLE}
          />
          <input
            data-profile-option-value={i}
            value={row.value}
            placeholder={L.pfOptionValuePlaceholder}
            onChange={(e) => patch(i, { value: e.target.value })}
            style={S_CONTROL_STYLE}
          />
          <SLinkAction
            data-action="remove-option"
            tone="danger"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            {L.pfRemoveOption}
          </SLinkAction>
        </div>
      ))}
      <div>
        <SLinkAction data-action="add-option" onClick={() => onChange([...rows, { key: '', value: '' }])}>
          {L.pfAddOption}
        </SLinkAction>
      </div>
    </div>
  );
}

/** Preserved-but-not-editable state, stated outright so a save is never a silent deletion. */
function PreservedFields({ entry }: { entry: ConfigProfileEntry | null }) {
  const L = useVocab();
  const envValue = entry && entry.extraEnvKeys.length > 0 ? entry.extraEnvKeys.join(' · ') : L.pfNoExtraEnv;
  const fallbackValue = entry && entry.fallbackCount > 0 ? `${entry.fallbackCount} ${L.pfFallbackCount}` : '—';
  return (
    <SSection label={`${L.pfFieldExtraEnv} · ${L.pfFieldFallback}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{
          font: `400 12px/1.7 ${MONO}`, color: 'var(--proto-muted-2)',
          background: 'var(--proto-alt)', borderRadius: 'var(--r-control)', padding: '9px 12px',
        }}>
          <MonoKV k={L.pfFieldExtraEnv} value={envValue} />
          <MonoKV k={L.pfFieldFallback} value={fallbackValue} />
        </div>
        <SNotice tone="muted">{L.pfExtraEnvNote} {L.pfFallbackNote}</SNotice>
      </div>
    </SSection>
  );
}

function ProfileEditor({
  draft,
  creating,
  entry,
  errors,
  duplicateSource,
  catalog,
  catalogPending,
  onDraftChange,
  onBackendChange,
  onProviderChange,
}: {
  draft: ProfileFormState;
  creating: boolean;
  entry: ConfigProfileEntry | null;
  errors: ProfileFormErrors;
  duplicateSource: string | null;
  catalog: ModelCatalogSnapshot | null;
  catalogPending: boolean;
  onDraftChange: (next: ProfileFormState) => void;
  onBackendChange: (backend: ProfileBackend) => void;
  onProviderChange: (provider: string) => void;
}) {
  const L = useVocab();
  const set = (patch: Partial<ProfileFormState>) => onDraftChange({ ...draft, ...patch });
  const hint = (field: keyof typeof errors, fallback?: ReactNode) =>
    profileFieldErrorCopy(errors[field], L) ?? fallback;
  const tone = (field: keyof typeof errors) => (errors[field] ? ('danger' as const) : ('muted' as const));
  // Which fields the user has taken off the list. Editor-local: it is a way of typing, not a value,
  // so it never reaches the draft, the dirty check or the save.
  const [custom, setCustom] = useState<Record<ChoiceField, boolean>>({
    model: false, provider: false, mode: false,
  });
  const pickCustom = (field: ChoiceField) => (on: boolean) =>
    setCustom((previous) => ({ ...previous, [field]: on }));
  const choices = profileFieldChoices(catalog, draft);
  // Why a list is short, said where the list is — otherwise an empty dropdown looks like a bug.
  const listNote = (): ReactNode => {
    if (catalogPending) return L.pfCatalogPending;
    if (draft.backend === 'pi' && draft.provider.trim() === '') return L.pfPickProviderFirst;
    return choices.route?.source === 'gateway' ? L.pfRouteNotLoggedIn : undefined;
  };

  return (
    <>
      <SSection
        label={creating ? L.pfCreateTitle : L.pfEditTitle}
        action={duplicateSource === null ? undefined : (
          <SPill tone="neutral">{L.pfDuplicatedFrom} {duplicateSource}</SPill>
        )}
      >
        {duplicateSource === null ? null : (
          <div style={{ marginBottom: 10 }}>
            <SNotice tone="muted">{L.pfDuplicateDropsNote}</SNotice>
          </div>
        )}
        <SFieldRow
          label={L.pfFieldName}
          hint={hint('name', creating ? L.pfNameHint : L.pfNoRename)}
          hintTone={tone('name')}
        >
          <input
            data-profile-field="name"
            value={draft.name}
            disabled={!creating}
            onChange={(e) => set({ name: e.target.value })}
            style={creating ? S_CONTROL_STYLE : S_CONTROL_DISABLED_STYLE}
          />
        </SFieldRow>
        <SFieldRow label={L.pfFieldBackend}>
          <Select popupClassName="settings-surface settings-select-popup"
            data-profile-field="backend"
            aria-label={L.pfFieldBackend}
            value={draft.backend}
            options={PROFILE_BACKENDS.map((backend) => ({ value: backend, label: backend }))}
            onValueChange={onBackendChange}
            style={S_CONTROL_STYLE}
          />
        </SFieldRow>
        {/* provider first: it picks the endpoint, and the model and mode lists follow from it. */}
        <SFieldRow
          label={L.pfFieldProvider}
          hint={hint('provider', L.pfProviderHint)}
          hintTone={tone('provider')}
        >
          <ProfileChoice
            field="provider"
            label={L.pfFieldProvider}
            value={draft.provider}
            options={choices.provider}
            emptyLabel={L.pfNotDeclared}
            custom={custom.provider}
            onCustom={pickCustom('provider')}
            onValueChange={onProviderChange}
          />
        </SFieldRow>
        <SFieldRow
          label={L.pfFieldModel}
          hint={hint('model', listNote() ?? L.pfModelHint)}
          hintTone={tone('model')}
        >
          <ProfileChoice
            field="model"
            label={L.pfFieldModel}
            value={draft.model}
            options={choices.model}
            custom={custom.model}
            onCustom={pickCustom('model')}
            onValueChange={(model) => set({ model })}
          />
        </SFieldRow>
        <SFieldRow label={L.pfFieldMode} hint={hint('mode', L.pfModeHint)} hintTone={tone('mode')}>
          <ProfileChoice
            field="mode"
            label={L.pfFieldMode}
            value={draft.mode}
            options={choices.mode}
            emptyLabel={L.pfNotDeclared}
            custom={custom.mode}
            onCustom={pickCustom('mode')}
            onValueChange={(mode) => set({ mode })}
          />
        </SFieldRow>
        <SFieldRow label={L.pfFieldThinking} hint={hint('thinking')} hintTone={tone('thinking')}>
          <Select popupClassName="settings-surface settings-select-popup"
            data-profile-field="thinking"
            aria-label={L.pfFieldThinking}
            value={draft.thinking}
            options={[
              { value: '', label: L.pfNotDeclared },
              ...THINKING_LEVELS[draft.backend].map((level) => ({ value: level, label: level })),
            ]}
            onValueChange={(thinking) => set({ thinking })}
            style={S_CONTROL_STYLE}
          />
        </SFieldRow>
        {draft.backend === 'claude' ? (
          <SFieldRow label={L.pfFieldClaudeBackend}>
            <Select popupClassName="settings-surface settings-select-popup"
              data-profile-field="claudeBackend"
              aria-label={L.pfFieldClaudeBackend}
              value={draft.claudeBackend}
              options={[
                { value: '', label: L.pfPrintDefault },
                { value: 'print', label: 'print' },
                { value: 'tui', label: 'tui' },
              ]}
              onValueChange={(claudeBackend: ProfileFormState['claudeBackend']) => set({ claudeBackend })}
              style={S_CONTROL_STYLE}
            />
          </SFieldRow>
        ) : null}
        <SFieldRow label={L.pfFieldExtraOption} hint={hint('extraOption')} hintTone={tone('extraOption')}>
          <ExtraOptionRows rows={draft.extraOption} onChange={(extraOption) => set({ extraOption })} />
        </SFieldRow>
      </SSection>
      <PreservedFields entry={entry} />
    </>
  );
}

function EditorFooter({ p, savable }: { p: ProfilesPanelViewProps; savable: boolean }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      {p.dirty ? <SPill tone="amber">{L.pfDirty}</SPill> : null}
      <span style={{ marginLeft: 'auto' }} />
      {!p.creating ? (
        <SButton data-action="revert" tone="neutral" disabled={!p.dirty} onClick={p.onRevert}>
          {L.pfRevert}
        </SButton>
      ) : null}
      <SButton data-action="cancel-edit" tone="neutral" onClick={p.onCancelEdit}>
        {L.cancel}
      </SButton>
      <SButton data-action="save" tone="accent" disabled={!savable} onClick={p.onSave}>
        {L.pfSave}
      </SButton>
    </div>
  );
}

function ProfileEditorCard({ p }: { p: ProfilesPanelViewProps }) {
  if (p.draft === null) return null;
  const entry = p.editingName === null
    ? null
    : p.profileFacts.find((fact) => fact.profile.name === p.editingName)?.profile ?? null;
  const savable = p.dirty && isProfileFormValid(p.errors) && !p.savePending;
  return (
    <SCard style={{ padding: '16px 18px' }}>
      <div data-profile-editor="" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <ProfileEditor
          // A fresh editor per target: the "typed, not picked" flags belong to one editing session.
          key={p.creating ? 'create' : p.editingName ?? 'none'}
          draft={p.draft}
          creating={p.creating}
          entry={entry}
          errors={p.errors}
          duplicateSource={p.duplicateSource}
          catalog={p.catalog}
          catalogPending={p.catalogPending}
          onDraftChange={p.onDraftChange}
          onBackendChange={p.onBackendChange}
          onProviderChange={p.onProviderChange}
        />
        <EditorFooter p={p} savable={savable} />
      </div>
    </SCard>
  );
}

// ── the pure view ─────────────────────────────────────────────────────────────────────────────

export interface ProfilesPanelViewProps {
  snapshot: ConfigSnapshot;
  profileFacts: ProfileFact[];
  onSetDefaultProfile?: (name: string) => void;
  /** Non-null while an entry is being created or edited. */
  draft: ProfileFormState | null;
  /** Name the open create-draft was copied from; null for a blank one. */
  duplicateSource: string | null;
  /** What model / provider / mode may be picked from; null when the catalog has not been read. */
  catalog: ModelCatalogSnapshot | null;
  catalogPending: boolean;
  creating: boolean;
  editingName: string | null;
  /** The row whose delete is armed (deletion takes two clicks, like the hooks panel). */
  armedDelete: string | null;
  errors: ProfileFormErrors;
  dirty: boolean;
  savePending: boolean;
  removePendingName: string | null;
  onStartCreate: () => void;
  onStartDuplicate: (name: string) => void;
  onStartEdit: (name: string) => void;
  onCancelEdit: () => void;
  onDraftChange: (next: ProfileFormState) => void;
  onBackendChange: (backend: ProfileBackend) => void;
  onProviderChange: (provider: string) => void;
  onSave: () => void;
  onRevert: () => void;
  onArmDelete: (name: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (name: string) => void;
}

export function ProfilesPanelView(props: ProfilesPanelViewProps) {
  const names = props.profileFacts.map((fact) => fact.profile.name);
  // The default-profile picker is a REAL write when wired (config.set 'profiles' → re-points
  // profiles.json defaultProfile, read at each agent start). It can only SELECT an existing profile
  // (the option list is the real profiles.json rows), so it can never break startup. Inert when no
  // handler is passed (e.g. the pure render test).
  const canWrite = !!props.onSetDefaultProfile && names.length > 0;
  return (
    <div className="settings-profiles" data-settings-panel="profiles" style={PANEL_STACK}>
      <DefaultProfileRow
        current={props.snapshot.profiles?.defaultProfile ?? null}
        names={names}
        onPick={canWrite ? props.onSetDefaultProfile : undefined}
      />
      <ProfileTable p={props} />
      <ProfileEditorCard p={props} />
    </div>
  );
}

// ── container: adapts shared ownership to the desktop view ─────────────────────────────────────

export function ProfilesPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const profiles = useProfilesController(snapshot);
  return profiles.snapshot ? (
    <ProfilesPanelView
      snapshot={profiles.snapshot}
      profileFacts={profiles.profileFacts}
      onSetDefaultProfile={profiles.setDefault}
      draft={profiles.draft}
      duplicateSource={profiles.duplicateSource}
      catalog={profiles.catalog}
      catalogPending={profiles.catalogPending}
      creating={profiles.creating}
      editingName={profiles.creating ? null : profiles.editingName}
      armedDelete={profiles.confirmingDelete}
      errors={profiles.errors}
      dirty={profiles.dirty}
      savePending={profiles.savePending}
      removePendingName={profiles.removePendingName}
      onStartCreate={profiles.openCreate}
      onStartDuplicate={profiles.openDuplicate}
      onStartEdit={profiles.openEdit}
      onCancelEdit={profiles.closeDraft}
      onDraftChange={profiles.changeDraft}
      onBackendChange={profiles.changeBackend}
      onProviderChange={profiles.changeProvider}
      onSave={profiles.save}
      onRevert={profiles.revertDraft}
      onArmDelete={profiles.requestDelete}
      onCancelDelete={profiles.cancelDelete}
      onConfirmDelete={profiles.confirmDelete}
    />
  ) : null;
}
