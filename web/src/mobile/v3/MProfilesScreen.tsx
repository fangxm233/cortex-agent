// input:  profile config, mutations, shared transitions and field-error copy
// output: mobile default selection and field-validated profile CRUD editor
// pos:    Mobile Profiles settings screen and presentational editor
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigProfileEntry } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { MC } from '@/mobile/ui/kit';
import {
  PROFILE_BACKENDS, THINKING_LEVELS, buildProfileCreateArgs, buildProfileUpdateArgs,
  emptyProfileForm, formStateFromEntry, isProfileFormValid, profileFieldErrorCopy,
  transitionProfileBackend, validateProfileForm, type ProfileFormErrors, type ProfileFormState,
} from '@/features/settings/profiles-panel-vm';
import {
  MSettingsButton, MSettingsCard, MSettingsFeedback, MSettingsField,
  MSettingsPage, MSettingsRow, MSettingsSelect,
} from './MSettingsControls';

interface EditorState { mode: 'create' | 'update'; draft: ProfileFormState }

function ProfileRow(props: {
  profile: ConfigProfileEntry; current: boolean; pending: boolean;
  onDefault: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const L = useVocab();
  const sub = [props.profile.model, props.profile.backend, props.profile.thinking].filter(Boolean).join(' · ');
  return <MSettingsRow title={props.profile.name} sub={sub} trailing={
    <div style={{ display: 'flex', gap: 5 }}>
      {!props.current && <MSettingsButton disabled={props.pending} onClick={props.onDefault}>{L.default}</MSettingsButton>}
      <MSettingsButton disabled={props.pending} onClick={props.onEdit}>{L.pfEdit}</MSettingsButton>
      <MSettingsButton danger disabled={props.current || props.pending} onClick={props.onDelete}>{L.pfDelete}</MSettingsButton>
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
      onChange={(event) => props.onChange(transitionProfileBackend(draft, event.target.value as ProfileFormState['backend']))}>
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
  state: EditorState; names: string[]; pending: boolean;
  onChange: (draft: ProfileFormState) => void; onCancel: () => void; onSave: () => void;
}) {
  const L = useVocab();
  const errors = validateProfileForm(props.state.draft, { mode: props.state.mode, existingNames: props.names });
  return <MSettingsCard title={props.state.mode === 'create' ? L.pfCreateTitle : L.pfEditTitle}>
    <ProfileFields state={props.state} errors={errors} onChange={props.onChange} />
    <div style={{ display: 'flex', gap: 7, padding: '0 13px 13px' }}>
      <MSettingsButton onClick={props.onCancel}>{L.cancel}</MSettingsButton>
      <MSettingsButton disabled={!isProfileFormValid(errors) || props.pending} onClick={props.onSave}>{L.pfSave}</MSettingsButton>
    </div>
  </MSettingsCard>;
}

export function MProfilesScreen() {
  const L = useVocab();
  const trpc = useTRPC();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { toast } = useToast();
  const query = useQuery(trpc.config.get.queryOptions({}));
  const [editor, setEditor] = useState<EditorState | null>(null);
  const refresh = () => client.invalidateQueries(trpc.config.get.queryFilter({}));
  const failed = (error: { message: string }) => toast({ title: `${L.pfToastWriteFailed}: ${error.message}`, tone: 'failed' });
  const create = useMutation(trpc.profiles.create.mutationOptions({
    onSuccess: () => { refresh(); setEditor(null); toast({ title: L.pfToastCreated, tone: 'done' }); },
    onError: failed,
  }));
  const update = useMutation(trpc.profiles.update.mutationOptions({
    onSuccess: () => { refresh(); setEditor(null); toast({ title: L.pfToastSaved, tone: 'done' }); },
    onError: failed,
  }));
  const remove = useMutation(trpc.profiles.remove.mutationOptions({
    onSuccess: () => { refresh(); setEditor(null); toast({ title: L.pfToastDeleted, tone: 'done' }); },
    onError: failed,
  }));
  const setDefault = useMutation(trpc.config.set.mutationOptions({
    onSuccess: () => { refresh(); toast({ title: L.pfToastSaved, tone: 'done' }); },
    onError: failed,
  }));
  const profiles = query.data?.profiles?.profiles ?? [];
  const current = query.data?.profiles?.defaultProfile ?? null;
  const pending = create.isPending || update.isPending || remove.isPending || setDefault.isPending;
  const save = () => { if (!editor) return; editor.mode === 'create'
    ? create.mutate(buildProfileCreateArgs(editor.draft)) : update.mutate(buildProfileUpdateArgs(editor.draft)); };
  const page = (children: ReactNode) => <MSettingsPage title={L.stNavProfiles}
    onBack={() => navigate('/m/settings')}>{children}</MSettingsPage>;
  if (query.isLoading) return page(<MSettingsCard><div style={{ padding: 13 }}>{L.stLoadingConfig}</div></MSettingsCard>);
  if (query.isError) return page(<MSettingsCard><div style={{ padding: 13, color: MC.fail }}>{L.stFailedLoadConfig}</div></MSettingsCard>);
  return <MSettingsPage title={L.stNavProfiles} onBack={() => navigate('/m/settings')}
    trailing={<MSettingsButton onClick={() => setEditor({ mode: 'create', draft: emptyProfileForm() })}>{L.pfNew}</MSettingsButton>}>
    {editor && <MProfileEditor state={editor} names={profiles.map((profile) => profile.name)} pending={pending}
      onChange={(draft) => setEditor({ ...editor, draft })} onCancel={() => setEditor(null)} onSave={save} />}
    <MSettingsCard>{profiles.map((profile) => <ProfileRow key={profile.name} profile={profile}
      current={profile.name === current} pending={pending}
      onDefault={() => setDefault.mutate({ section: 'profiles', value: { defaultProfile: profile.name } })}
      onEdit={() => setEditor({ mode: 'update', draft: formStateFromEntry(profile) })}
      onDelete={() => { if (window.confirm(`${L.pfDelete} ${profile.name}?`)) remove.mutate({ name: profile.name }); }} />)}</MSettingsCard>
  </MSettingsPage>;
}
