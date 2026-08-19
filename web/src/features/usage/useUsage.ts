// input:  React clock, usage/config queries, policy writes, and selected language
// output: queried usage view with refresh state and provider policy visibility/controls
// pos:    Shared usage data hook for desktop and mobile consumers
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConfigSnapshot,
  ProviderRateLimitPolicy,
  ProviderRateLimits,
  SystemUsageStatus,
} from '@cortex-agent/ui-contract';
import { useLang } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { buildUsageView, type UsageView } from './usage-vm';

export type UsagePolicyControlsState = 'ready' | 'loading' | 'error' | 'missing';

export interface UsagePolicyDraft {
  enabled: boolean;
  thresholdPercent: number | null;
}

export interface UsageFeatureState {
  view: UsageView;
  isLoading: boolean;
  queryError: { message: string } | null;
  refreshError: { message: string } | null;
  isRefreshing: boolean;
  policyControlsState: UsagePolicyControlsState;
  isPolicySaving: (provider: string) => boolean;
  getPolicyError: (provider: string) => { message: string } | null;
  refresh: () => void;
  savePolicy: (provider: string, draft: UsagePolicyDraft) => void;
}

function currentEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function useNowSeconds(): number {
  const [nowSec, setNowSec] = useState(currentEpochSeconds);

  useEffect(() => {
    const timer = setInterval(() => setNowSec(currentEpochSeconds()), 60_000);
    return () => clearInterval(timer);
  }, []);

  return nowSec;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readProviderRateLimits(snapshot: ConfigSnapshot | undefined): ProviderRateLimits | null {
  const settings = snapshot?.settings as Array<{ key: string; value: unknown }> | undefined;
  if (!settings) return null;
  const entry = settings.find((item) => item.key === 'providerRateLimits');
  if (!entry) return null;
  return isPlainObject(entry.value) ? entry.value as ProviderRateLimits : {};
}

function readPolicyControlsState(
  isLoading: boolean,
  isError: boolean,
  providerRateLimits: ProviderRateLimits | null,
): UsagePolicyControlsState {
  if (isLoading) return 'loading';
  if (isError) return 'error';
  return providerRateLimits === null ? 'missing' : 'ready';
}

function readViewPolicyConfig(
  controlsState: UsagePolicyControlsState,
  providerRateLimits: ProviderRateLimits | null,
): ProviderRateLimits | null {
  return controlsState === 'ready' ? providerRateLimits : null;
}

function nextPendingByProvider(
  current: Record<string, number>,
  provider: string,
  delta: 1 | -1,
): Record<string, number> {
  const nextCount = Math.max(0, (current[provider] ?? 0) + delta);
  return nextCount > 0
    ? { ...current, [provider]: nextCount }
    : Object.fromEntries(Object.entries(current).filter(([key]) => key !== provider));
}

function setProviderError(
  setPolicyErrors: Dispatch<SetStateAction<Record<string, string | null>>>,
  provider: string,
  message: string | null,
): void {
  setPolicyErrors(current => ({ ...current, [provider]: message }));
}

function applyPolicyToSnapshot(
  snapshot: ConfigSnapshot | undefined,
  policy: ProviderRateLimitPolicy,
): ConfigSnapshot | undefined {
  if (!snapshot?.settings) return snapshot;
  const settings = snapshot.settings;
  const index = settings.findIndex((entry) => entry.key === 'providerRateLimits');
  if (index < 0) return snapshot;
  const current = settings[index];
  const nextValue = isPlainObject(current.value) ? { ...current.value } as ProviderRateLimits : {};
  if (policy.enabled && policy.threshold === null) delete nextValue[policy.provider];
  else nextValue[policy.provider] = policy.threshold === null ? { enabled: policy.enabled } : { enabled: policy.enabled, threshold: policy.threshold };
  const nextSettings = [...settings];
  nextSettings[index] = { ...current, value: nextValue };
  return { ...snapshot, settings: nextSettings };
}

function percentToRatio(percent: number | null): number | null {
  if (percent === null) return null;
  return Math.round(percent * 100) / 10_000;
}

interface PolicyMutationInput {
  provider: string;
  enabled: boolean;
  threshold?: number;
}

function mutationArgs(provider: string, draft: UsagePolicyDraft): PolicyMutationInput {
  const threshold = percentToRatio(draft.thresholdPercent);
  return { provider, enabled: draft.enabled, ...(threshold === null ? {} : { threshold }) };
}

interface PolicyMutation {
  mutateAsync: (args: PolicyMutationInput) => Promise<{ policy: ProviderRateLimitPolicy }>;
}

function saveCommittedPolicy(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  result: { policy: ProviderRateLimitPolicy },
): void {
  const committed = result.policy;
  queryClient.setQueryData(queryKey, (current: unknown) => applyPolicyToSnapshot(
    current as ConfigSnapshot | undefined,
    committed,
  ));
}

function usePolicySave(
  controlsState: UsagePolicyControlsState,
  mutation: PolicyMutation,
  queryClient: ReturnType<typeof useQueryClient>,
  configKey: readonly unknown[],
): Pick<UsageFeatureState, 'isPolicySaving' | 'getPolicyError' | 'savePolicy'> {
  const [policyPending, setPolicyPending] = useState<Record<string, number>>({});
  const [policyErrors, setPolicyErrors] = useState<Record<string, string | null>>({});

  const savePolicy = (provider: string, draft: UsagePolicyDraft) => {
    if (controlsState !== 'ready') return;
    setProviderError(setPolicyErrors, provider, null);
    setPolicyPending(current => nextPendingByProvider(current, provider, 1));
    void mutation.mutateAsync(mutationArgs(provider, draft))
      .then((result) => saveCommittedPolicy(queryClient, configKey, result))
      .catch((error: Error) => setProviderError(setPolicyErrors, provider, error instanceof Error ? error.message : String(error)))
      .finally(() => setPolicyPending(current => nextPendingByProvider(current, provider, -1)));
  };

  return {
    isPolicySaving: (provider) => (policyPending[provider] ?? 0) > 0,
    getPolicyError: (provider) => policyErrors[provider] ? { message: policyErrors[provider] ?? '' } : null,
    savePolicy,
  };
}

export function useUsage(): UsageFeatureState {
  const nowSec = useNowSeconds();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const lang = useLang();
  const statusOptions = trpc.system.usageStatus.queryOptions({});
  const configOptions = trpc.config.get.queryOptions({});
  const query = useQuery(statusOptions);
  const configQuery = useQuery(configOptions);
  const refresh = useMutation(trpc.system.refreshUsage.mutationOptions({
    onSuccess: (data) => queryClient.setQueryData(statusOptions.queryKey, data),
  }));
  const providerRateLimits = readProviderRateLimits(configQuery.data);
  const controlsState = readPolicyControlsState(configQuery.isLoading, configQuery.isError, providerRateLimits);
  const saveMutation = useMutation(trpc.config.setProviderRateLimitPolicy.mutationOptions());
  const policySave = usePolicySave(controlsState, saveMutation, queryClient, configOptions.queryKey);

  return {
    view: buildUsageView(query.data as SystemUsageStatus | undefined, readViewPolicyConfig(controlsState, providerRateLimits), nowSec, lang),
    isLoading: query.isLoading,
    queryError: query.isError ? query.error : null,
    refreshError: refresh.isError ? refresh.error : null,
    isRefreshing: refresh.isPending,
    policyControlsState: controlsState,
    isPolicySaving: policySave.isPolicySaving,
    getPolicyError: policySave.getPolicyError,
    refresh: () => refresh.mutate({} as unknown as Parameters<typeof refresh.mutate>[0]),
    savePolicy: policySave.savePolicy,
  };
}
