import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConfigSetProviderRateLimitPolicyReturn,
  ConfigSnapshot,
  ProviderRateLimits,
  ResetProvider,
  ResetStatus,
  SystemRedeemUsageResetReturn,
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

/** Spending a banked usage reset: always an explicit, confirmed user action. */
export interface UsageResetState {
  /** Spends a reset of the provider's default login, or of the named account `connection`: the
   *  given credit, else the one the server picks. */
  redeem: (provider: ResetProvider, connection: string | null, creditId?: string | null) => void;
  /** The account and credit of the running or last attempt in this view. */
  provider: ResetProvider | null;
  connection: string | null;
  creditId: string | null;
  isRedeeming: boolean;
  /** Outcome of the last attempt in this view. */
  status: ResetStatus | null;
  error: { message: string } | null;
}

export type UsageResetAttempt = Pick<UsageResetState, 'isRedeeming' | 'creditId' | 'status' | 'error'>;

/** The running or last attempt, as seen from one provider's card. */
export function resetAttemptFor(
  reset: UsageResetState, provider: ResetProvider | null, connection: string | null = null,
): UsageResetAttempt {
  if (provider === null || reset.provider !== provider || reset.connection !== connection) {
    return { isRedeeming: false, creditId: null, status: null, error: null };
  }
  return { isRedeeming: reset.isRedeeming, creditId: reset.creditId, status: reset.status, error: reset.error };
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
  reset: UsageResetState;
}

interface PolicyMutationInput {
  provider: string;
  account?: string;
  windowType?: string;
  windowLabel?: string;
  enabled: boolean;
  threshold?: number;
}

type PolicyMutationResult = Pick<ConfigSetProviderRateLimitPolicyReturn, 'policy' | 'providerPolicy'>;

interface PolicyMutation {
  mutateAsync: (args: PolicyMutationInput) => Promise<PolicyMutationResult>;
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

function nextPendingByTarget(
  current: Record<string, number>,
  target: UsagePolicyTarget,
  delta: 1 | -1,
): Record<string, number> {
  const key = usagePolicyTargetKey(target);
  const nextCount = Math.max(0, (current[key] ?? 0) + delta);
  if (nextCount > 0) return { ...current, [key]: nextCount };
  return Object.fromEntries(Object.entries(current).filter(([item]) => item !== key));
}

function setTargetError(
  setPolicyErrors: Dispatch<SetStateAction<Record<string, string | null>>>,
  target: UsagePolicyTarget,
  message: string | null,
): void {
  setPolicyErrors((current) => ({ ...current, [usagePolicyTargetKey(target)]: message }));
}

/** The server returns the provider's whole stored policy, so the cached snapshot takes it as is. */
function applyPolicyToSnapshot(
  snapshot: ConfigSnapshot | undefined,
  result: PolicyMutationResult,
): ConfigSnapshot | undefined {
  if (!snapshot?.settings) return snapshot;
  const index = snapshot.settings.findIndex(
    (entry: NonNullable<ConfigSnapshot['settings']>[number]) => entry.key === 'providerRateLimits',
  );
  if (index < 0) return snapshot;
  const current = snapshot.settings[index];
  const nextValue = isPlainObject(current.value) ? { ...current.value } as ProviderRateLimits : {};
  if (result.providerPolicy) nextValue[result.policy.provider] = result.providerPolicy;
  else delete nextValue[result.policy.provider];
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
    ...(target.account && target.windowType ? { account: target.account } : {}),
    ...(target.windowType ? { windowType: target.windowType } : {}),
    ...(target.windowLabel ? { windowLabel: target.windowLabel } : {}),
    ...(threshold === null ? {} : { threshold }),
  };
}

function saveCommittedPolicy(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  result: PolicyMutationResult,
): void {
  queryClient.setQueryData(queryKey, (current: unknown) => applyPolicyToSnapshot(
    current as ConfigSnapshot | undefined,
    result,
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
    isPolicySaving: (target) => (policyPending[usagePolicyTargetKey(target)] ?? 0) > 0,
    getPolicyError: (target) => policyErrors[usagePolicyTargetKey(target)] ? { message: policyErrors[usagePolicyTargetKey(target)] ?? '' } : null,
    savePolicy,
  };
}

function useUsageReset(
  trpc: ReturnType<typeof useTRPC>,
  queryClient: ReturnType<typeof useQueryClient>,
  statusKey: readonly unknown[],
): UsageResetState {
  const mutation = useMutation(trpc.system.redeemUsageReset.mutationOptions({
    onSuccess: (data: SystemRedeemUsageResetReturn) => queryClient.setQueryData(statusKey, data.usage),
  }));
  return {
    redeem: (provider, connection, creditId) => mutation.mutate({
      provider, ...(connection ? { connection } : {}), ...(creditId ? { creditId } : {}),
    }),
    provider: mutation.variables?.provider ?? null,
    connection: mutation.variables?.connection ?? null,
    creditId: mutation.variables?.creditId ?? null,
    isRedeeming: mutation.isPending,
    status: mutation.data?.status ?? null,
    error: mutation.isError ? mutation.error : null,
  };
}

function useRefreshUsage(
  trpc: ReturnType<typeof useTRPC>,
  queryClient: ReturnType<typeof useQueryClient>,
  statusKey: readonly unknown[],
) {
  const refresh = useMutation(trpc.system.refreshUsage.mutationOptions({
    onSuccess: (data: SystemUsageStatus) => queryClient.setQueryData(statusKey, data),
  }));
  return { refresh, run: () => refresh.mutate({} as unknown as Parameters<typeof refresh.mutate>[0]) };
}

// Only the Usage pages mount this hook, and opening one means the user wants current numbers, so
// it re-collects once on open instead of showing a snapshot up to one collection interval old.
// The ref keeps StrictMode's effect replay from collecting twice.
function useRefreshOnOpen(run: () => void): void {
  const refreshedOnOpen = useRef(false);
  useEffect(() => {
    if (refreshedOnOpen.current) return;
    refreshedOnOpen.current = true;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  const { refresh, run: runRefresh } = useRefreshUsage(trpc, queryClient, statusOptions.queryKey);
  const providerRateLimits = readProviderRateLimits(configQuery.data);
  const controlsState = readPolicyControlsState(configQuery.isLoading, configQuery.isError, providerRateLimits);
  const saveMutation = useMutation(trpc.config.setProviderRateLimitPolicy.mutationOptions()) as unknown as PolicyMutation;
  const policySave = usePolicySave(controlsState, saveMutation, queryClient, configOptions.queryKey);
  const reset = useUsageReset(trpc, queryClient, statusOptions.queryKey);
  useRefreshOnOpen(runRefresh);

  return {
    view: buildUsageView(query.data as SystemUsageStatus | undefined, readViewPolicyConfig(controlsState, providerRateLimits), nowSec, lang),
    isLoading: query.isLoading,
    queryError: query.isError ? query.error : null,
    refreshError: refresh.isError ? refresh.error : null,
    isRefreshing: refresh.isPending,
    policyControlsState: controlsState,
    ...policySave,
    refresh: runRefresh,
    reset,
  };
}
