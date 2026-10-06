import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  PluginsSkillWriteReturn,
  MutateArgs,
} from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PluginAuthoringActions {
  /** One gate for every write: two plugin mutations in flight would race the same catalog read. */
  busy: boolean;
  skillWrite: (args: MutateArgs<'plugins.skillWrite'>) => Promise<PluginsSkillWriteReturn | null>;
  skillCreate: (args: MutateArgs<'plugins.skillCreate'>) => Promise<boolean>;
  skillMove: (args: MutateArgs<'plugins.skillMove'>) => Promise<boolean>;
  skillRemove: (args: MutateArgs<'plugins.skillRemove'>) => Promise<boolean>;
  pluginCreate: (args: MutateArgs<'plugins.create'>) => Promise<boolean>;
  pluginRemove: (args: MutateArgs<'plugins.remove'>) => Promise<boolean>;
  convertToPortable: (args: MutateArgs<'plugins.convertToPortable'>) => Promise<boolean>;
  mcpWrite: (args: MutateArgs<'plugins.mcpWrite'>) => Promise<boolean>;
}

type Mutation<A> = { mutateAsync: (args: A) => Promise<unknown> };

export function usePluginAuthoring(): PluginAuthoringActions {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const L = useVocab();
  const [busy, setBusy] = useState(false);

  const skillWriteM = useMutation(trpc.plugins.skillWrite.mutationOptions()) as Mutation<MutateArgs<'plugins.skillWrite'>>;
  const skillCreateM = useMutation(trpc.plugins.skillCreate.mutationOptions()) as Mutation<MutateArgs<'plugins.skillCreate'>>;
  const skillMoveM = useMutation(trpc.plugins.skillMove.mutationOptions()) as Mutation<MutateArgs<'plugins.skillMove'>>;
  const skillRemoveM = useMutation(trpc.plugins.skillRemove.mutationOptions()) as Mutation<MutateArgs<'plugins.skillRemove'>>;
  const createM = useMutation(trpc.plugins.create.mutationOptions()) as Mutation<MutateArgs<'plugins.create'>>;
  const removeM = useMutation(trpc.plugins.remove.mutationOptions()) as Mutation<MutateArgs<'plugins.remove'>>;
  const convertM = useMutation(trpc.plugins.convertToPortable.mutationOptions()) as Mutation<MutateArgs<'plugins.convertToPortable'>>;
  const mcpWriteM = useMutation(trpc.plugins.mcpWrite.mutationOptions()) as Mutation<MutateArgs<'plugins.mcpWrite'>>;

  /** The catalog is re-read from disk on every request and has no cache to invalidate server-side,
   *  so a write is only visible once this query is refetched. */
  const run = useCallback(async <T>(label: string, call: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    try {
      const data = await call();
      await queryClient.invalidateQueries(trpc.plugins.list.queryFilter({}));
      toast({ title: label, tone: 'done' });
      return data;
    } catch (error) {
      toast({ title: `${L.plToastActionFailed}: ${errorMessage(error)}`, tone: 'failed' });
      return null;
    } finally {
      setBusy(false);
    }
  }, [queryClient, trpc, toast, L]);

  const flag = useCallback(async (label: string, call: () => Promise<unknown>): Promise<boolean> => (
    await run(label, call) !== null
  ), [run]);

  return {
    busy,
    skillWrite: useCallback(async (args) => {
      const data = await run(L.plToastSkillSaved, async () => (
        await skillWriteM.mutateAsync(args) as PluginsSkillWriteReturn
      ));
      return data;
    }, [run, skillWriteM, L]),
    skillCreate: useCallback((args) => (
      flag(L.plToastSkillCreated, () => skillCreateM.mutateAsync(args))
    ), [flag, skillCreateM, L]),
    skillMove: useCallback((args) => (
      flag(L.plToastSkillMoved, () => skillMoveM.mutateAsync(args))
    ), [flag, skillMoveM, L]),
    skillRemove: useCallback((args) => (
      flag(L.plToastSkillDeleted, () => skillRemoveM.mutateAsync(args))
    ), [flag, skillRemoveM, L]),
    pluginCreate: useCallback((args) => (
      flag(L.plToastPluginCreated, () => createM.mutateAsync(args))
    ), [flag, createM, L]),
    pluginRemove: useCallback((args) => (
      flag(L.plToastPluginDeleted, () => removeM.mutateAsync(args))
    ), [flag, removeM, L]),
    convertToPortable: useCallback((args) => (
      flag(L.plToastConverted, () => convertM.mutateAsync(args))
    ), [flag, convertM, L]),
    mcpWrite: useCallback((args) => (
      flag(L.plToastMcpSaved, () => mcpWriteM.mutateAsync(args))
    ), [flag, mcpWriteM, L]),
  };
}
