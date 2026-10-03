import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EnvironmentDetail,
  EnvironmentEntry,
  EnvironmentIssue,
} from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { trpcErrorCode, useTRPC } from '@/lib/trpc';
import {
  filterEntries,
  resolveSelection,
  type SaveArgs,
} from '@/features/settings/vm/environments-panel-vm';

export interface EnvironmentIssues {
  errors: EnvironmentIssue[];
  warnings: EnvironmentIssue[];
}

export interface ValidateArgs {
  name: string;
  body: Record<string, unknown>;
}

export interface EnvironmentsControllerOptions {
  /** True while a new environment is being drafted. It decides whether a selection exists at all,
   *  and whether a save has to point the list at the environment it just wrote. */
  creating: boolean;
  onValidated: (issues: EnvironmentIssues) => void;
  onSaved: () => void;
  onRemoved: () => void;
}

export interface EnvironmentsController {
  entries: readonly EnvironmentEntry[];
  visible: readonly EnvironmentEntry[];
  search: string;
  selection: string | null;
  detail: EnvironmentDetail | null;
  busy: boolean;
  setSearch: (value: string) => void;
  select: (name: string | null) => void;
  invalidate: () => void;
  validate: (args: ValidateArgs) => void;
  save: (args: SaveArgs) => void;
  remove: (name: string) => void;
}

/**
 * Every `environments` call the panel makes: the list, the detail of whatever the list resolved to,
 * and the three writes. List filtering lives here too because the detail query key is derived from
 * it — the selection is whatever survived the filter, so the two cannot be split apart.
 *
 * What the panel keeps is the editor: its text buffer, the open tab and the armed confirmation. The
 * writes report back through `onValidated` / `onSaved` / `onRemoved` rather than reaching into that
 * state themselves.
 */
export function useEnvironmentsController(options: EnvironmentsControllerOptions): EnvironmentsController {
  const { creating, onValidated, onSaved, onRemoved } = options;
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const listQuery = useQuery(trpc.environments.list.queryOptions({}));
  const entries = useMemo(() => listQuery.data ?? [], [listQuery.data]);

  const [search, setSearch] = useState('');
  const [requested, setRequested] = useState<string | null>(null);

  const visible = useMemo(() => filterEntries(entries, search), [entries, search]);
  const selection = creating ? null : resolveSelection(visible, requested);

  const detailQuery = useQuery({
    ...trpc.environments.get.queryOptions({ name: selection ?? '' }),
    enabled: selection !== null,
  });
  const detail = selection ? (detailQuery.data ?? null) : null;

  const invalidate = () => {
    queryClient.invalidateQueries(trpc.environments.list.queryFilter({}));
    if (selection) queryClient.invalidateQueries(trpc.environments.get.queryFilter({ name: selection }));
  };
  const onWriteError = (error: { message: string; data?: unknown }) => {
    const conflict = trpcErrorCode(error) === 'CONFLICT' || /changed on disk/i.test(error.message);
    toast({ title: conflict ? L.ttToastConflict : `${L.ttToastWriteFailed}: ${error.message}`, tone: 'failed' });
  };

  const validate = useMutation(
    trpc.environments.validate.mutationOptions({
      onSuccess: (data) => {
        onValidated({ errors: data.errors, warnings: data.warnings });
        toast({ title: data.ok ? L.ttToastValid : L.ttToastInvalid, tone: data.ok ? 'done' : 'failed' });
      },
      onError: onWriteError,
    }),
  );

  const save = useMutation(
    trpc.environments.save.mutationOptions({
      onSuccess: (data, vars) => {
        invalidate();
        if (creating) setRequested(vars.name);
        onSaved();
        toast({ title: L.ttToastSaved, tone: 'done' });
        for (const warning of data.warnings) {
          toast({ title: `${warning.path}: ${warning.message}`, tone: 'waiting' });
        }
      },
      onError: onWriteError,
    }),
  );

  const remove = useMutation(
    trpc.environments.delete.mutationOptions({
      onSuccess: () => {
        invalidate();
        setRequested(null);
        onRemoved();
        toast({ title: L.ttToastDeleted, tone: 'done' });
      },
      onError: onWriteError,
    }),
  );

  return {
    entries,
    visible,
    search,
    selection,
    detail,
    busy: save.isPending || remove.isPending || validate.isPending,
    setSearch,
    select: setRequested,
    invalidate,
    validate: validate.mutate,
    save: save.mutate,
    remove: (name) => remove.mutate({ name }),
  };
}
