// input:  UsagePanel with tRPC query/mutation fakes and bilingual vocab
// output: independent query, refresh, loading, and provider rendering regressions
// pos:    Verifies the desktop Settings Usage surface
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemUsageStatus } from '@cortex-agent/ui-contract';
import { en, LangProvider, zh } from '@/i18n';
import { getSettingsNav, getSectionMeta } from '@/features/settings/settings-nav';

const NOW = Math.floor(Date.now() / 1000);
const usage: SystemUsageStatus = [
  {
    provider: 'anthropic', displayName: 'Anthropic', modes: ['plan'], freshness: 'live', observedAt: NOW - 60,
    windows: [
      { type: 'five_hour', utilization: 0.54, resetsAt: NOW + 3600 },
      { type: 'seven_day', utilization: 0.31, resetsAt: NOW - 60 },
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

const harness = vi.hoisted(() => ({
  queried: [] as string[],
  mutations: [] as { kind: string; args: unknown }[],
  invalidations: [] as unknown[],
  pending: false,
  queryError: null as Error | null,
  refreshError: null as Error | null,
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
  }),
}));

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: (options: any) => {
    harness.queried.push(options.__kind);
    return {
      data: harness.queryError ? undefined : usage,
      isLoading: false,
      isError: harness.queryError !== null,
      error: harness.queryError,
    };
  },
  useMutation: (options: any) => ({
    mutate: (args: unknown) => {
      harness.mutations.push({ kind: options.__kind, args });
      options.onSuccess?.(usage);
    },
    isPending: harness.pending,
    isError: harness.refreshError !== null,
    error: harness.refreshError,
  }),
  useQueryClient: () => ({
    setQueryData: (key: unknown, value: unknown) => harness.invalidations.push({ key, value }),
  }),
}));

import { UsagePanel } from './UsagePanel';

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LangProvider><UsagePanel /></LangProvider>); });
  return renderer;
}

beforeEach(() => {
  harness.queried = [];
  harness.mutations = [];
  harness.invalidations = [];
  harness.pending = false;
  harness.queryError = null;
  harness.refreshError = null;
});

describe('desktop Settings Usage panel', () => {
  it('adds bilingual Usage navigation and metadata through exhaustive records', () => {
    expect(getSettingsNav(en).find(entry => entry.key === 'usage')).toEqual({ key: 'usage', label: 'Usage' });
    expect(getSettingsNav(zh).find(entry => entry.key === 'usage')).toEqual({ key: 'usage', label: '用量' });
    expect(getSectionMeta(en, 'usage').sub).toContain('system.usageStatus');
    expect(getSectionMeta(zh, 'usage').sub).toContain('system.usageStatus');
  });

  it('queries usage independently and separates quota windows from provider spend', () => {
    const renderer = mount();
    const html = JSON.stringify(renderer.toJSON());

    expect(harness.queried).toEqual(['system.usageStatus']);
    expect(renderer.root.findAllByProps({ 'data-usage-quota': 'anthropic' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-quota': 'openai-codex' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-spend': 'deepseek' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-spend': 'qwen-ksu' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-quota-state': 'unsupported' })).toHaveLength(2);
    expect(html).toContain('5 hours');
    expect(html).toContain('Primary');
    expect(html).toContain('Secondary');
    expect(html).toContain('Reset elapsed');
    expect(html).toContain('$1.25');
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
    expect(harness.invalidations).toEqual([
      { key: ['system.usageStatus', {}], value: usage },
      { key: ['system.usageStatus', {}], value: usage },
    ]);
  });

  it('renders query and refresh failures without hiding successful snapshots', () => {
    harness.queryError = new Error('status unavailable');
    const failedQuery = JSON.stringify(mount().toJSON());
    expect(failedQuery).toContain('Failed to load usage');
    expect(failedQuery).toContain('status unavailable');

    harness.queryError = null;
    harness.refreshError = new Error('refresh unavailable');
    const failedRefresh = mount();
    const html = JSON.stringify(failedRefresh.toJSON());
    expect(html).toContain('Refresh failed');
    expect(html).toContain('refresh unavailable');
    expect(html).toContain('Anthropic');
  });

  it('keeps refresh unthrottled while showing loading feedback and all freshness labels', () => {
    harness.pending = true;
    const renderer = mount();
    const refresh = renderer.root.findByProps({ 'data-usage-refresh': true });
    const html = JSON.stringify(renderer.toJSON());

    expect(refresh.props.disabled).toBeFalsy();
    act(() => refresh.props.onClick());
    act(() => refresh.props.onClick());
    expect(harness.mutations).toHaveLength(2);
    expect(html).toContain('Refreshing…');
    expect(html).toContain('Live');
    expect(html).toContain('Stale');
    expect(html).toContain('Never observed');
    expect(html).toContain('Unsupported');
  });
});
