// input:  custom-provider tRPC endpoints, canonical draft VM, query cache, and toasts
// output: shared list/editor/save/remove state with independent mutation pending flags
// pos:    Cross-surface custom PI provider controller
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomProviderView } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import {
  buildCustomProviderArgs,
  emptyCustomProviderForm,
  formStateFromCustomProvider,
  isCustomProviderFormValid,
  validateCustomProviderForm,
  type CustomProviderFormErrors,
  type CustomProviderFormState,
} from './custom-provider-vm';

export interface CustomProvidersController {
  providers: CustomProviderView[];
  listLoading: boolean;
  listError: { message: string } | null;
  draft: CustomProviderFormState | null;
  creating: boolean;
  errors: CustomProviderFormErrors;
  confirmingDelete: string | null;
  savePending: boolean;
  removePending: boolean;
  openCreate: () => void;
  openEdit: (provider: CustomProviderView) => void;
  changeDraft: (draft: CustomProviderFormState) => void;
  closeDraft: () => void;
  save: () => void;
  requestDelete: (name: string) => void;
}

function useProviderWrites(onSaved: () => void, onDeleted: () => void) {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const refresh = () => {
    void queryClient.invalidateQueries(trpc.auth.customProviders.queryFilter({}));
    void queryClient.invalidateQueries(trpc.auth.status.queryFilter({}));
  };
  const failed = (error: { message: string }) => {
    toast({ title: `${L.cpvToastFailed}: ${error.message}`, tone: 'failed' });
  };
  const save = useMutation(trpc.auth.upsertCustomProvider.mutationOptions({
    onSuccess: () => { refresh(); onSaved(); toast({ title: L.cpvToastSaved, tone: 'done' }); },
    onError: failed,
  }));
  const remove = useMutation(trpc.auth.removeCustomProvider.mutationOptions({
    onSuccess: () => { refresh(); onDeleted(); toast({ title: L.cpvToastDeleted, tone: 'done' }); },
    onError: failed,
  }));
  return { save, remove };
}

export function useCustomProvidersController(): CustomProvidersController {
  const trpc = useTRPC();
  const list = useQuery(trpc.auth.customProviders.queryOptions({}));
  const providers = list.data ?? [];
  const [draft, setDraft] = useState<CustomProviderFormState | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const writes = useProviderWrites(() => setDraft(null), () => setConfirmingDelete(null));
  const errors = draft ? validateCustomProviderForm(draft, {
    mode: creating ? 'create' : 'update', existingNames: providers.map(provider => provider.name),
  }) : {};
  const openCreate = () => { setCreating(true); setDraft(emptyCustomProviderForm()); };
  const openEdit = (provider: CustomProviderView) => {
    setCreating(false); setDraft(formStateFromCustomProvider(provider));
  };
  const save = () => {
    if (draft && isCustomProviderFormValid(errors) && !writes.save.isPending) {
      writes.save.mutate(buildCustomProviderArgs(draft));
    }
  };
  const requestDelete = (name: string) => {
    if (confirmingDelete !== name) return setConfirmingDelete(name);
    if (!writes.remove.isPending) writes.remove.mutate({ name });
  };
  return {
    providers, listLoading: list.isLoading, listError: list.error,
    draft, creating, errors, confirmingDelete,
    savePending: writes.save.isPending, removePending: writes.remove.isPending,
    openCreate, openEdit, changeDraft: setDraft, closeDraft: () => setDraft(null),
    save, requestDelete,
  };
}
