// input:  mobile runtime screens, keyed descriptors and snapshot-backed writer fake
// output: advanced row identity, safe integer gating and setting-key write regressions
// pos:    Verifies mobile runtime views without desktop view ownership
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { ADVANCED_FLAGS, ADVANCED_NUMBER_SETTINGS } from '@/features/settings/platform-env';

const adapter = vi.hoisted(() => ({
  onSet: vi.fn(),
  onToggle: vi.fn(),
  snapshot: null as ConfigSnapshot | null,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: adapter.snapshot, isLoading: false, isError: false }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ config: { get: { queryOptions: () => ({}) } } }),
}));

vi.mock('@/features/settings/runtime-settings-writer', () => ({
  useRuntimeSettingWrite: () => ({
    pending: false,
    onSet: adapter.onSet,
    onToggle: adapter.onToggle,
  }),
}));

import { MAdvancedScreen } from './MRuntimeSettingsScreen';

const snapshot: ConfigSnapshot = {
  budget: null,
  profiles: null,
  machines: [],
  mcp: null,
  threadTemplates: { agents: [], templates: [], shells: [] },
  hooks: [],
  env: [
    { key: 'DEBUG', present: true, masked: '••••••••' },
    { key: 'CORTEX_GPU_MONITOR_MOCK', present: false, masked: '' },
  ],
  settings: [
    { key: 'eventLog', value: true, source: 'default' },
    { key: 'diskMonitor', value: true, source: 'default' },
    { key: 'showToolCalls', value: false, source: 'file' },
    { key: 'disableUserContext', value: true, source: 'env' },
    { key: 'serverUpdateDisable', value: false, source: 'default' },
    { key: 'sessionRetentionDays', value: 30, source: 'file' },
    { key: 'taskDispatchMaxConcurrent', value: 6, source: 'file' },
    { key: 'taskDispatchEnabled', value: true, source: 'file' },
    { key: 'taskDispatchIntervalMs', value: 30_000, source: 'file' },
    { key: 'taskArchiveEnabled', value: true, source: 'file' },
    { key: 'taskArchiveIntervalMs', value: 21_600_000, source: 'file' },
    { key: 'memoryIndexRegenEnabled', value: true, source: 'file' },
    { key: 'memoryIndexRegenIntervalMs', value: 86_400_000, source: 'file' },
  ],
};

function mountAdvanced(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MemoryRouter><LangProvider><MAdvancedScreen /></LangProvider></MemoryRouter>,
    );
  });
  return renderer;
}

describe('mobile runtime Advanced settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapter.snapshot = snapshot;
  });

  it('renders every advanced row by descriptor identity or setting key', () => {
    const renderer = mountAdvanced();
    const keys = renderer.root.findAll(node => typeof node.props['data-settings-row'] === 'string')
      .map(node => node.props['data-settings-row']);
    const flagKeys = ADVANCED_FLAGS.map(flag => flag.kind === 'env' ? flag.env : flag.setting);
    const numberKeys = ADVANCED_NUMBER_SETTINGS.map(descriptor => descriptor.setting);

    expect(keys).toEqual(expect.arrayContaining([...flagKeys, ...numberKeys]));
    expect(renderer.root.findByProps({ 'data-settings-row': 'DEBUG' })
      .findByProps({ role: 'switch' }).props.disabled).toBe(true);
  });

  it('writes retention by its descriptor key and rejects unsafe integer drafts', () => {
    const renderer = mountAdvanced();
    const row = renderer.root.findByProps({ 'data-settings-row': 'sessionRetentionDays' });
    const input = row.findByType('input');
    const save = row.findByType('button');

    act(() => input.props.onChange({ target: { value: String(Number.MAX_SAFE_INTEGER + 1) } }));
    expect(row.findByType('button').props.disabled).toBe(true);

    act(() => input.props.onChange({ target: { value: '45' } }));
    expect(row.findByType('button').props.disabled).toBe(false);
    act(() => save.props.onClick());
    expect(adapter.onSet).toHaveBeenCalledWith('sessionRetentionDays', 45);
  });
});
