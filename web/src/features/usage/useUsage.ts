// input:  React clock, usage/config queries, row-policy writes, and selected language
// output: queried usage view with refresh state and per-target policy visibility/controls
// pos:    Shared usage data hook for desktop and mobile consumers
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConfigSnapshot,
  ProviderRateLimitPolicy,
  ProviderRateLimitPolicyOverride,
  ProviderRateLimitWindowPolicyOverride,
  ProviderRateLimits,
  SystemUsageStatus,
} from '@cortex-agent/ui-contract';
import { useLang } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { buildUsageView, type UsagePolicyTarget, type UsageView, usagePolicyTargetKey } from './usage-vm';

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
  isPolicySaving: (target: UsagePolicyTarget) => boolean;
  getPolicyError: (target: UsagePolicyTarget) => { message: string } | null;
  refresh: () => void;
  savePolicy: (target: UsagePolicyTarget, draft: UsagePolicyDraft) => void;
}

interface PolicyMutationInput {
  provider: string;
  windowType?: string;
  windowLabel?: string;
  enabled: boolean;
  threshold?: number;
}

interface PolicyMutation {
  mutateAsync: (args: PolicyMutationInput) => Promise<{ policy: ProviderRateLimitPolicy }>;
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

function pendingKey(target: UsagePolicyTarget): string {
  return usagePolicyTargetKey(target);
}

function nextPendingByTarget(
  current: Record<string, number>,
  target: UsagePolicyTarget,
  delta: 1 | -1,
): Record<string, number> {
  const key = pendingKey(target);
  const nextCount = Math.max(0, (current[key] ?? 0) + delta);
  if (nextCount > 0) return { ...current, [key]: nextCount };
  return Object.fromEntries(Object.entries(current).filter(([item]) => item !== key));
}

function setTargetError(
  setPolicyErrors: Dispatch<SetStateAction<Record<string, string | null>>>,
  target: UsagePolicyTarget,
  message: string | null,
): void {
  setPolicyErrors((current) => ({ ...current, [pendingKey(target)]: message }));
}

function cloneWindowPolicy(window: ProviderRateLimitWindowPolicyOverride): ProviderRateLimitWindowPolicyOverride {
  return { ...window };
}

function cloneProviderPolicy(policy: ProviderRateLimitPolicyOverride | undefined): ProviderRateLimitPolicyOverride {
  if (!policy) return {};
  return {
    ...(policy.enabled === undefined ? {} : { enabled: policy.enabled }),
    ...(policy.threshold === undefined ? {} : { threshold: policy.threshold }),
    ...(policy.windows ? { windows: policy.windows.map(cloneWindowPolicy) } : {}),
  };
}

function matchesWindow(
  window: ProviderRateLimitWindowPolicyOverride,
  patch: ProviderRateLimitPolicy,
): boolean {
  return window.type === patch.windowType && window.label === patch.windowLabel;
}

function nextWindowPolicy(patch: ProviderRateLimitPolicy): ProviderRateLimitWindowPolicyOverride {
  return {
    type: patch.windowType!,
    ...(patch.windowLabel ? { label: patch.windowLabel } : {}),
    enabled: patch.enabled,
    ...(patch.threshold !== null ? { threshold: patch.threshold } : {}),
  };
}

function cleanProviderPolicy(policy: ProviderRateLimitPolicyOverride): ProviderRateLimitPolicyOverride | null {
  const next = cloneProviderPolicy(policy);
  if (!next.windows?.length) delete next.windows;
  if (next.enabled === undefined && next.threshold === undefined && !next.windows) return null;
  return next;
}

function hasLegacyProviderOverride(policy: ProviderRateLimitPolicyOverride): boolean {
  return policy.enabled === false || policy.threshold !== undefined;
}

function applyProviderPolicyPatch(
  current: ProviderRateLimitPolicyOverride | undefined,
  patch: ProviderRateLimitPolicy,
): ProviderRateLimitPolicyOverride | null {
  const next = cloneProviderPolicy(current);
  if (!patch.windowType) {
    delete next.enabled;
    delete next.threshold;
    if (!patch.enabled || patch.threshold !== null) next.enabled = patch.enabled;
    if (patch.threshold !== null) next.threshold = patch.threshold;
    return cleanProviderPolicy(next);
  }
  const windows = next.windows?.filter(
    (window: ProviderRateLimitWindowPolicyOverride) => !matchesWindow(window, patch),
  ) ?? [];
  const mustMaskLegacy = patch.enabled && patch.threshold === null && hasLegacyProviderOverride(next);
  if (!patch.enabled || patch.threshold !== null || mustMaskLegacy) windows.push(nextWindowPolicy(patch));
  next.windows = windows;
  return cleanProviderPolicy(next);
}

function applyPolicyToSnapshot(
  snapshot: ConfigSnapshot | undefined,
  policy: ProviderRateLimitPolicy,
): ConfigSnapshot | undefined {
  if (!snapshot?.settings) return snapshot;
  const index = snapshot.settings.findIndex(
    (entry: NonNullable<ConfigSnapshot['settings']>[number]) => entry.key === 'providerRateLimits',
  );
  if (index < 0) return snapshot;
  const current = snapshot.settings[index];
  const nextValue = isPlainObject(current.value) ? { ...current.value } as ProviderRateLimits : {};
  const nextPolicy = applyProviderPolicyPatch(nextValue[policy.provider], policy);
  if (nextPolicy) nextValue[policy.provider] = nextPolicy;
  else delete nextValue[policy.provider];
  const nextSettings = [...snapshot.settings];
  nextSettings[index] = { ...current, value: nextValue };
  return { ...snapshot, settings: nextSettings };
}

function percentToRatio(percent: number | null): number | null {
  if (percent === null) return null;
  return Math.round(percent * 100) / 10_000;
}

function mutationArgs(target: UsagePolicyTarget, draft: UsagePolicyDraft): PolicyMutationInput {
  const threshold = percentToRatio(draft.thresholdPercent);
  return {
    provider: target.provider,
    enabled: draft.enabled,
    ...(target.windowType ? { windowType: target.windowType } : {}),
    ...(target.windowLabel ? { windowLabel: target.windowLabel } : {}),
    ...(threshold === null ? {} : { threshold }),
  };
}

function saveCommittedPolicy(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  result: { policy: ProviderRateLimitPolicy },
): void {
  queryClient.setQueryData(queryKey, (current: unknown) => applyPolicyToSnapshot(
    current as ConfigSnapshot | undefined,
    result.policy,
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

  const savePolicy = (target: UsagePolicyTarget, draft: UsagePolicyDraft) => {
    if (controlsState !== 'ready') return;
    setTargetError(setPolicyErrors, target, null);
    setPolicyPending((current) => nextPendingByTarget(current, target, 1));
    void mutation.mutateAsync(mutationArgs(target, draft))
      .then((result) => saveCommittedPolicy(queryClient, configKey, result))
      .catch((error: Error) => setTargetError(setPolicyErrors, target, error instanceof Error ? error.message : String(error)))
      .finally(() => setPolicyPending((current) => nextPendingByTarget(current, target, -1)));
  };

  return {
    isPolicySaving: (target) => (policyPending[pendingKey(target)] ?? 0) > 0,
    getPolicyError: (target) => policyErrors[pendingKey(target)] ? { message: policyErrors[pendingKey(target)] ?? '' } : null,
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
    onSuccess: (data: SystemUsageStatus) => queryClient.setQueryData(statusOptions.queryKey, data),
  }));
  const providerRateLimits = readProviderRateLimits(configQuery.data);
  const controlsState = readPolicyControlsState(configQuery.isLoading, configQuery.isError, providerRateLimits);
  const saveMutation = useMutation(trpc.config.setProviderRateLimitPolicy.mutationOptions()) as unknown as PolicyMutation;
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
