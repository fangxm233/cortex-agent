import { useState, type CSSProperties, type ReactNode } from 'react';
import type { ConfigProfileEntry, ConfigSnapshot, ModelCatalogSnapshot } from '@cortex-agent/ui-contract';
import { Select } from '@/design';
import { useVocab } from '@/i18n';
import {
  MonoKV,
  SButton,
  SCard,
  SFieldRow,
  SSectionLabel,
  S_CONTROL_DISABLED_STYLE,
  S_CONTROL_STYLE,
} from './settings-ui';
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
} from './profiles-panel-vm';
import { useProfilesController, type ProfileFact } from './useProfilesController';

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

const TH: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: '.05em',
  color: 'var(--proto-muted-3)',
};

const GRID = '84px 1fr 66px 52px 58px 170px';

function RowAction({
  children,
  onClick,
  tone,
  title,
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'danger';
  title?: string;
} & Record<string, unknown>) {
  const active = !!onClick;
  return (
    <span
      {...rest}
      onClick={onClick}
      role={active ? 'button' : undefined}
      title={title}
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        color: !active
          ? 'var(--proto-faint)'
          : tone === 'danger'
            ? 'var(--proto-danger)'
            : 'var(--proto-accent)',
        cursor: active ? 'pointer' : 'not-allowed',
      }}
    >
      {children}
    </span>
  );
}

function Cell({ value, dim }: { value: string | null; dim?: boolean }) {
  return (
    <span
      style={{
        font: `400 10px ${MONO}`,
        color: value && !dim ? 'var(--proto-ink)' : 'var(--proto-faint)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        paddingRight: 8,
      }}
    >
      {value ?? '—'}
    </span>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          data-profile-field={field}
          data-profile-choice="custom"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          style={S_CONTROL_STYLE}
        />
        {options.length > 0 ? (
          <RowAction data-action={`list-${field}`} onClick={() => onCustom(false)}>
            {L.pfPickFromList}
          </RowAction>
        ) : null}
      </div>
    );
  }
  return (
    <Select
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
      <SSectionLabel>
        {creating ? L.pfCreateTitle : L.pfEditTitle}
        {duplicateSource === null ? null : ` · ${L.pfDuplicatedFrom} ${duplicateSource}`}
      </SSectionLabel>
      {duplicateSource === null ? null : (
        <div style={{ fontSize: 9.5, lineHeight: 1.7, color: 'var(--proto-faint)' }}>
          {L.pfDuplicateDropsNote}
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
        <Select
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
        <Select
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
          <Select
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {draft.extraOption.map((row, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                data-profile-option-key={i}
                value={row.key}
                placeholder={L.pfOptionKeyPlaceholder}
                onChange={(e) => {
                  const next = draft.extraOption.slice();
                  next[i] = { ...next[i], key: e.target.value };
                  set({ extraOption: next });
                }}
                style={{ ...S_CONTROL_STYLE, width: 140, flex: 'none' }}
              />
              <input
                data-profile-option-value={i}
                value={row.value}
                placeholder={L.pfOptionValuePlaceholder}
                onChange={(e) => {
                  const next = draft.extraOption.slice();
                  next[i] = { ...next[i], value: e.target.value };
                  set({ extraOption: next });
                }}
                style={S_CONTROL_STYLE}
              />
              <RowAction
                data-action="remove-option"
                tone="danger"
                onClick={() => set({ extraOption: draft.extraOption.filter((_, j) => j !== i) })}
              >
                {L.pfRemoveOption}
              </RowAction>
            </div>
          ))}
          <RowAction
            data-action="add-option"
            onClick={() => set({ extraOption: [...draft.extraOption, { key: '', value: '' }] })}
          >
            {L.pfAddOption}
          </RowAction>
        </div>
      </SFieldRow>

      {/* Preserved-but-not-editable state, stated outright so a save is never a silent deletion. */}
      <SSectionLabel>{L.pfFieldExtraEnv} · {L.pfFieldFallback}</SSectionLabel>
      <div style={{ font: `400 10px/2 ${MONO}`, color: 'var(--proto-muted)' }}>
        <MonoKV
          k={L.pfFieldExtraEnv}
          value={entry && entry.extraEnvKeys.length > 0 ? entry.extraEnvKeys.join(' · ') : L.pfNoExtraEnv}
        />
        <MonoKV
          k={L.pfFieldFallback}
          value={entry && entry.fallbackCount > 0 ? `${entry.fallbackCount} ${L.pfFallbackCount}` : '—'}
        />
      </div>
      <div style={{ fontSize: 9.5, lineHeight: 1.7, color: 'var(--proto-faint)', marginTop: 4 }}>
        {L.pfExtraEnvNote} {L.pfFallbackNote}
      </div>
    </>
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
  const L = useVocab();
  const p = props.snapshot.profiles;
  const rows = props.profileFacts.map(fact => fact.profile);
  // The default-profile picker is a REAL write when wired (config.set 'profiles' → re-points
  // profiles.json defaultProfile, read at each agent start). It can only SELECT an existing profile
  // (the option list is the real profiles.json rows), so it can never break startup. Inert when no
  // handler is passed (e.g. the pure render test).
  const canWrite = !!props.onSetDefaultProfile && rows.length > 0;
  const editing = props.draft !== null;
  const entry = props.editingName === null ? null : rows.find((r) => r.name === props.editingName) ?? null;
  const savable = editing && props.dirty && isProfileFormValid(props.errors) && !props.savePending;

  return (
    <div data-settings-panel="profiles">
      <SCard
        style={{
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--proto-muted)' }}>{L.stDefaultProfile}</span>
        {canWrite ? (
          <Select
            data-default-profile-select
            aria-label={L.stDefaultProfile}
            value={p?.defaultProfile ?? ''}
            options={rows.map((row) => ({ value: row.name, label: row.name }))}
            onValueChange={props.onSetDefaultProfile!}
            style={{
              font: `600 11px ${MONO}`,
              color: 'var(--proto-ink)',
              border: '1px solid var(--proto-line)',
              borderRadius: 'var(--r-chip)',
              padding: '4px 10px',
              background: 'var(--glass-2)',
              cursor: 'pointer',
            }}
          />
        ) : (
          <span
            title="Select a profile to write profiles.json defaultProfile"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              border: '1px solid var(--proto-line)',
              borderRadius: 'var(--r-chip)',
              padding: '4px 10px',
            }}
          >
            <span style={{ font: `600 11px ${MONO}`, color: 'var(--proto-ink)' }}>{p?.defaultProfile ?? '—'}</span>
            <span style={{ color: 'var(--proto-muted-3)', fontSize: 8 }}>▾</span>
          </span>
        )}
        <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: 'var(--proto-faint)' }}>
          {L.stProfReadNote}
        </span>
      </SCard>

      <SCard style={{ marginTop: 12, overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: GRID,
            padding: '7px 14px',
            borderBottom: '1px solid var(--proto-line-soft)',
            ...TH,
          }}
        >
          <span>{L.stColName}</span>
          <span>{L.stColModel}</span>
          <span>{L.stColBackend}</span>
          <span>{L.stColMode}</span>
          <span>{L.stColThinking}</span>
          <span style={{ textAlign: 'right' }}>
            <RowAction
              data-action="new-profile"
              onClick={editing ? undefined : props.onStartCreate}
            >
              {L.pfNew}
            </RowAction>
          </span>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--proto-muted-3)' }}>
            {L.stNoProfiles}
          </div>
        ) : (
          props.profileFacts.map((fact, i) => {
            const r = fact.profile;
            const isDefault = fact.current;
            const armed = props.armedDelete === r.name;
            const busy = editing;
            const removePending = props.removePendingName !== null;
            return (
              <div
                key={r.name}
                data-profile-row={r.name}
                style={{
                  display: 'grid',
                  gridTemplateColumns: GRID,
                  padding: '9px 14px',
                  borderBottom: i < rows.length - 1 ? '1px solid var(--proto-alt)' : undefined,
                  alignItems: 'center',
                  background: props.editingName === r.name ? 'var(--proto-accent-bg)' : undefined,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ font: `600 10.5px ${MONO}`, color: 'var(--proto-ink-2)' }}>{r.name}</span>
                  {isDefault ? (
                    <span
                      style={{
                        fontSize: 8,
                        fontWeight: 600,
                        padding: '1px 4px',
                        borderRadius: 'var(--r-pill)',
                        background: 'var(--proto-accent-bg)',
                        color: 'var(--proto-accent)',
                      }}
                    >
                      {L.default}
                    </span>
                  ) : null}
                </span>
                <Cell value={r.model} dim />
                <Cell value={r.backend} dim />
                <Cell value={r.mode} />
                <Cell value={r.thinking} />
                <span style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  {armed ? (
                    <>
                      <RowAction data-action="cancel-delete" onClick={props.onCancelDelete}>
                        {L.cancel}
                      </RowAction>
                      <RowAction
                        data-action="confirm-delete"
                        tone="danger"
                        onClick={props.removePendingName === r.name ? undefined : () => props.onConfirmDelete(r.name)}
                      >
                        {L.pfConfirmDelete}
                      </RowAction>
                    </>
                  ) : (
                    <>
                      <RowAction data-action="edit" onClick={busy ? undefined : () => props.onStartEdit(r.name)}>
                        {L.pfEdit}
                      </RowAction>
                      <RowAction
                        data-action="duplicate"
                        onClick={busy ? undefined : () => props.onStartDuplicate(r.name)}
                      >
                        {L.pfDuplicate}
                      </RowAction>
                      <RowAction
                        data-action="delete"
                        data-delete-blocked={isDefault ? '' : undefined}
                        tone="danger"
                        title={isDefault ? L.pfDeleteDefaultBlocked : undefined}
                        onClick={busy || removePending || !fact.canDelete ? undefined : () => props.onArmDelete(r.name)}
                      >
                        {L.pfDelete}
                      </RowAction>
                    </>
                  )}
                </span>
              </div>
            );
          })
        )}
      </SCard>

      {props.draft !== null ? (
        <SCard style={{ marginTop: 12, padding: '4px 14px 12px' }}>
          <div data-profile-editor="" />
          <ProfileEditor
            // A fresh editor per target: the "typed, not picked" flags belong to one editing session.
            key={props.creating ? 'create' : props.editingName ?? 'none'}
            draft={props.draft}
            creating={props.creating}
            entry={entry}
            errors={props.errors}
            duplicateSource={props.duplicateSource}
            catalog={props.catalog}
            catalogPending={props.catalogPending}
            onDraftChange={props.onDraftChange}
            onBackendChange={props.onBackendChange}
            onProviderChange={props.onProviderChange}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            {props.dirty ? (
              <span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--proto-amber)' }}>{L.pfDirty}</span>
            ) : null}
            <span style={{ marginLeft: 'auto' }} />
            {!props.creating ? (
              <SButton data-action="revert" tone="neutral" disabled={!props.dirty} onClick={props.onRevert}>
                {L.pfRevert}
              </SButton>
            ) : null}
            <SButton data-action="cancel-edit" tone="neutral" onClick={props.onCancelEdit}>
              {L.cancel}
            </SButton>
            <SButton data-action="save" tone="accent" disabled={!savable} onClick={props.onSave}>
              {L.pfSave}
            </SButton>
          </div>
        </SCard>
      ) : null}
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
