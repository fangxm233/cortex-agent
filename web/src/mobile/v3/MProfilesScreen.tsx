// input:  profile config snapshot, profile mutations and shared validation
// output: mobile default selection and profile CRUD editor
// pos:    Mobile Profiles settings screen
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
  emptyProfileForm, formStateFromEntry, isProfileFormValid, validateProfileForm,
  type ProfileFormState,
} from '@/features/settings/profiles-panel-vm';
import { MSettingsButton, MSettingsCard, MSettingsField, MSettingsPage, MSettingsRow, MSettingsSelect } from './MSettingsControls';

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

function ExtraOptions(props: { draft: ProfileFormState; onChange: (draft: ProfileFormState) => void }) {
  const L = useVocab();
  const update = (index: number, field: 'key' | 'value', value: string) => {
    const rows = props.draft.extraOption.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row);
    props.onChange({ ...props.draft, extraOption: rows });
  };
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
    {props.draft.extraOption.map((row, index) => <div key={index} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 5 }}>
      <MSettingsField label={L.pfOptionKeyPlaceholder} value={row.key} onChange={(event) => update(index, 'key', event.target.value)} />
      <MSettingsField label={L.pfOptionValuePlaceholder} value={row.value} onChange={(event) => update(index, 'value', event.target.value)} />
      <MSettingsButton danger onClick={() => props.onChange({ ...props.draft,
        extraOption: props.draft.extraOption.filter((_, rowIndex) => rowIndex !== index) })}>×</MSettingsButton>
    </div>)}
    <MSettingsButton onClick={() => props.onChange({ ...props.draft,
      extraOption: [...props.draft.extraOption, { key: '', value: '' }] })}>{L.pfAddOption}</MSettingsButton>
  </div>;
}

function ProfileFields(props: { state: EditorState; onChange: (draft: ProfileFormState) => void }) {
  const L = useVocab();
  const draft = props.state.draft;
  const set = <K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]) => props.onChange({ ...draft, [key]: value });
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: 13 }}>
    <MSettingsField label={L.pfFieldName} value={draft.name} disabled={props.state.mode === 'update'} onChange={(event) => set('name', event.target.value)} />
    <MSettingsField label={L.pfFieldModel} value={draft.model} onChange={(event) => set('model', event.target.value)} />
    <MSettingsSelect label={L.pfFieldBackend} value={draft.backend} onChange={(event) => set('backend', event.target.value as ProfileFormState['backend'])}>
      {PROFILE_BACKENDS.map((backend) => <option key={backend}>{backend}</option>)}
    </MSettingsSelect>
    <MSettingsField label={L.pfFieldMode} value={draft.mode} onChange={(event) => set('mode', event.target.value)} />
    <MSettingsField label={L.pfFieldProvider} value={draft.provider} onChange={(event) => set('provider', event.target.value)} />
    <MSettingsSelect label={L.pfFieldThinking} value={draft.thinking} onChange={(event) => set('thinking', event.target.value)}>
      <option value="">{L.pfNotDeclared}</option>
      {THINKING_LEVELS[draft.backend].map((level) => <option key={level}>{level}</option>)}
    </MSettingsSelect>
    {draft.backend === 'claude' && <MSettingsSelect label={L.pfFieldClaudeBackend} value={draft.claudeBackend}
      onChange={(event) => set('claudeBackend', event.target.value as ProfileFormState['claudeBackend'])}>
      <option value="">{L.pfPrintDefault}</option><option value="print">print</option><option value="tui">tui</option>
    </MSettingsSelect>}
    <ExtraOptions draft={draft} onChange={props.onChange} />
  </div>;
}

function ProfileEditor(props: {
  state: EditorState; names: string[]; pending: boolean;
  onChange: (draft: ProfileFormState) => void; onCancel: () => void; onSave: () => void;
}) {
  const L = useVocab();
  const errors = validateProfileForm(props.state.draft, { mode: props.state.mode, existingNames: props.names });
  return <MSettingsCard title={props.state.mode === 'create' ? L.pfCreateTitle : L.pfEditTitle}
    note={Object.keys(errors).length > 0 ? L.pfNameHint : undefined}>
    <ProfileFields state={props.state} onChange={props.onChange} />
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
    {editor && <ProfileEditor state={editor} names={profiles.map((profile) => profile.name)} pending={pending}
      onChange={(draft) => setEditor({ ...editor, draft })} onCancel={() => setEditor(null)} onSave={save} />}
    <MSettingsCard>{profiles.map((profile) => <ProfileRow key={profile.name} profile={profile}
      current={profile.name === current} pending={pending}
      onDefault={() => setDefault.mutate({ section: 'profiles', value: { defaultProfile: profile.name } })}
      onEdit={() => setEditor({ mode: 'update', draft: formStateFromEntry(profile) })}
      onDelete={() => { if (window.confirm(`${L.pfDelete} ${profile.name}?`)) remove.mutate({ name: profile.name }); }} />)}</MSettingsCard>
  </MSettingsPage>;
}
