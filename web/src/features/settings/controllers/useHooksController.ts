import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  HookDetail,
  HookScriptInfo,
  HooksCreateArgs,
  HooksTestReturn,
  HooksUpdateArgs,
} from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import {
  filterHooks,
  resolveSelectedHookId,
  type HookFilterKey,
  type HookFilterValue,
} from '@/features/settings/vm/hooks-panel-vm';

/**
 * The generated router input type narrows a matcherFilters value to `string | number | boolean`,
 * dropping the `null` that the zod schema, the `HookDetail` DTO and the loader all carry (the
 * schema's own `safeParse` accepts `{ k: null }`). Dropping null from the editor instead would
 * silently rewrite a legitimate `null` filter to the string `"null"` on the next save, so the value
 * is kept and the two shapes are reconciled here — the one place they meet.
 */
type WireFilters = Record<string, string | number | boolean>;

function toWireArgs<T extends { matcherFilters?: Record<string, HookFilterValue> }>(
  args: T,
): Omit<T, 'matcherFilters'> & { matcherFilters?: WireFilters } {
  return args as Omit<T, 'matcherFilters'> & { matcherFilters?: WireFilters };
}

export interface HooksControllerOptions {
  /** True while the panel holds a create draft: nothing in the list is selected then. */
  creating: boolean;
  onCreated: () => void;
  onUpdated: () => void;
  onRemoved: () => void;
  onTested: (result: HooksTestReturn | null) => void;
}

export interface HooksController {
  hooks: HookDetail[];
  scripts: HookScriptInfo[];
  hooksDir: string;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string;
  filter: HookFilterKey;
  search: string;
  selectedId: string | null;
  selected: HookDetail | null;
  saving: boolean;
  testPending: boolean;
  setFilter: (key: HookFilterKey) => void;
  setSearch: (value: string) => void;
  select: (id: string | null) => void;
  setEnabled: (args: { id: string; enabled: boolean }) => void;
  create: (args: HooksCreateArgs) => void;
  update: (args: HooksUpdateArgs) => void;
  remove: (args: { id: string }) => void;
  runTest: (args: { id: string; payload: string }) => void;
}

/**
 * Every `hooks.*` call the panel makes: the list, the four writes and the test run. Filter/search
 * and the requested id live here because the selection is derived from them against the list this
 * hook owns — the panel only says whether it is currently holding a create draft.
 *
 * What the panel keeps is the editor: the working copy, the armed delete, the test drawer. The
 * writes report back through onCreated / onUpdated / onRemoved / onTested rather than reaching
 * into that state themselves.
 */
export function useHooksController(options: HooksControllerOptions): HooksController {
  const { creating, onCreated, onUpdated, onRemoved, onTested } = options;
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const listQuery = useQuery(trpc.hooks.list.queryOptions({}));
  const hooks = useMemo(() => listQuery.data?.hooks ?? [], [listQuery.data]);

  const [filter, setFilter] = useState<HookFilterKey>('all');
  const [search, setSearch] = useState('');
  const [requestedId, setRequestedId] = useState<string | null>(null);

  const visible = useMemo(() => filterHooks(hooks, filter, search), [hooks, filter, search]);
  const selectedId = creating ? null : resolveSelectedHookId(hooks, visible, requestedId);
  const selected = hooks.find((h) => h.id === selectedId) ?? null;

  const invalidate = () => queryClient.invalidateQueries(trpc.hooks.list.queryFilter({}));
  const onWriteError = (error: { message: string }) =>
    toast({ title: `${L.hkToastWriteFailed}: ${error.message}`, tone: 'failed' });

  const setEnabled = useMutation(
    trpc.hooks.setEnabled.mutationOptions({
      onSuccess: (data, vars) => {
        invalidate();
        toast({ title: vars.enabled ? L.hkToastEnabled : L.hkToastDisabled, tone: 'done' });
        // A managed entry's enabled flag is restored by the next hook sync — the server says so.
        if (data.warning !== null) toast({ title: data.warning, tone: 'waiting' });
      },
      onError: onWriteError,
    }),
  );
  const create = useMutation(
    trpc.hooks.create.mutationOptions({
      onSuccess: (data) => {
        invalidate();
        toast({ title: `${L.hkToastCreated} · ${data.fileName}`, tone: 'done' });
        onCreated();
        setRequestedId(data.id);
      },
      onError: onWriteError,
    }),
  );
  const update = useMutation(
    trpc.hooks.update.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast({ title: L.hkToastSaved, tone: 'done' });
        onUpdated();
      },
      onError: onWriteError,
    }),
  );
  const remove = useMutation(
    trpc.hooks.remove.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast({ title: L.hkToastDeleted, tone: 'done' });
        onRemoved();
        setRequestedId(null);
      },
      onError: onWriteError,
    }),
  );
  // hooks.test only executes an already-mounted declaration; it changes no state, so it is the one
  // mutation here that does not invalidate the list.
  const runTest = useMutation(
    trpc.hooks.test.mutationOptions({
      onSuccess: (data) => onTested(data),
      onError: (error) => {
        onTested(null);
        toast({ title: `${L.hkToastTestFailed}: ${error.message}`, tone: 'failed' });
      },
    }),
  );

  return {
    hooks,
    scripts: listQuery.data?.scripts ?? [],
    hooksDir: listQuery.data?.hooksDir ?? '',
    isLoading: listQuery.isLoading,
    isError: listQuery.isError,
    errorMessage: listQuery.error?.message ?? '',
    filter,
    search,
    selectedId,
    selected,
    saving: create.isPending || update.isPending || remove.isPending || setEnabled.isPending,
    testPending: runTest.isPending,
    setFilter,
    setSearch,
    select: setRequestedId,
    setEnabled: setEnabled.mutate,
    create: (args) => create.mutate(toWireArgs(args)),
    update: (args) => update.mutate(toWireArgs(args)),
    remove: remove.mutate,
    runTest: runTest.mutate,
  };
}
