import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ConfigProfileEntry, ModelCatalogSnapshot } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { MC } from '@/mobile/ui/kit';
import {
  PROFILE_BACKENDS, THINKING_LEVELS, isProfileFormValid, profileFieldChoices,
  profileFieldErrorCopy, withCurrentValue,
  type ProfileBackend, type ProfileFormErrors, type ProfileFormState,
} from '@/features/settings/profiles-panel-vm';
import {
  useProfilesController, type ProfilesController,
} from '@/features/settings/useProfilesController';
import {
  MSettingsButton, MSettingsCard, MSettingsFeedback, MSettingsField,
  MSettingsPage, MSettingsRow, MSettingsSelect,
} from './MSettingsControls';

interface EditorState { mode: 'create' | 'update'; draft: ProfileFormState }

/** The three fields models.catalog can offer a list for; the rest are fixed sets or free text. */
type ChoiceField = 'model' | 'provider' | 'mode';

/** Sentinel option value — not a legal profile value (a safe name cannot hold a NUL). */
const CUSTOM_OPTION = '\u0000custom';

/**
 * One catalog-backed field: a native picker while the catalog has something to offer, a text box
 * when it does not or when the user asks for one. Picking is the point, but the escape is what
 * keeps every value profiles.json accepts writable from the phone too.
 */
function MProfileChoice(props: {
  field: ChoiceField;
  label: string;
  value: string;
  options: readonly string[];
  /** Label of the "" option. Omitted ⇒ the field has no legal empty value (model). */
  emptyLabel?: string;
  hint?: string;
  error?: string;
  custom: boolean;
  onCustom: (custom: boolean) => void;
  onValueChange: (value: string) => void;
}) {
  const L = useVocab();
  if (props.custom || props.options.length === 0) {
    return <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5 }}>
      <div style={{ flex: 1 }}>
        <MSettingsField data-profile-field={props.field} data-profile-choice="custom"
          label={props.label} value={props.value} hint={props.hint} error={props.error}
          onChange={(event) => props.onValueChange(event.target.value)} />
      </div>
      {props.options.length > 0 && <MSettingsButton onClick={() => props.onCustom(false)}>
        {L.pfPickFromList}</MSettingsButton>}
    </div>;
  }
  return <MSettingsSelect data-profile-field={props.field} data-profile-choice="select"
    label={props.label} value={props.value} hint={props.hint} error={props.error}
    onChange={(event) => event.target.value === CUSTOM_OPTION
      ? props.onCustom(true) : props.onValueChange(event.target.value)}>
    {props.emptyLabel !== undefined && <option value="">{props.emptyLabel}</option>}
    {withCurrentValue(props.options, props.value).map((option) => <option key={option}>{option}</option>)}
    <option value={CUSTOM_OPTION}>{L.pfCustomValue}</option>
  </MSettingsSelect>;
}

function ProfileRow(props: {
  profile: ConfigProfileEntry; current: boolean;
  defaultPending: boolean; editPending: boolean; removePending: boolean;
  onDefault: () => void; onEdit: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const L = useVocab();
  const sub = [props.profile.model, props.profile.backend, props.profile.thinking].filter(Boolean).join(' · ');
  return <MSettingsRow title={props.profile.name} sub={sub} trailing={
    <div style={{ display: 'flex', gap: 5 }}>
      {!props.current && <MSettingsButton disabled={props.defaultPending} onClick={props.onDefault}>{L.default}</MSettingsButton>}
      <MSettingsButton disabled={props.editPending} onClick={props.onEdit}>{L.pfEdit}</MSettingsButton>
      <MSettingsButton disabled={props.editPending} onClick={props.onDuplicate}>{L.pfDuplicate}</MSettingsButton>
      <MSettingsButton danger disabled={props.current || props.removePending} onClick={props.onDelete}>{L.pfDelete}</MSettingsButton>
    </div>} />;
}

function ExtraOptions(props: {
  draft: ProfileFormState;
  error?: string;
  onChange: (draft: ProfileFormState) => void;
}) {
  const L = useVocab();
  const update = (index: number, field: 'key' | 'value', value: string) => {
    const rows = props.draft.extraOption.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row);
    props.onChange({ ...props.draft, extraOption: rows });
  };
  return <div data-profile-extra-options style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
    {props.draft.extraOption.map((row, index) => <div key={index} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 5 }}>
      <MSettingsField data-profile-option-key={index} label={L.pfOptionKeyPlaceholder} value={row.key}
        onChange={(event) => update(index, 'key', event.target.value)} />
      <MSettingsField data-profile-option-value={index} label={L.pfOptionValuePlaceholder} value={row.value}
        onChange={(event) => update(index, 'value', event.target.value)} />
      <MSettingsButton danger onClick={() => props.onChange({ ...props.draft,
        extraOption: props.draft.extraOption.filter((_, rowIndex) => rowIndex !== index) })}>×</MSettingsButton>
    </div>)}
    <MSettingsButton onClick={() => props.onChange({ ...props.draft,
      extraOption: [...props.draft.extraOption, { key: '', value: '' }] })}>{L.pfAddOption}</MSettingsButton>
    <MSettingsFeedback error={props.error} />
  </div>;
}

function ProfileFields(props: {
  state: EditorState;
  errors: ProfileFormErrors;
  catalog: ModelCatalogSnapshot | null;
  catalogPending: boolean;
  onChange: (draft: ProfileFormState) => void;
  onBackendChange: (backend: ProfileBackend) => void;
  onProviderChange: (provider: string) => void;
}) {
  const L = useVocab();
  const draft = props.state.draft;
  const set = <K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]) => props.onChange({ ...draft, [key]: value });
  const error = (field: keyof ProfileFormErrors) => profileFieldErrorCopy(props.errors[field], L);
  // Taking a field off the list is a way of typing, not a value: it stays out of the draft.
  const [custom, setCustom] = useState<Record<ChoiceField, boolean>>({ model: false, provider: false, mode: false });
  const pickCustom = (field: ChoiceField) => (on: boolean) => setCustom((previous) => ({ ...previous, [field]: on }));
  const choices = profileFieldChoices(props.catalog, draft);
  // Why a list is short, said where the list is — an empty picker otherwise reads as a bug.
  const listNote = () => {
    if (props.catalogPending) return L.pfCatalogPending;
    if (draft.backend === 'pi' && draft.provider.trim() === '') return L.pfPickProviderFirst;
    return choices.route?.source === 'gateway' ? L.pfRouteNotLoggedIn : L.pfModelHint;
  };
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: 13 }}>
    <MSettingsField data-profile-field="name" label={L.pfFieldName} value={draft.name}
      disabled={props.state.mode === 'update'} error={error('name')}
      hint={props.state.mode === 'create' ? L.pfNameHint : L.pfNoRename}
      onChange={(event) => set('name', event.target.value)} />
    <MSettingsSelect data-profile-field="backend" label={L.pfFieldBackend} value={draft.backend}
      onChange={(event) => props.onBackendChange(event.target.value as ProfileBackend)}>
      {PROFILE_BACKENDS.map((backend) => <option key={backend}>{backend}</option>)}
    </MSettingsSelect>
    {/* provider first: it picks the endpoint, and the model and mode lists follow from it. */}
    <MProfileChoice field="provider" label={L.pfFieldProvider} value={draft.provider}
      options={choices.provider} emptyLabel={L.pfNotDeclared} hint={L.pfProviderHint}
      error={error('provider')} custom={custom.provider} onCustom={pickCustom('provider')}
      onValueChange={props.onProviderChange} />
    <MProfileChoice field="model" label={L.pfFieldModel} value={draft.model}
      options={choices.model} hint={listNote()} error={error('model')}
      custom={custom.model} onCustom={pickCustom('model')}
      onValueChange={(model) => set('model', model)} />
    <MProfileChoice field="mode" label={L.pfFieldMode} value={draft.mode}
      options={choices.mode} emptyLabel={L.pfNotDeclared} hint={L.pfModeHint} error={error('mode')}
      custom={custom.mode} onCustom={pickCustom('mode')}
      onValueChange={(mode) => set('mode', mode)} />
    <MSettingsSelect data-profile-field="thinking" label={L.pfFieldThinking} value={draft.thinking}
      error={error('thinking')} onChange={(event) => set('thinking', event.target.value)}>
      <option value="">{L.pfNotDeclared}</option>
      {THINKING_LEVELS[draft.backend].map((level) => <option key={level}>{level}</option>)}
    </MSettingsSelect>
    {draft.backend === 'claude' && <MSettingsSelect data-profile-field="claudeBackend"
      label={L.pfFieldClaudeBackend} value={draft.claudeBackend}
      onChange={(event) => set('claudeBackend', event.target.value as ProfileFormState['claudeBackend'])}>
      <option value="">{L.pfPrintDefault}</option><option value="print">print</option><option value="tui">tui</option>
    </MSettingsSelect>}
    <ExtraOptions draft={draft} error={error('extraOption')} onChange={props.onChange} />
  </div>;
}

export function MProfileEditor(props: {
  state: EditorState; errors: ProfileFormErrors; pending: boolean;
  duplicateSource?: string | null;
  catalog: ModelCatalogSnapshot | null; catalogPending: boolean;
  onChange: (draft: ProfileFormState) => void; onBackendChange: (backend: ProfileBackend) => void;
  onProviderChange: (provider: string) => void;
  onCancel: () => void; onSave: () => void;
}) {
  const L = useVocab();
  const title = props.state.mode === 'create' ? L.pfCreateTitle : L.pfEditTitle;
  return <MSettingsCard title={props.duplicateSource
    ? `${title} · ${L.pfDuplicatedFrom} ${props.duplicateSource}` : title}>
    {props.duplicateSource && <div data-profile-duplicate-note
      style={{ padding: '0 13px', fontSize: 11, color: MC.muted }}>{L.pfDuplicateDropsNote}</div>}
    <ProfileFields state={props.state} errors={props.errors} catalog={props.catalog}
      catalogPending={props.catalogPending} onChange={props.onChange}
      onBackendChange={props.onBackendChange} onProviderChange={props.onProviderChange} />
    <div style={{ display: 'flex', gap: 7, padding: '0 13px 13px' }}>
      <MSettingsButton onClick={props.onCancel}>{L.cancel}</MSettingsButton>
      <MSettingsButton disabled={!isProfileFormValid(props.errors) || props.pending} onClick={props.onSave}>{L.pfSave}</MSettingsButton>
    </div>
  </MSettingsCard>;
}

export function MProfilesView(props: { controller: ProfilesController; onBack: () => void }) {
  const L = useVocab();
  const profiles = props.controller;
  const page = (children: React.ReactNode) => <MSettingsPage title={L.stNavProfiles}
    onBack={props.onBack}>{children}</MSettingsPage>;
  if (profiles.loading) return page(<MSettingsCard><div style={{ padding: 13 }}>{L.stLoadingConfig}</div></MSettingsCard>);
  if (profiles.error) return page(<MSettingsCard><div style={{ padding: 13, color: MC.fail }}>{L.stFailedLoadConfig}</div></MSettingsCard>);
  const editor = profiles.draft ? {
    mode: profiles.creating ? 'create' as const : 'update' as const, draft: profiles.draft,
  } : null;
  return <MSettingsPage title={L.stNavProfiles} onBack={props.onBack}
    trailing={<MSettingsButton onClick={profiles.openCreate}>{L.pfNew}</MSettingsButton>}>
    {editor && <MProfileEditor
      // A fresh editor per target: the "typed, not picked" flags belong to one editing session.
      key={profiles.creating ? 'create' : profiles.editingName ?? 'none'}
      state={editor} errors={profiles.errors} pending={profiles.savePending}
      duplicateSource={profiles.duplicateSource}
      catalog={profiles.catalog} catalogPending={profiles.catalogPending}
      onChange={profiles.changeDraft} onBackendChange={profiles.changeBackend}
      onProviderChange={profiles.changeProvider}
      onCancel={profiles.closeDraft} onSave={profiles.save} />}
    <MSettingsCard>{profiles.profileFacts.map((fact) => <ProfileRow key={fact.profile.name}
      profile={fact.profile} current={fact.current}
      defaultPending={profiles.defaultPendingName !== null} editPending={profiles.savePending}
      removePending={profiles.removePendingName !== null}
      onDefault={() => profiles.setDefault(fact.profile.name)} onEdit={() => profiles.openEdit(fact.profile.name)}
      onDuplicate={() => profiles.openDuplicate(fact.profile.name)}
      onDelete={() => { if (window.confirm(`${L.pfDelete} ${fact.profile.name}?`)) profiles.confirmDelete(fact.profile.name); }} />)}
    </MSettingsCard>
  </MSettingsPage>;
}

export function MProfilesScreen() {
  const navigate = useNavigate();
  const controller = useProfilesController();
  return <MProfilesView controller={controller} onBack={() => navigate('/m/settings')} />;
}
