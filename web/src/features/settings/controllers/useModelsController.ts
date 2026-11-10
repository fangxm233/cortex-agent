import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigSnapshot, ModelRef } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { modelKey, selectionForModel } from '@/lib/model-selection';
import { useConnectionNames } from '@/lib/useConnectionNames';
import {
  buildModelFacts, catalogModels, defaultConnectionControl, defaultModelOptions, type DelegationPolicy,
} from '@/features/settings/vm/models-panel-vm';

function useModelWrites() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const L = useVocab();
  const effects = {
    onSuccess: () => {
      void queryClient.invalidateQueries(trpc.config.get.queryFilter({}));
      toast({ title: L.stModelsSaved, tone: 'done' });
    },
  };
  const add = useMutation(trpc.models.favorites.add.mutationOptions(effects));
  const remove = useMutation(trpc.models.favorites.remove.mutationOptions(effects));
  const setDefault = useMutation(trpc.models.setDefault.mutationOptions(effects));
  const setThinking = useMutation(trpc.models.setThinking.mutationOptions(effects));
  const setDelegation = useMutation(trpc.models.setDelegation.mutationOptions(effects));
  return { add, remove, setDefault, setThinking, setDelegation };
}

function useModelsResources(initialSnapshot?: ConfigSnapshot) {
  const trpc = useTRPC();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const options = trpc.config.get.queryOptions({});
  const config = useQuery(initialSnapshot ? { ...options, initialData: initialSnapshot } : options);
  const catalog = useQuery({
    ...trpc.models.catalog.queryOptions({}), staleTime: 60_000,
    refetchInterval: query => query.state.data?.piPending ? 2_500 : false,
  });
  return { config, catalog, catalogOpen, setCatalogOpen };
}

function useModelWriteGate() {
  const gate = useRef(false);
  const [pending, setPending] = useState(false);
  const { toast } = useToast();
  const L = useVocab();
  const run = (write: () => Promise<unknown>) => {
    if (gate.current) return;
    gate.current = true;
    setPending(true);
    void write().catch((error: Error) => {
      toast({ title: `${L.stModelsWriteFailed}: ${error.message}`, tone: 'failed' });
    }).finally(() => { gate.current = false; setPending(false); });
  };
  return { pending, run };
}

function useModelActions(resources: ReturnType<typeof useModelsResources>, options: ModelRef[]) {
  const writes = useModelWrites();
  const { pending, run } = useModelWriteGate();
  const { config, catalog } = resources;
  const setDefault = (key: string) => {
    const ref = options.find(option => modelKey(option) === key);
    const snapshot = config.data;
    if (!ref || !snapshot) return;
    run(async () => {
      const data = catalog.data ?? (await catalog.refetch({ throwOnError: true })).data;
      const selection = selectionForModel(ref, snapshot, data, snapshot.models.default);
      await writes.setDefault.mutateAsync({ selection });
    });
  };
  /** Pins the default model to one connection; null follows the default connection. */
  const setDefaultConnection = (connection: string | null) => {
    const current = config.data?.models.default;
    if (!current || (current.connection ?? null) === connection) return;
    run(() => writes.setDefault.mutateAsync({ selection: { ...current, connection } }));
  };
  return { pending, setDefault, setDefaultConnection,
    setThinking: (ref: ModelRef, thinking: string | null) => run(() => writes.setThinking.mutateAsync({ ref, thinking })),
    add: (ref: ModelRef) => run(() => writes.add.mutateAsync({ ...ref, provider: ref.provider ?? undefined })),
    remove: (ref: ModelRef) => run(() => writes.remove.mutateAsync({ ...ref, provider: ref.provider ?? undefined })),
    setDelegation: (policy: DelegationPolicy) => run(() => writes.setDelegation.mutateAsync(policy)),
  };
}

export function useModelsController(initialSnapshot?: ConfigSnapshot) {
  const L = useVocab();
  const resources = useModelsResources(initialSnapshot);
  const { config, catalog, catalogOpen, setCatalogOpen } = resources;
  const snapshot = config.data;
  const facts = snapshot ? buildModelFacts(snapshot) : [];
  const options = snapshot ? defaultModelOptions(snapshot, catalog.data ?? null) : [];
  const actions = useModelActions(resources, options);
  const names = useConnectionNames(L.wbConnectionSubscription)[snapshot?.models.default?.backend ?? 'claude'];
  return {
    snapshot, facts, options, loading: config.isLoading, error: config.error,
    connectionControl: snapshot ? defaultConnectionControl(snapshot, catalog.data ?? null, names, {
      withConnection: L.wbConnectionDefault, plain: L.wbThinkingDefault,
    }) : null,
    catalog: catalog.error ? null : catalog.data ?? null,
    catalogOpen, setCatalogOpen, catalogModels: catalogModels(catalog.data ?? null),
    catalogPending: catalog.isLoading || !!catalog.data?.piPending, catalogError: catalog.error,
    ...actions,
  };
}

export type ModelsController = ReturnType<typeof useModelsController>;
