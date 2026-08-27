// input:  config.get/profile mutations, canonical profile VM, query cache and toast feedback
// output: shared profile facts, editor lifecycle, validation, confirmations and operation-local pending
// pos:    Cross-surface profiles settings controller
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigProfileEntry, ConfigSetArgs, ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import {
  buildProfileCreateArgs,
  buildProfileUpdateArgs,
  emptyProfileForm,
  formStateFromEntry,
  isProfileFormDirty,
  isProfileFormValid,
  transitionProfileBackend,
  validateProfileForm,
  type ProfileBackend,
  type ProfileFormErrors,
  type ProfileFormState,
} from './profiles-panel-vm';

export interface ProfileFact {
  profile: ConfigProfileEntry;
  current: boolean;
  canSetDefault: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export interface ProfilesController {
  snapshot: ConfigSnapshot | undefined;
  loading: boolean;
  error: { message: string } | null;
  profiles: ConfigProfileEntry[];
  profileFacts: ProfileFact[];
  defaultProfile: string | null;
  draft: ProfileFormState | null;
  creating: boolean;
  editingName: string | null;
  errors: ProfileFormErrors;
  dirty: boolean;
  confirmingDelete: string | null;
  createPending: boolean;
  updatePending: boolean;
  savePending: boolean;
  removePendingName: string | null;
  defaultPendingName: string | null;
  openCreate: () => void;
  openEdit: (name: string) => void;
  changeDraft: (draft: ProfileFormState) => void;
  changeBackend: (backend: ProfileBackend) => void;
  closeDraft: () => void;
  revertDraft: () => void;
  save: () => void;
  setDefault: (name: string) => void;
  requestDelete: (name: string) => void;
  cancelDelete: () => void;
  confirmDelete: (name: string) => void;
}

function buildProfileFacts(profiles: ConfigProfileEntry[], current: string | null): ProfileFact[] {
  return profiles.map(profile => ({
    profile,
    current: profile.name === current,
    canSetDefault: profile.name !== current,
    canEdit: true,
    canDelete: profile.name !== current,
  }));
}

function useProfileEditor(profiles: ConfigProfileEntry[], clearDelete: () => void) {
  const [mode, setMode] = useState<'create' | 'update' | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [edits, setEdits] = useState<ProfileFormState | null>(null);
  const [createDraft, setCreateDraft] = useState(emptyProfileForm);
  const entry = editingName ? profiles.find(profile => profile.name === editingName) ?? null : null;
  const draft = mode === 'create' ? createDraft : mode === 'update' && entry ? edits ?? formStateFromEntry(entry) : null;
  const close = () => { setMode(null); setEditingName(null); setEdits(null); setCreateDraft(emptyProfileForm()); };
  const openCreate = () => {
    clearDelete(); setMode('create'); setEditingName(null); setEdits(null); setCreateDraft(emptyProfileForm());
  };
  const openEdit = (name: string) => {
    if (!profiles.some(profile => profile.name === name)) return;
    clearDelete(); setMode('update'); setEditingName(name); setEdits(null);
  };
  const change = (next: ProfileFormState) => mode === 'create' ? setCreateDraft(next) : setEdits(next);
  return { mode, editingName, entry, draft, close, openCreate, openEdit, change, revert: () => setEdits(null) };
}

function useProfileWriteEffects(closeDraft: () => void, clearDelete: () => void) {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const refresh = () => void queryClient.invalidateQueries(trpc.config.get.queryFilter({}));
  const failed = (error: { message: string }) => {
    toast({ title: `${L.pfToastWriteFailed}: ${error.message}`, tone: 'failed' });
  };
  return {
    created: (data: { name: string }) => { refresh(); closeDraft(); toast({ title: `${L.pfToastCreated} · ${data.name}`, tone: 'done' }); },
    updated: (data: { changed: boolean }) => { refresh(); closeDraft(); toast({ title: data.changed ? L.pfToastSaved : L.pfToastUnchanged, tone: 'done' }); },
    removed: () => { refresh(); clearDelete(); closeDraft(); toast({ title: L.pfToastDeleted, tone: 'done' }); },
    defaulted: (_data: unknown, vars: ConfigSetArgs) => {
      if (vars.section !== 'profiles') return;
      refresh(); toast({ title: `${L.stDefaultProfile} → ${vars.value.defaultProfile} · ${L.stToastDefaultProfile}`, tone: 'done' });
    },
    removeFailed: (error: { message: string }) => { clearDelete(); failed(error); },
    failed,
  };
}

function useProfileWrites(closeDraft: () => void, clearDelete: () => void) {
  const trpc = useTRPC();
  const effects = useProfileWriteEffects(closeDraft, clearDelete);
  const create = useMutation(trpc.profiles.create.mutationOptions({
    onSuccess: effects.created, onError: effects.failed,
  }));
  const update = useMutation(trpc.profiles.update.mutationOptions({
    onSuccess: effects.updated, onError: effects.failed,
  }));
  const remove = useMutation(trpc.profiles.remove.mutationOptions({
    onSuccess: effects.removed, onError: effects.removeFailed,
  }));
  const setDefault = useMutation(trpc.config.set.mutationOptions({
    onSuccess: effects.defaulted, onError: effects.failed,
  }));
  return { create, update, remove, setDefault };
}

function defaultProfileVariable(vars: ConfigSetArgs | undefined): string | null {
  return vars?.section === 'profiles' ? vars.value.defaultProfile : null;
}

function useProfileActions(
  facts: ProfileFact[], editor: ReturnType<typeof useProfileEditor>,
  writes: ReturnType<typeof useProfileWrites>, errors: ProfileFormErrors,
  setConfirmingDelete: (name: string | null) => void,
) {
  const allowed = (name: string, action: 'canSetDefault' | 'canDelete') =>
    facts.some(fact => fact.profile.name === name && fact[action]);
  const save = () => {
    if (!editor.draft || !isProfileFormValid(errors)) return;
    if (editor.mode === 'create' && !writes.create.isPending) writes.create.mutate(buildProfileCreateArgs(editor.draft));
    if (editor.mode === 'update' && !writes.update.isPending) writes.update.mutate(buildProfileUpdateArgs(editor.draft));
  };
  const setDefault = (name: string) => {
    if (allowed(name, 'canSetDefault') && !writes.setDefault.isPending) {
      writes.setDefault.mutate({ section: 'profiles', value: { defaultProfile: name } });
    }
  };
  const requestDelete = (name: string) => {
    if (allowed(name, 'canDelete') && !writes.remove.isPending) setConfirmingDelete(name);
  };
  const confirmDelete = (name: string) => {
    if (allowed(name, 'canDelete') && !writes.remove.isPending) writes.remove.mutate({ name });
  };
  const changeBackend = (backend: ProfileBackend) => {
    if (editor.draft) editor.change(transitionProfileBackend(editor.draft, backend));
  };
  return { save, setDefault, requestDelete, confirmDelete, changeBackend };
}

export function useProfilesController(initialSnapshot?: ConfigSnapshot): ProfilesController {
  const trpc = useTRPC();
  const options = trpc.config.get.queryOptions({});
  const config = useQuery(initialSnapshot ? { ...options, initialData: initialSnapshot } : options);
  const profiles = config.data?.profiles?.profiles ?? [];
  const defaultProfile = config.data?.profiles?.defaultProfile ?? null;
  const facts = buildProfileFacts(profiles, defaultProfile);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const editor = useProfileEditor(profiles, () => setConfirmingDelete(null));
  const writes = useProfileWrites(editor.close, () => setConfirmingDelete(null));
  const errors = editor.draft ? validateProfileForm(editor.draft, {
    mode: editor.mode === 'create' ? 'create' : 'update', existingNames: profiles.map(profile => profile.name),
  }) : {};
  const dirty = !!editor.draft && (editor.mode === 'create' || !!editor.entry && isProfileFormDirty(editor.draft, editor.entry));
  const actions = useProfileActions(facts, editor, writes, errors, setConfirmingDelete);
  return {
    snapshot: config.data, loading: config.isLoading, error: config.error,
    profiles, profileFacts: facts, defaultProfile,
    draft: editor.draft, creating: editor.mode === 'create', editingName: editor.editingName,
    errors, dirty, confirmingDelete,
    createPending: writes.create.isPending, updatePending: writes.update.isPending,
    savePending: writes.create.isPending || writes.update.isPending,
    removePendingName: writes.remove.isPending ? writes.remove.variables?.name ?? null : null,
    defaultPendingName: writes.setDefault.isPending ? defaultProfileVariable(writes.setDefault.variables) : null,
    openCreate: editor.openCreate, openEdit: editor.openEdit, changeDraft: editor.change,
    changeBackend: actions.changeBackend, closeDraft: editor.close, revertDraft: editor.revert,
    save: actions.save, setDefault: actions.setDefault, requestDelete: actions.requestDelete,
    cancelDelete: () => setConfirmingDelete(null), confirmDelete: actions.confirmDelete,
  };
}
