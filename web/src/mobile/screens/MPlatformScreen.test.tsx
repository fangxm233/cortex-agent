import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';

const h = vi.hoisted(() => ({
  back: null as ((payload: unknown) => void) | null,
  navigate: vi.fn(),
  confirm: vi.fn(),
  historyBack: vi.fn(),
  dirty: true,
}));

vi.mock('@/lib/native-bridge', () => ({
  listenNativeBack: (handler: (payload: unknown) => void) => { h.back = handler; return () => { h.back = null; }; },
  safeInvoke: vi.fn(),
}));
vi.mock('@/i18n', async () => {
  const { en } = await import('@/i18n/vocab');
  return { useVocab: () => en, useVocabOptional: () => en };
});
vi.mock('react-router-dom', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: () => h.navigate,
}));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({ config: { get: { queryOptions: () => ({}) } } }) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { platforms: [] } as unknown as ConfigSnapshot, isLoading: false, isError: false, error: null }),
}));
vi.mock('@/features/settings/panels/PlatformPanel', () => ({
  PlatformPanel: ({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) => {
    useEffect(() => onDirtyChange(h.dirty), [onDirtyChange]);
    return null;
  },
}));

import { en } from '@/i18n/vocab';
import { useMobileBackNavigation } from '@/mobile/mobile-navigation';
import { MPlatformScreen } from './MPlatformScreen';

function Shell() {
  useMobileBackNavigation('/m/settings/platform', h.navigate);
  return <MPlatformScreen />;
}

let renderer: ReactTestRenderer;

beforeEach(() => {
  vi.clearAllMocks();
  h.dirty = true;
  vi.stubGlobal('window', { confirm: h.confirm, history: { state: { idx: 3 }, back: h.historyBack } });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

function mount(): void {
  act(() => { renderer = create(<Shell />); });
}

async function pressSystemBack(canGoBack: boolean): Promise<void> {
  await act(async () => { h.back?.({ canGoBack }); await Promise.resolve(); });
}

describe('mobile Platform settings unsaved changes', () => {
  it('keeps the screen when the system back is pressed and the user keeps the edits', async () => {
    h.confirm.mockReturnValue(false);
    mount();
    await pressSystemBack(true);
    await pressSystemBack(false);
    expect(h.confirm).toHaveBeenCalledWith(en.psUnsaved);
    expect(h.historyBack).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('leaves through the system back once the user discards the edits', async () => {
    h.confirm.mockReturnValue(true);
    mount();
    await pressSystemBack(false);
    expect(h.navigate).toHaveBeenCalledWith('/m/settings', { replace: true });
  });

  it('asks the same question from the header back button', () => {
    h.confirm.mockReturnValue(false);
    mount();
    act(() => renderer.root.findByProps({ 'aria-label': en.back }).props.onClick());
    expect(h.confirm).toHaveBeenCalledWith(en.psUnsaved);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('does not ask when nothing is unsaved', async () => {
    h.dirty = false;
    mount();
    await pressSystemBack(false);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.navigate).toHaveBeenCalledWith('/m/settings', { replace: true });
  });
});
