import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigSnapshot, ModelRef } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { modelKey, selectionForModel } from '@/lib/model-selection';
import { buildModelFacts, catalogModels, defaultModelOptions } from '@/features/settings/vm/models-panel-vm';

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
  return { add, remove, setDefault, setThinking };
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
      let selection = selectionForModel(ref, snapshot, catalog.data);
      if (!selection.mode) {
        const result = await catalog.refetch({ throwOnError: true });
        selection = selectionForModel(ref, snapshot, result.data);
      }
      await writes.setDefault.mutateAsync({ selection });
    });
  };
  return { pending, setDefault,
    setThinking: (ref: ModelRef, thinking: string | null) => run(() => writes.setThinking.mutateAsync({ ref, thinking })),
    add: (ref: ModelRef) => run(() => writes.add.mutateAsync({ ...ref, provider: ref.provider ?? undefined })),
    remove: (ref: ModelRef) => run(() => writes.remove.mutateAsync({ ...ref, provider: ref.provider ?? undefined })),
  };
}

export function useModelsController(initialSnapshot?: ConfigSnapshot) {
  const resources = useModelsResources(initialSnapshot);
  const { config, catalog, catalogOpen, setCatalogOpen } = resources;
  const snapshot = config.data;
  const facts = snapshot ? buildModelFacts(snapshot) : [];
  const options = snapshot ? defaultModelOptions(snapshot, catalog.data ?? null) : [];
  const actions = useModelActions(resources, options);
  return {
    snapshot, facts, options, loading: config.isLoading, error: config.error,
    catalog: catalog.error ? null : catalog.data ?? null,
    catalogOpen, setCatalogOpen, catalogModels: catalogModels(catalog.data ?? null),
    catalogPending: catalog.isLoading || !!catalog.data?.piPending, catalogError: catalog.error,
    ...actions,
  };
}

export type ModelsController = ReturnType<typeof useModelsController>;
