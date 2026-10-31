import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import {
  CONNECTION_KINDS,
  buildConnectionArgs,
  buildConnectionRows,
  emptyConnectionForm,
  formStateFromConnection,
  isConnectionFormValid,
  overridableProviders,
  validateConnectionForm,
  type ConnectionFormErrors,
  type ConnectionFormKind,
  type ConnectionFormState,
  type ConnectionRowVm,
} from '@/features/settings/vm/connections-vm';

export interface ConnectionsController {
  rows: ConnectionRowVm[];
  /** Kinds a new connection may take: a PI override needs a PI provider without one. */
  kinds: ConnectionFormKind[];
  /** PI providers a new override may redirect. */
  overridable: string[];
  draft: ConnectionFormState | null;
  creating: boolean;
  errors: ConnectionFormErrors;
  /** Row key armed for deletion by a first press, or null. */
  confirmingDelete: string | null;
  savePending: boolean;
  removePending: boolean;
  openCreate: () => void;
  openEdit: (row: ConnectionRowVm) => void;
  changeDraft: (draft: ConnectionFormState) => void;
  closeDraft: () => void;
  save: () => void;
  requestDelete: (row: ConnectionRowVm) => void;
}

/** A connection change moves the Accounts API-key slot, the runnable models and the selector. */
function useConnectionWrites(onSaved: () => void, onDeleted: () => void) {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const refresh = () => {
    void queryClient.invalidateQueries(trpc.connections.list.queryFilter({}));
    void queryClient.invalidateQueries(trpc.auth.status.queryFilter({}));
    void queryClient.invalidateQueries(trpc.models.catalog.queryFilter({}));
  };
  const failed = (error: { message: string }) => {
    toast({ title: `${L.connToastFailed}: ${error.message}`, tone: 'failed' });
  };
  const save = useMutation(trpc.connections.upsert.mutationOptions({
    onSuccess: () => { refresh(); onSaved(); toast({ title: L.connToastSaved, tone: 'done' }); },
    onError: failed,
  }));
  const remove = useMutation(trpc.connections.remove.mutationOptions({
    onSuccess: () => { refresh(); onDeleted(); toast({ title: L.connToastDeleted, tone: 'done' }); },
    onError: failed,
  }));
  return { save, remove };
}

function useConnectionLists() {
  const L = useVocab();
  const trpc = useTRPC();
  const views = useQuery(trpc.connections.list.queryOptions({})).data ?? [];
  const status = useQuery(trpc.auth.status.queryOptions({})).data;
  const overridable = overridableProviders(status, views);
  const kinds = CONNECTION_KINDS.filter((kind) => kind !== 'pi-override' || overridable.length > 0);
  return { rows: buildConnectionRows(views, L), overridable, kinds };
}

export function useConnectionsController(): ConnectionsController {
  const lists = useConnectionLists();
  const [draft, setDraft] = useState<ConnectionFormState | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const writes = useConnectionWrites(() => setDraft(null), () => setConfirmingDelete(null));
  const mode = creating ? 'create' as const : 'update' as const;
  const errors = draft ? validateConnectionForm(draft, { mode, existing: lists.rows }) : {};
  const save = () => {
    if (draft && isConnectionFormValid(errors) && !writes.save.isPending) writes.save.mutate(buildConnectionArgs(draft, mode));
  };
  const requestDelete = (row: ConnectionRowVm) => {
    if (confirmingDelete !== row.key) return setConfirmingDelete(row.key);
    if (!writes.remove.isPending) writes.remove.mutate({ backend: row.backend, id: row.id });
  };
  return {
    ...lists, draft, creating, errors, confirmingDelete,
    savePending: writes.save.isPending, removePending: writes.remove.isPending,
    openCreate: () => { setCreating(true); setDraft(emptyConnectionForm()); },
    openEdit: (row) => { setCreating(false); setDraft(formStateFromConnection(row.view)); },
    changeDraft: setDraft, closeDraft: () => setDraft(null), save, requestDelete,
  };
}
