import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ThreadTemplateDetail,
  ThreadTemplateEntry,
  ThreadTemplateIssue,
} from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import {
  filterEntries,
  resolveSelection,
  type SaveArgs,
  type TemplateFilterKey,
  type TemplateKind,
  type TemplateSelection,
} from '@/features/settings/vm/templates-panel-vm';

export interface TemplateIssues {
  errors: ThreadTemplateIssue[];
  warnings: ThreadTemplateIssue[];
}

export interface ValidateArgs {
  kind: TemplateKind;
  name: string;
  body: Record<string, unknown>;
}

export interface TemplatesControllerOptions {
  /** The draft being created, or null. It decides whether a selection exists at all, and whether a
   *  save has to point the list at the entity it just wrote. */
  creating: { kind: TemplateKind } | null;
  onValidated: (issues: TemplateIssues) => void;
  onSaved: () => void;
  onRemoved: () => void;
}

export interface TemplatesController {
  entries: readonly ThreadTemplateEntry[];
  visible: readonly ThreadTemplateEntry[];
  filter: TemplateFilterKey;
  search: string;
  selection: TemplateSelection | null;
  detail: ThreadTemplateDetail | null;
  busy: boolean;
  setFilter: (key: TemplateFilterKey) => void;
  setSearch: (value: string) => void;
  select: (selection: TemplateSelection | null) => void;
  invalidate: () => void;
  validate: (args: ValidateArgs) => void;
  save: (args: SaveArgs) => void;
  remove: (selection: TemplateSelection) => void;
}

/**
 * Every `threadTemplates` call the panel makes: the list, the detail of whatever the list resolved
 * to, and the three writes. List filtering lives here too because the detail query key is derived
 * from it — the selection is whatever survived the filter, so the two cannot be split apart.
 *
 * What the panel keeps is the editor: its text buffer, the open tab and the armed confirmations.
 * The writes report back through `onValidated` / `onSaved` / `onRemoved` rather than reaching into
 * that state themselves.
 */
export function useTemplatesController(options: TemplatesControllerOptions): TemplatesController {
  const { creating, onValidated, onSaved, onRemoved } = options;
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const listQuery = useQuery(trpc.threadTemplates.get.queryOptions({}));
  const entries = useMemo(() => listQuery.data ?? [], [listQuery.data]);

  const [filter, setFilter] = useState<TemplateFilterKey>('all');
  const [search, setSearch] = useState('');
  const [requested, setRequested] = useState<TemplateSelection | null>(null);

  const visible = useMemo(() => filterEntries(entries, filter, search), [entries, filter, search]);
  const selection = creating ? null : resolveSelection(visible, requested);

  const detailQuery = useQuery({
    ...trpc.threadTemplates.detail.queryOptions(
      selection ?? { kind: 'template' as const, name: '' },
    ),
    enabled: selection !== null,
  });
  const detail = selection ? (detailQuery.data ?? null) : null;

  const invalidate = () => {
    queryClient.invalidateQueries(trpc.threadTemplates.get.queryFilter({}));
    if (selection) queryClient.invalidateQueries(trpc.threadTemplates.detail.queryFilter(selection));
  };
  const onWriteError = (error: { message: string; data?: unknown }) => {
    const conflict = /changed on disk/i.test(error.message);
    toast({ title: conflict ? L.ttToastConflict : `${L.ttToastWriteFailed}: ${error.message}`, tone: 'failed' });
  };

  const validate = useMutation(
    trpc.threadTemplates.validate.mutationOptions({
      onSuccess: (data) => {
        onValidated({ errors: data.errors, warnings: data.warnings });
        toast({ title: data.ok ? L.ttToastValid : L.ttToastInvalid, tone: data.ok ? 'done' : 'failed' });
      },
      onError: onWriteError,
    }),
  );

  const save = useMutation(
    trpc.threadTemplates.save.mutationOptions({
      onSuccess: (data, vars) => {
        invalidate();
        if (creating) setRequested({ kind: vars.kind, name: vars.name });
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
    trpc.threadTemplates.remove.mutationOptions({
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
    filter,
    search,
    selection,
    detail,
    busy: save.isPending || remove.isPending || validate.isPending,
    setFilter,
    setSearch,
    select: setRequested,
    invalidate,
    validate: validate.mutate,
    save: save.mutate,
    remove: remove.mutate,
  };
}
