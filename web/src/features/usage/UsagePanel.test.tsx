// input:  UsagePanel with tRPC query/mutation fakes, per-window config snapshots, and vocab
// output: query, refresh, row policy, legacy fallback, severity, and error rendering regressions
// pos:    Verifies the desktop Settings Usage surface and shared hook wiring
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigSnapshot, ConfigSettingEntry, SystemUsageStatus } from '@cortex-agent/ui-contract';
import { en, LangProvider, zh } from '@/i18n';
import { getSettingsNav, getSectionMeta } from '@/features/settings/settings-nav';

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
  queried: [] as string[],
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
    harness.queried.push(options.__kind);
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
  harness.queried = [];
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

afterEach(() => vi.useRealTimers());

describe('desktop Settings Usage panel', () => {
  it('adds bilingual Usage navigation and metadata through exhaustive records', () => {
    expect(getSettingsNav(en).find(entry => entry.key === 'usage')).toEqual({ key: 'usage', label: 'Usage' });
    expect(getSettingsNav(zh).find(entry => entry.key === 'usage')).toEqual({ key: 'usage', label: '用量' });
    expect(getSectionMeta(en, 'usage').sub).toContain('system.usageStatus');
    expect(getSectionMeta(zh, 'usage').sub).toContain('system.usageStatus');
  });

  it('renders row-local controls, a compact legacy fallback notice, and one future hint per provider', () => {
    const renderer = mount();
    const html = JSON.stringify(renderer.toJSON());

    expect(harness.queried).toEqual(['system.usageStatus', 'config.get']);
    expect(renderer.root.findAllByProps({ 'data-usage-spend': 'deepseek' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-spend': 'qwen-ksu' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-policy': 'anthropic' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-policy': 'openai-codex' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-policy-row': targetKey('anthropic', 'five_hour') })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-policy-row': targetKey('anthropic', 'seven_day') })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-policy-row': targetKey('anthropic', 'seven_day_overage_included') })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-policy-row': targetKey('anthropic', 'model_scoped', 'Fable') })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-policy-row': targetKey('anthropic', 'model_scoped', 'Lyric') })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-policy-row': targetKey('openai-codex', 'codex_primary') })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-policy-row': targetKey('openai-codex', 'codex_secondary') })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-threshold-input': targetKey('openrouter', 'five_hour') })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-legacy-fallback': 'anthropic' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-legacy-fallback': 'openai-codex' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-policy-future-hint': 'anthropic' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-policy-future-hint': 'openai-codex' })).toHaveLength(1);
    expect(html).toContain('7 days (incl. overage)');
    expect(html).toContain('Legacy fallback');
    expect(html).toContain('Default 95%');
    expect(html).toContain('Default 90%');
    expect(html).toContain('$1.25');
  });

  it('hides row policy controls while config is loading, missing, or failed without hiding usage', () => {
    const cases = [
      () => { harness.configLoading = true; },
      () => { currentConfig = { ...baseConfig, settings: [] }; },
      () => { harness.configError = new Error('config unavailable'); },
    ];

    for (const setup of cases) {
      setup();
      const renderer = mount();
      const html = JSON.stringify(renderer.toJSON());
      expect(html).toContain('Anthropic');
      expect(renderer.root.findAllByProps({ 'data-usage-quota': 'anthropic' })).toHaveLength(1);
      expect(renderer.root.findAllByProps({ 'data-usage-spend': 'deepseek' })).toHaveLength(1);
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

  it('shows a freshness badge only for live providers', () => {
    const renderer = mount();

    expect(renderer.root.findAllByProps({ 'data-usage-freshness': 'live' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-freshness': 'stale' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-freshness': 'never' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-freshness': 'unsupported' })).toHaveLength(0);
  });

  it('gives model-scoped windows with a shared reset time distinct React identities', () => {
    currentUsage = [{
      provider: 'anthropic', displayName: 'Anthropic', modes: ['plan'], freshness: 'live',
      observedAt: NOW,
      windows: [
        { type: 'model_scoped', label: 'Fable', utilization: 0.33, resetsAt: null },
        { type: 'model_scoped', label: 'Unlisted Model', utilization: null, resetsAt: null },
      ],
    }];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    mount();

    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
    consoleError.mockRestore();
  });

  it('advances observed freshness while the panel remains open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const renderer = mount();

    expect(renderer.root.findAllByType('time')[0].children.join('')).toBe('1m ago');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(renderer.root.findAllByType('time')[0].children.join('')).toBe('2m ago');
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

  it('escalates meter severity and renders only error-tone notes', () => {
    currentUsage = [
      {
        provider: 'anthropic', displayName: 'Anthropic', modes: ['plan'], freshness: 'stale', observedAt: NOW - 60,
        windows: [
          { type: 'five_hour', utilization: 0.72, resetsAt: NOW + 3600 },
          { type: 'seven_day', utilization: 0.93, resetsAt: NOW + 86400 },
        ],
        note: 'Anthropic usage collection failed: HTTP 429',
      },
      {
        provider: 'openrouter', displayName: 'OpenRouter', modes: ['openrouter'], freshness: 'never',
        observedAt: null, windows: [], note: 'push-only: waiting for next call',
      },
    ];
    const renderer = mount();
    const html = JSON.stringify(renderer.toJSON());

    expect(renderer.root.findAllByProps({ 'data-usage-severity': 'warning' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-severity': 'danger' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-note': 'error' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-note': 'info' })).toHaveLength(0);
    expect(html).toContain('usage collection failed');
    expect(html).not.toContain('push-only: waiting for next call');
  });

  it('renders usage query and refresh failures without hiding successful snapshots', () => {
    harness.usageQueryError = new Error('status unavailable');
    const failedQuery = JSON.stringify(mount().toJSON());
    expect(failedQuery).toContain('Failed to load usage');
    expect(failedQuery).toContain('status unavailable');

    harness.usageQueryError = null;
    harness.refreshError = new Error('refresh unavailable');
    const failedRefresh = mount();
    const html = JSON.stringify(failedRefresh.toJSON());
    expect(html).toContain('Refresh failed');
    expect(html).toContain('refresh unavailable');
    expect(html).toContain('Anthropic');
  });

  it('keeps refresh unthrottled and clickable while spinning during a pending refresh', () => {
    const idle = mount();
    expect(idle.root.findAllByType('animateTransform')).toHaveLength(0);

    harness.refreshPending = true;
    const renderer = mount();
    const refresh = renderer.root.findByProps({ 'data-usage-refresh': true });
    const html = JSON.stringify(renderer.toJSON());

    expect(refresh.props.disabled).toBeFalsy();
    act(() => refresh.props.onClick());
    act(() => refresh.props.onClick());
    expect(harness.mutations).toHaveLength(2);
    expect(renderer.root.findAllByType('animateTransform')).toHaveLength(1);
    expect(html).toContain('Refreshing…');
    expect(html).toContain('Live');
  });
});
