// input:  shared profiles controller facts/actions, field-error copy and mobile controls
// output: mobile-specific Profiles list, native delete confirmation and CRUD editor
// pos:    Mobile Profiles settings screen and independent presentational view
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useNavigate } from 'react-router-dom';
import type { ConfigProfileEntry } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { MC } from '@/mobile/ui/kit';
import {
  PROFILE_BACKENDS, THINKING_LEVELS, isProfileFormValid, profileFieldErrorCopy,
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

function ProfileRow(props: {
  profile: ConfigProfileEntry; current: boolean;
  defaultPending: boolean; editPending: boolean; removePending: boolean;
  onDefault: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const L = useVocab();
  const sub = [props.profile.model, props.profile.backend, props.profile.thinking].filter(Boolean).join(' · ');
  return <MSettingsRow title={props.profile.name} sub={sub} trailing={
    <div style={{ display: 'flex', gap: 5 }}>
      {!props.current && <MSettingsButton disabled={props.defaultPending} onClick={props.onDefault}>{L.default}</MSettingsButton>}
      <MSettingsButton disabled={props.editPending} onClick={props.onEdit}>{L.pfEdit}</MSettingsButton>
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
  onChange: (draft: ProfileFormState) => void;
  onBackendChange: (backend: ProfileBackend) => void;
}) {
  const L = useVocab();
  const draft = props.state.draft;
  const set = <K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]) => props.onChange({ ...draft, [key]: value });
  const error = (field: keyof ProfileFormErrors) => profileFieldErrorCopy(props.errors[field], L);
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: 13 }}>
    <MSettingsField data-profile-field="name" label={L.pfFieldName} value={draft.name}
      disabled={props.state.mode === 'update'} error={error('name')}
      hint={props.state.mode === 'create' ? L.pfNameHint : L.pfNoRename}
      onChange={(event) => set('name', event.target.value)} />
    <MSettingsField data-profile-field="model" label={L.pfFieldModel} value={draft.model}
      error={error('model')} hint={L.pfModelHint} onChange={(event) => set('model', event.target.value)} />
    <MSettingsSelect data-profile-field="backend" label={L.pfFieldBackend} value={draft.backend}
      onChange={(event) => props.onBackendChange(event.target.value as ProfileBackend)}>
      {PROFILE_BACKENDS.map((backend) => <option key={backend}>{backend}</option>)}
    </MSettingsSelect>
    <MSettingsField data-profile-field="mode" label={L.pfFieldMode} value={draft.mode}
      error={error('mode')} hint={L.pfModeHint} onChange={(event) => set('mode', event.target.value)} />
    <MSettingsField data-profile-field="provider" label={L.pfFieldProvider} value={draft.provider}
      error={error('provider')} hint={L.pfProviderHint} onChange={(event) => set('provider', event.target.value)} />
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
  onChange: (draft: ProfileFormState) => void; onBackendChange: (backend: ProfileBackend) => void;
  onCancel: () => void; onSave: () => void;
}) {
  const L = useVocab();
  return <MSettingsCard title={props.state.mode === 'create' ? L.pfCreateTitle : L.pfEditTitle}>
    <ProfileFields state={props.state} errors={props.errors} onChange={props.onChange}
      onBackendChange={props.onBackendChange} />
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
    {editor && <MProfileEditor state={editor} errors={profiles.errors} pending={profiles.savePending}
      onChange={profiles.changeDraft} onBackendChange={profiles.changeBackend}
      onCancel={profiles.closeDraft} onSave={profiles.save} />}
    <MSettingsCard>{profiles.profileFacts.map((fact) => <ProfileRow key={fact.profile.name}
      profile={fact.profile} current={fact.current}
      defaultPending={profiles.defaultPendingName !== null} editPending={profiles.savePending}
      removePending={profiles.removePendingName !== null}
      onDefault={() => profiles.setDefault(fact.profile.name)} onEdit={() => profiles.openEdit(fact.profile.name)}
      onDelete={() => { if (window.confirm(`${L.pfDelete} ${fact.profile.name}?`)) profiles.confirmDelete(fact.profile.name); }} />)}
    </MSettingsCard>
  </MSettingsPage>;
}

export function MProfilesScreen() {
  const navigate = useNavigate();
  const controller = useProfilesController();
  return <MProfilesView controller={controller} onBack={() => navigate('/m/settings')} />;
}
