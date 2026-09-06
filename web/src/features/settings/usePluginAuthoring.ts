// input:  the plugin authoring mutations and the catalog query key
// output: one busy gate, one toast policy, and one refresh for every plugin write
// pos:    Shared write controller for the plugin package manager
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  PluginsConvertArgs,
  PluginsCreateArgs,
  PluginsMcpWriteArgs,
  PluginsRemoveArgs,
  PluginsSkillCreateArgs,
  PluginsSkillMoveArgs,
  PluginsSkillRemoveArgs,
  PluginsSkillWriteArgs,
  PluginsSkillWriteReturn,
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
  skillWrite: (args: PluginsSkillWriteArgs) => Promise<PluginsSkillWriteReturn | null>;
  skillCreate: (args: PluginsSkillCreateArgs) => Promise<boolean>;
  skillMove: (args: PluginsSkillMoveArgs) => Promise<boolean>;
  skillRemove: (args: PluginsSkillRemoveArgs) => Promise<boolean>;
  pluginCreate: (args: PluginsCreateArgs) => Promise<boolean>;
  pluginRemove: (args: PluginsRemoveArgs) => Promise<boolean>;
  convertToPortable: (args: PluginsConvertArgs) => Promise<boolean>;
  mcpWrite: (args: PluginsMcpWriteArgs) => Promise<boolean>;
}

type Mutation<A> = { mutateAsync: (args: A) => Promise<unknown> };

export function usePluginAuthoring(): PluginAuthoringActions {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const L = useVocab();
  const [busy, setBusy] = useState(false);

  const skillWriteM = useMutation(trpc.plugins.skillWrite.mutationOptions()) as Mutation<PluginsSkillWriteArgs>;
  const skillCreateM = useMutation(trpc.plugins.skillCreate.mutationOptions()) as Mutation<PluginsSkillCreateArgs>;
  const skillMoveM = useMutation(trpc.plugins.skillMove.mutationOptions()) as Mutation<PluginsSkillMoveArgs>;
  const skillRemoveM = useMutation(trpc.plugins.skillRemove.mutationOptions()) as Mutation<PluginsSkillRemoveArgs>;
  const createM = useMutation(trpc.plugins.create.mutationOptions()) as Mutation<PluginsCreateArgs>;
  const removeM = useMutation(trpc.plugins.remove.mutationOptions()) as Mutation<PluginsRemoveArgs>;
  const convertM = useMutation(trpc.plugins.convertToPortable.mutationOptions()) as Mutation<PluginsConvertArgs>;
  const mcpWriteM = useMutation(trpc.plugins.mcpWrite.mutationOptions()) as Mutation<PluginsMcpWriteArgs>;

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
