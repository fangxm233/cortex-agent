// input:  UsagePanel with tRPC query/mutation fakes and per-window config snapshots
// output: refresh, row policy, config gating, and pending-operation regressions
// pos:    Verifies functional desktop Usage interactions and shared hook wiring
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigSnapshot, ConfigSettingEntry, SystemUsageStatus } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

const NOW = Math.floor(Date.now() / 1000);
const usage: SystemUsageStatus = [
  {
    provider: 'anthropic', displayName: 'Anthropic', modes: ['plan'], freshness: 'live', observedAt: NOW - 60,
    windows: [
      { type: 'five_hour', utilization: 0.54, resetsAt: NOW + 3600 },
      { type: 'seven_day', utilization: 0.31, resetsAt: NOW - 60 },
      { type: 'seven_day_overage_included', utilization: 0.74, resetsAt: NOW + 2 * 86400 },
      { type: 'model_scoped', label: 'Fable', utilization: 0.33, resetsAt: null },
      { type: 'model_scoped', label: 'Lyric', utilization: null, resetsAt: null },
    ],
  },
  {
    provider: 'openai-codex', displayName: 'OpenAI Codex', modes: ['openai-codex'], freshness: 'stale', observedAt: NOW - 600,
    windows: [
      { type: 'codex_primary', utilization: 0.62, resetsAt: NOW + 7200 },
      { type: 'codex_secondary', utilization: 0.18, resetsAt: NOW + 86400 },
    ],
  },
  {
    provider: 'deepseek', displayName: 'DeepSeek', modes: ['deepseek'], freshness: 'unsupported', observedAt: NOW - 120,
    windows: [], spend: { today: 1.25, month: 9.5 },
  },
  {
    provider: 'qwen-ksu', displayName: 'Qwen KSU', modes: ['qwen-ksu'], freshness: 'unsupported', observedAt: null,
    windows: [], spend: { today: 0, month: 2 },
  },
  {
    provider: 'openrouter', displayName: 'OpenRouter', modes: ['openrouter'], freshness: 'never', observedAt: null,
    windows: [], note: 'push-only: waiting for next call',
  },
];

function policyEntry(value: ConfigSettingEntry['value']): ConfigSettingEntry {
  return { key: 'providerRateLimits', value, source: 'file' };
}

const baseConfig: ConfigSnapshot = {
  budget: null,
  profiles: null,
  machines: [],
  mcp: null,
  threadTemplates: { agents: [], templates: [], shells: [] },
  hooks: [],
  env: [],
  settings: [policyEntry({
    anthropic: {
      enabled: false,
      threshold: 0.82,
      windows: [
        { type: 'five_hour', enabled: true, threshold: 0.76 },
        { type: 'seven_day', enabled: true },
        { type: 'model_scoped', label: 'Fable', enabled: false },
      ],
    },
    'openai-codex': { windows: [{ type: 'codex_primary', enabled: true, threshold: 0.91 }] },
  })],
};

let currentUsage = usage;
let currentConfig = baseConfig;

function targetKey(provider: string, windowType?: string, windowLabel?: string | null): string {
  return [provider, windowType ?? '', windowLabel ?? ''].join('::');
}

function providerRateLimitsValue(snapshot: ConfigSnapshot) {
  return snapshot.settings?.find((entry: ConfigSettingEntry) => entry.key === 'providerRateLimits')?.value as any;
}

const harness = vi.hoisted(() => ({
  mutations: [] as { kind: string; args: unknown }[],
  queryWrites: [] as { key: unknown; value: unknown }[],
  refreshPending: false,
  usageQueryError: null as Error | null,
  refreshError: null as Error | null,
  configLoading: false,
  configError: null as Error | null,
  deferredPolicySaves: {} as Record<string, Promise<unknown>>,
  policyErrorsByTarget: {} as Record<string, Error | null>,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    system: {
      usageStatus: {
        queryOptions: () => ({ __kind: 'system.usageStatus', queryKey: ['system.usageStatus', {}] }),
        queryFilter: () => ({ queryKey: ['system.usageStatus'] }),
      },
      refreshUsage: {
        mutationOptions: (options: object) => ({ __kind: 'system.refreshUsage', ...options }),
      },
    },
    config: {
      get: {
        queryOptions: () => ({ __kind: 'config.get', queryKey: ['config.get', {}] }),
        queryFilter: () => ({ queryKey: ['config.get', {}] }),
      },
      setProviderRateLimitPolicy: {
        mutationOptions: (options: object) => ({ __kind: 'config.setProviderRateLimitPolicy', ...options }),
      },
    },
  }),
}));

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: (options: any) => {
    if (options.__kind === 'config.get') {
      return {
        data: harness.configError || harness.configLoading ? undefined : currentConfig,
        isLoading: harness.configLoading,
        isError: harness.configError !== null,
        error: harness.configError,
      };
    }
    return {
      data: harness.usageQueryError ? undefined : currentUsage,
      isLoading: false,
      isError: harness.usageQueryError !== null,
      error: harness.usageQueryError,
    };
  },
  useMutation: (options: any) => {
    if (options.__kind === 'config.setProviderRateLimitPolicy') {
      return {
        mutateAsync: async (args: any) => {
          harness.mutations.push({ kind: options.__kind, args });
          const key = targetKey(args.provider, args.windowType, args.windowLabel);
          const deferred = harness.deferredPolicySaves[key];
          if (deferred) await deferred;
          const error = harness.policyErrorsByTarget[key] ?? null;
          if (error) throw error;
          return {
            written: true,
            policy: {
              provider: args.provider,
              windowType: args.windowType,
              windowLabel: args.windowLabel,
              enabled: args.enabled,
              threshold: args.threshold ?? null,
            },
          };
        },
        mutate: undefined,
        isPending: false,
        isError: false,
        error: null,
      };
    }
    return {
      mutate: (args: unknown) => {
        harness.mutations.push({ kind: options.__kind, args });
        options.onSuccess?.(currentUsage);
      },
      mutateAsync: async (args: unknown) => {
        harness.mutations.push({ kind: options.__kind, args });
        options.onSuccess?.(currentUsage);
        return currentUsage;
      },
      isPending: harness.refreshPending,
      isError: harness.refreshError !== null,
      error: harness.refreshError,
    };
  },
  useQueryClient: () => ({
    setQueryData: (key: unknown, value: unknown) => {
      const resolved = typeof value === 'function'
        ? (value as (current: unknown) => unknown)(Array.isArray(key) && key[0] === 'config.get' ? currentConfig : currentUsage)
        : value;
      harness.queryWrites.push({ key, value: resolved });
      if (Array.isArray(key) && key[0] === 'config.get') currentConfig = resolved as ConfigSnapshot;
      if (Array.isArray(key) && key[0] === 'system.usageStatus') currentUsage = resolved as SystemUsageStatus;
      return resolved;
    },
  }),
}));

import { UsagePanel } from './UsagePanel';

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LangProvider><UsagePanel /></LangProvider>); });
  return renderer;
}

function toggle(renderer: ReactTestRenderer, key: string) {
  return renderer.root.findByProps({ 'aria-label': `Usage throttle ${key}` });
}

function thresholdInput(renderer: ReactTestRenderer, key: string) {
  return renderer.root.findByProps({ 'data-usage-threshold-input': key });
}

function saveButton(renderer: ReactTestRenderer, key: string) {
  return renderer.root.findByProps({ 'data-usage-threshold-save': key });
}

function resetButton(renderer: ReactTestRenderer, key: string) {
  return renderer.root.findByProps({ 'data-usage-threshold-reset': key });
}

beforeEach(() => {
  currentUsage = usage;
  currentConfig = baseConfig;
  harness.mutations = [];
  harness.queryWrites = [];
  harness.refreshPending = false;
  harness.usageQueryError = null;
  harness.refreshError = null;
  harness.configLoading = false;
  harness.configError = null;
  harness.deferredPolicySaves = {};
  harness.policyErrorsByTarget = {};
});

describe('desktop Settings Usage panel', () => {
  it('hides row policy controls while config is loading, missing, or failed without hiding usage', () => {
    const cases = [
      () => { harness.configLoading = true; },
      () => { currentConfig = { ...baseConfig, settings: [] }; },
      () => { harness.configError = new Error('config unavailable'); },
    ];

    for (const setup of cases) {
      setup();
      const renderer = mount();
      expect(renderer.root.findAllByProps({ 'data-usage-quota': 'anthropic' })).toHaveLength(1);
      expect(renderer.root.findAllByProps({ 'data-usage-policy-row': targetKey('anthropic', 'five_hour') })).toHaveLength(0);
      expect(renderer.root.findAllByProps({ 'data-usage-legacy-fallback': 'anthropic' })).toHaveLength(0);
      expect(renderer.root.findAllByProps({ 'data-usage-threshold-input': targetKey('anthropic', 'five_hour') })).toHaveLength(0);
      currentConfig = baseConfig;
      harness.configLoading = false;
      harness.configError = null;
    }
  });

  it('saves exact row targets, clears legacy fallback, and keeps fallback resets explicit in cache', async () => {
    const renderer = mount();
    const fiveHour = targetKey('anthropic', 'five_hour');
    const overage = targetKey('anthropic', 'seven_day_overage_included');

    act(() => thresholdInput(renderer, fiveHour).props.onChange({ target: { value: '83' } }));
    await act(async () => { await saveButton(renderer, fiveHour).props.onClick(); });
    await act(async () => { await resetButton(renderer, overage).props.onClick(); });
    await act(async () => {
      await renderer.root.findByProps({ 'data-usage-legacy-clear': 'anthropic' }).props.onClick();
    });

    expect(harness.mutations).toContainEqual({
      kind: 'config.setProviderRateLimitPolicy',
      args: { provider: 'anthropic', windowType: 'five_hour', enabled: true, threshold: 0.83 },
    });
    expect(harness.mutations).toContainEqual({
      kind: 'config.setProviderRateLimitPolicy',
      args: { provider: 'anthropic', windowType: 'seven_day_overage_included', enabled: true },
    });
    expect(harness.mutations).toContainEqual({
      kind: 'config.setProviderRateLimitPolicy',
      args: { provider: 'anthropic', enabled: true },
    });
    expect(providerRateLimitsValue(currentConfig).anthropic).toEqual({
      windows: [
        { type: 'seven_day', enabled: true },
        { type: 'model_scoped', label: 'Fable', enabled: false },
        { type: 'five_hour', enabled: true, threshold: 0.83 },
        { type: 'seven_day_overage_included', enabled: true },
      ],
    });
  });

  it('tracks pending and errors per row without blocking sibling rows or refresh', async () => {
    const fiveHour = targetKey('anthropic', 'five_hour');
    const sevenDay = targetKey('anthropic', 'seven_day');
    const codexPrimary = targetKey('openai-codex', 'codex_primary');
    let resolveFiveHour!: () => void;
    harness.deferredPolicySaves[fiveHour] = new Promise<void>((resolve) => { resolveFiveHour = resolve; });
    const renderer = mount();

    act(() => thresholdInput(renderer, fiveHour).props.onChange({ target: { value: '84' } }));
    await act(async () => {
      saveButton(renderer, fiveHour).props.onClick();
      await Promise.resolve();
    });

    expect(saveButton(renderer, fiveHour).props.disabled).toBe(true);
    expect(toggle(renderer, fiveHour).props['aria-disabled']).toBe(true);
    expect(thresholdInput(renderer, sevenDay).props.disabled).toBe(false);
    expect(toggle(renderer, sevenDay).props['aria-disabled']).toBe(false);
    act(() => renderer.root.findByProps({ 'data-usage-refresh': true }).props.onClick());
    expect(harness.mutations).toContainEqual({ kind: 'system.refreshUsage', args: {} });

    act(() => { resolveFiveHour(); });
    await act(async () => { await Promise.resolve(); });

    harness.policyErrorsByTarget[codexPrimary] = new Error('write failed');
    await act(async () => { await toggle(renderer, codexPrimary).props.onClick(); });
    expect(JSON.stringify(renderer.toJSON())).toContain('write failed');
  });

  it('invokes system.refreshUsage on every click and writes the returned snapshot', () => {
    const renderer = mount();
    const refresh = renderer.root.findByProps({ 'data-usage-refresh': true });

    act(() => refresh.props.onClick());
    act(() => refresh.props.onClick());

    expect(harness.mutations).toEqual([
      { kind: 'system.refreshUsage', args: {} },
      { kind: 'system.refreshUsage', args: {} },
    ]);
    expect(harness.queryWrites).toContainEqual({ key: ['system.usageStatus', {}], value: usage });
  });

  it('keeps refresh unthrottled and clickable while a refresh is pending', () => {
    harness.refreshPending = true;
    const renderer = mount();
    const refresh = renderer.root.findByProps({ 'data-usage-refresh': true });

    expect(refresh.props.disabled).toBeFalsy();
    act(() => refresh.props.onClick());
    act(() => refresh.props.onClick());
    expect(harness.mutations).toHaveLength(2);
  });
});
