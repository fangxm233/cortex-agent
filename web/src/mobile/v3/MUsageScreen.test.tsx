// input:  mobile Usage screen with navigation and public hook fakes
// output: settings-back and refresh container wiring regressions
// pos:    Verifies the mobile Usage screen bindings
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  navigate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('react-router-dom', async importOriginal => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: () => harness.navigate,
}));

vi.mock('@/i18n', async importOriginal => ({
  ...await importOriginal<typeof import('@/i18n')>(),
  useLang: () => 'en',
}));

vi.mock('@/features/usage', async importOriginal => ({
  ...await importOriginal<typeof import('@/features/usage')>(),
  useUsage: () => ({
    view: { providers: [] }, isLoading: false, queryError: null, refreshError: null,
    isRefreshing: false, refresh: harness.refresh,
  }),
}));

import { MUsageScreen } from './MUsageScreen';

describe('MUsageScreen bindings', () => {
  it('returns to Settings with replacement and forwards refresh to the public hook', () => {
    const renderer = create(<MUsageScreen />);

    act(() => renderer.root.findByProps({ 'aria-label': 'Back' }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-usage-refresh': true }).props.onClick());

    expect(harness.navigate).toHaveBeenCalledWith('/m/settings', { replace: true });
    expect(harness.refresh).toHaveBeenCalledTimes(1);
  });
});
