// input:  shared profiles controller facts/actions, profile error copy and desktop controls
// output: profile table with desktop-specific action gates and validated CRUD editor
// pos:    Desktop Profiles settings view and controller adapter
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { CSSProperties, ReactNode } from 'react';
import type { ConfigProfileEntry, ConfigSnapshot } from '@cortex-agent/ui-contract';
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
  profileFieldErrorCopy,
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
// No optimistic updates: every mutation invalidates config.get and reports through a toast.

const MONO = "'IBM Plex Mono',monospace";

const TH: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: '.05em',
  color: 'var(--proto-muted-3)',
};

const GRID = '84px 1fr 66px 52px 58px 118px';

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

function ProfileEditor({
  draft,
  creating,
  entry,
  errors,
  onDraftChange,
  onBackendChange,
}: {
  draft: ProfileFormState;
  creating: boolean;
  entry: ConfigProfileEntry | null;
  errors: ProfileFormErrors;
  onDraftChange: (next: ProfileFormState) => void;
  onBackendChange: (backend: ProfileBackend) => void;
}) {
  const L = useVocab();
  const set = (patch: Partial<ProfileFormState>) => onDraftChange({ ...draft, ...patch });
  const hint = (field: keyof typeof errors, fallback?: ReactNode) =>
    profileFieldErrorCopy(errors[field], L) ?? fallback;
  const tone = (field: keyof typeof errors) => (errors[field] ? ('danger' as const) : ('muted' as const));

  return (
    <>
      <SSectionLabel>{creating ? L.pfCreateTitle : L.pfEditTitle}</SSectionLabel>
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
      <SFieldRow label={L.pfFieldModel} hint={hint('model', L.pfModelHint)} hintTone={tone('model')}>
        <input
          data-profile-field="model"
          value={draft.model}
          onChange={(e) => set({ model: e.target.value })}
          style={S_CONTROL_STYLE}
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
      <SFieldRow label={L.pfFieldMode} hint={hint('mode', L.pfModeHint)} hintTone={tone('mode')}>
        <input
          data-profile-field="mode"
          value={draft.mode}
          onChange={(e) => set({ mode: e.target.value })}
          style={S_CONTROL_STYLE}
        />
      </SFieldRow>
      <SFieldRow
        label={L.pfFieldProvider}
        hint={hint('provider', L.pfProviderHint)}
        hintTone={tone('provider')}
      >
        <input
          data-profile-field="provider"
          value={draft.provider}
          onChange={(e) => set({ provider: e.target.value })}
          style={S_CONTROL_STYLE}
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
  creating: boolean;
  editingName: string | null;
  /** The row whose delete is armed (deletion takes two clicks, like the hooks panel). */
  armedDelete: string | null;
  errors: ProfileFormErrors;
  dirty: boolean;
  savePending: boolean;
  removePendingName: string | null;
  onStartCreate: () => void;
  onStartEdit: (name: string) => void;
  onCancelEdit: () => void;
  onDraftChange: (next: ProfileFormState) => void;
  onBackendChange: (backend: ProfileBackend) => void;
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
              borderRadius: 7,
              padding: '4px 10px',
              background: 'var(--proto-card)',
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
              borderRadius: 7,
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
                        borderRadius: 999,
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
            draft={props.draft}
            creating={props.creating}
            entry={entry}
            errors={props.errors}
            onDraftChange={props.onDraftChange}
            onBackendChange={props.onBackendChange}
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
      creating={profiles.creating}
      editingName={profiles.creating ? null : profiles.editingName}
      armedDelete={profiles.confirmingDelete}
      errors={profiles.errors}
      dirty={profiles.dirty}
      savePending={profiles.savePending}
      removePendingName={profiles.removePendingName}
      onStartCreate={profiles.openCreate}
      onStartEdit={profiles.openEdit}
      onCancelEdit={profiles.closeDraft}
      onDraftChange={profiles.changeDraft}
      onBackendChange={profiles.changeBackend}
      onSave={profiles.save}
      onRevert={profiles.revertDraft}
      onArmDelete={profiles.requestDelete}
      onCancelDelete={profiles.cancelDelete}
      onConfirmDelete={profiles.confirmDelete}
    />
  ) : null;
}
