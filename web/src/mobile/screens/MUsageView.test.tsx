import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderRateLimits, SystemUsageStatus } from '@cortex-agent/ui-contract';
import { buildUsageView } from '@/features/usage';
import { LangProvider } from '@/i18n';
import { MUsageView } from './MUsageView';

const NOW = 1_800_000_000;
const status: SystemUsageStatus = [
  {
    provider: 'anthropic', displayName: 'Anthropic', modes: ['plan'], freshness: 'live',
    observedAt: NOW - 60,
    windows: [
      { type: 'five_hour', utilization: 0.54, resetsAt: NOW + 3600 },
      { type: 'seven_day', utilization: 0.31, resetsAt: NOW + 86400 },
      { type: 'seven_day_overage_included', utilization: 0.74, resetsAt: NOW + 172800 },
      { type: 'model_scoped', label: 'Fable', utilization: 0.33, resetsAt: null },
      { type: 'model_scoped', label: 'Lyric', utilization: null, resetsAt: null },
    ],
  },
  {
    provider: 'openai-codex', displayName: 'OpenAI Codex', modes: ['openai-codex'],
    freshness: 'stale', observedAt: NOW - 600,
    windows: [
      { type: 'codex_primary', utilization: 0.62, resetsAt: NOW + 7200 },
      { type: 'codex_secondary', utilization: 0.18, resetsAt: NOW + 172800 },
    ],
  },
  {
    provider: 'deepseek', displayName: 'DeepSeek', modes: ['deepseek'], freshness: 'unsupported',
    observedAt: NOW - 120, windows: [], spend: { today: 1.25, month: 9.5 },
  },
  {
    provider: 'zai', displayName: 'Z.ai', modes: ['zai'], freshness: 'unsupported',
    observedAt: null, windows: [], spend: { today: 0, month: 2 }, billing: 'api',
  },
  {
    provider: 'openrouter', displayName: 'OpenRouter', modes: ['openrouter'], freshness: 'never',
    observedAt: null, windows: [], note: 'push-only: waiting for next call',
  },
];

const policies: ProviderRateLimits = {
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
};

function targetKey(provider: string, windowType?: string, windowLabel?: string | null): string {
  return [provider, windowType ?? '', windowLabel ?? ''].join('::');
}

function view(overrides: Partial<Parameters<typeof MUsageView>[0]> = {}) {
  return (
    <LangProvider>
    <MUsageView
      view={buildUsageView(status, policies, NOW, 'en')}
      isLoading={false}
      queryError={null}
      refreshError={null}
      isRefreshing={false}
      policyControlsState="ready"
      isPolicySaving={() => false}
      getPolicyError={() => null}
      reset={{ redeem: () => {}, provider: null, isRedeeming: false, status: null, error: null }}
      onBack={() => {}}
      onRefresh={() => {}}
      onSavePolicy={() => {}}
      {...overrides}
    />
    </LangProvider>
  );
}

describe('MUsageView policy controls', () => {
  it('saves exact row targets, resets fallback rows to explicit defaults, and clears legacy fallback', () => {
    const onSavePolicy = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(view({ onSavePolicy: onSavePolicy as any })); });

    const fiveHour = targetKey('anthropic', 'five_hour');
    const overage = targetKey('anthropic', 'seven_day_overage_included');
    expect(renderer.root.findAllByProps({ 'data-usage-threshold-input': fiveHour })).toHaveLength(0);
    for (const key of [fiveHour, overage]) {
      act(() => renderer.root.findByProps({ 'data-usage-policy-expand': key }).props.onClick());
    }
    act(() => renderer.root.findByProps({ 'data-usage-threshold-input': fiveHour }).props.onChange({ target: { value: '83' } }));
    act(() => renderer.root.findByProps({ 'data-usage-threshold-save': fiveHour }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-usage-threshold-reset': overage }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-usage-legacy-clear': 'anthropic' }).props.onClick());

    expect(onSavePolicy).toHaveBeenNthCalledWith(1,
      { provider: 'anthropic', windowType: 'five_hour', windowLabel: null },
      { enabled: true, thresholdPercent: 83 },
    );
    expect(onSavePolicy).toHaveBeenNthCalledWith(2,
      { provider: 'anthropic', windowType: 'seven_day_overage_included', windowLabel: null },
      { enabled: true, thresholdPercent: null },
    );
    expect(onSavePolicy).toHaveBeenNthCalledWith(3,
      { provider: 'anthropic', windowType: null, windowLabel: null },
      { enabled: true, thresholdPercent: null },
    );
  });

  it('hides row policy controls while config is unavailable without hiding quota or spend', () => {
    const renderer = create(view({
      view: buildUsageView(status, null, NOW, 'en'),
      policyControlsState: 'missing',
      isPolicySaving: () => true,
      getPolicyError: () => new Error('write failed'),
    }));

    expect(renderer.root.findAllByProps({ 'data-usage-policy-row': targetKey('anthropic', 'five_hour') })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-legacy-fallback': 'anthropic' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-threshold-input': targetKey('anthropic', 'five_hour') })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-usage-policy-expand': targetKey('anthropic', 'five_hour') })).toHaveLength(0);
  });

  it('opens a row editor on its own when that row has a save error', () => {
    const fiveHour = targetKey('anthropic', 'five_hour');
    const renderer = create(view({
      getPolicyError: (target) => (target.windowType === 'five_hour' ? new Error('write failed') : null),
    }));

    expect(renderer.root.findAllByProps({ 'data-usage-threshold-input': fiveHour })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-usage-threshold-input': targetKey('anthropic', 'seven_day') })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('write failed');
  });
});

describe('MUsageView refresh action', () => {
  it('does not impose a click throttle and renders pending feedback', () => {
    const onRefresh = vi.fn();
    const renderer = create(view({ onRefresh }));
    const button = renderer.root.findByProps({ 'data-usage-refresh': true });

    act(() => button.props.onClick());
    act(() => button.props.onClick());
    expect(onRefresh).toHaveBeenCalledTimes(2);

    act(() => renderer.update(view({ onRefresh, isRefreshing: true })));
    const pending = renderer.root.findByProps({ 'data-usage-refresh': true });
    expect(pending.props.disabled).not.toBe(true);
    act(() => pending.props.onClick());
    act(() => pending.props.onClick());
    expect(onRefresh).toHaveBeenCalledTimes(4);
  });
});

describe('MUsageView banked resets', () => {
  const withResets: SystemUsageStatus = status.map((record) => {
    if (record.provider === 'openai-codex') {
      return { ...record, resetCredits: { availableCount: 1, credits: [{ id: 'credit-1', title: 'Full reset', expiresAt: NOW + 2 * 86400 }] } };
    }
    if (record.provider === 'anthropic') {
      return { ...record, resetCredits: { availableCount: 1, atLimit: false, credits: [
        { id: 'grant_1', title: 'Reset', expiresAt: NOW + 4 * 86400, clears: ['five_hour'] },
      ] } };
    }
    return record;
  });
  const block = (renderer: ReturnType<typeof create>, provider: string) => renderer.root.findByProps({ 'data-usage-resets': provider });

  it('spends a reset only after the confirm step', () => {
    const redeem = vi.fn();
    const renderer = create(view({
      view: buildUsageView(withResets, policies, NOW, 'en'),
      reset: { redeem, provider: null, isRedeeming: false, status: null, error: null },
    }));
    expect(JSON.stringify(renderer.toJSON())).toContain('Banked resets 1 · next expires in 2d');

    act(() => block(renderer, 'openai-codex').findByProps({ 'data-usage-reset-use': true }).props.onClick());
    expect(redeem).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain('every device. This cannot be undone.');
    act(() => renderer.root.findByProps({ 'data-usage-reset-cancel': true }).props.onClick());
    expect(renderer.root.findAllByProps({ 'data-usage-reset-confirm': true })).toHaveLength(0);

    act(() => block(renderer, 'openai-codex').findByProps({ 'data-usage-reset-use': true }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-usage-reset-confirm-action': true }).props.onClick());
    expect(redeem).toHaveBeenCalledWith('openai-codex');
  });

  it('confirms a Claude reset with the windows it clears and the current use', () => {
    const redeem = vi.fn();
    const renderer = create(view({
      view: buildUsageView(withResets, policies, NOW, 'en'),
      reset: { redeem, provider: null, isRedeeming: false, status: null, error: null },
    }));

    act(() => block(renderer, 'anthropic').findByProps({ 'data-usage-reset-use': true }).props.onClick());
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Clears the 5 hours limits for the whole account, claude.ai and every other device included.');
    expect(text).toContain('Not at a limit right now: 5 hours 54%.');
    act(() => renderer.root.findByProps({ 'data-usage-reset-confirm-action': true }).props.onClick());
    expect(redeem).toHaveBeenCalledWith('anthropic');
  });

  it('shows the outcome on its own card and offers no reset without one', () => {
    const spent = withResets.map((record) => (record.provider === 'openai-codex'
      ? { ...record, resetCredits: { availableCount: 0, credits: [] } }
      : record));
    const renderer = create(view({
      view: buildUsageView(spent, policies, NOW, 'en'),
      reset: { redeem: vi.fn(), provider: 'openai-codex', isRedeeming: false, status: 'reset', error: null },
    }));

    expect(block(renderer, 'openai-codex').findAllByProps({ 'data-usage-reset-use': true })).toHaveLength(0);
    expect(block(renderer, 'openai-codex').findByProps({ 'data-usage-reset-outcome': 'reset' })).toBeTruthy();
    expect(block(renderer, 'anthropic').findAllByProps({ 'data-usage-reset-outcome': 'reset' })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('Reset used, usage restored');
  });

  it('disables every reset button while one is being spent', () => {
    const renderer = create(view({
      view: buildUsageView(withResets, policies, NOW, 'en'),
      reset: { redeem: vi.fn(), provider: 'anthropic', isRedeeming: true, status: null, error: null },
    }));

    const claude = block(renderer, 'anthropic').findByProps({ 'data-usage-reset-use': true });
    const codex = block(renderer, 'openai-codex').findByProps({ 'data-usage-reset-use': true });
    expect([claude.props.disabled, codex.props.disabled]).toEqual([true, true]);
    expect(JSON.stringify(renderer.toJSON())).toContain('Using reset…');
  });
});
