// input:  typed runtime setting values, config.set mutation and config snapshot cache
// output: serialized runtime setting commits and shared desktop/mobile writer hook
// pos:    Runtime write owner independent of desktop and mobile settings views
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConfigSetArgs } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import type { WritableBooleanSettingKey, WritableSettingKey } from './platform-env';

export type { WritableBooleanSettingKey, WritableNumberSettingKey, WritableSettingKey } from './platform-env';

export type SettingsSetArgs = Extract<ConfigSetArgs, { section: 'settings' }>;
export type WritableSettingValue = boolean | number;

export interface CommitSettingDeps {
  set: (args: SettingsSetArgs) => Promise<unknown>;
  refresh: () => Promise<unknown>;
  onError: (message: string) => void;
  onPending?: (pending: boolean) => void;
}

export async function commitSettingValue(
  deps: CommitSettingDeps,
  key: WritableSettingKey,
  nextValue: WritableSettingValue,
): Promise<void> {
  deps.onPending?.(true);
  try {
    await deps.set({
      section: 'settings', value: { [key]: nextValue } as SettingsSetArgs['value'],
    });
    await deps.refresh();
  } catch (error) {
    deps.onError(error instanceof Error ? error.message : String(error));
  } finally {
    deps.onPending?.(false);
  }
}

export function commitSettingToggle(
  deps: CommitSettingDeps,
  key: WritableBooleanSettingKey,
  nextValue: boolean,
): Promise<void> {
  return commitSettingValue(deps, key, nextValue);
}

export interface RuntimeSettingWriter {
  pending: boolean;
  onToggle: (key: WritableBooleanSettingKey, nextValue: boolean) => void;
  onSet: (key: WritableSettingKey, nextValue: WritableSettingValue) => void;
}

export function useRuntimeSettingWrite(): RuntimeSettingWriter {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [committing, setCommitting] = useState(false);
  const committingRef = useRef(false);
  const mutation = useMutation(trpc.config.set.mutationOptions());
  const setPending = (value: boolean) => {
    committingRef.current = value;
    setCommitting(value);
  };
  const onSet = (key: WritableSettingKey, nextValue: WritableSettingValue) => {
    if (committingRef.current || mutation.isPending) return;
    void commitSettingValue({
      set: (args) => mutation.mutateAsync(
        args as unknown as Parameters<typeof mutation.mutateAsync>[0],
      ),
      refresh: () => queryClient.invalidateQueries(trpc.config.get.queryFilter({})),
      onError: (message) => toast({ title: `${L.stToastWriteFailed}: ${message}`, tone: 'failed' }),
      onPending: setPending,
    }, key, nextValue);
  };
  const onToggle = (key: WritableBooleanSettingKey, value: boolean) => onSet(key, value);
  return { pending: committing || mutation.isPending, onToggle, onSet };
}
