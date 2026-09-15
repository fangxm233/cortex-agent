import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  appCalls: 0,
  hotCalls: 0,
  app: null as any,
  hot: null as any,
}));

vi.mock('@/features/app-update/useAppUpdate', () => ({
  useAppUpdate: () => {
    harness.appCalls += 1;
    return harness.app;
  },
}));
vi.mock('@/features/hot-update/useHotUpdate', () => ({
  useHotUpdate: () => {
    harness.hotCalls += 1;
    return harness.hot;
  },
}));

import { useUpdatePrompt, type UpdatePrompt } from './useUpdatePrompt';

let prompt: UpdatePrompt = null;
function Probe() {
  prompt = useUpdatePrompt();
  return null;
}

beforeEach(() => {
  harness.appCalls = 0;
  harness.hotCalls = 0;
  harness.app = {
    pending: null, update: null, busy: false, error: null,
    install: vi.fn(), skip: vi.fn(), dismiss: vi.fn(),
  };
  harness.hot = { staged: null, apply: vi.fn(), dismiss: vi.fn() };
  prompt = null;
});

describe('useUpdatePrompt', () => {
  it('owns both source hooks and gives app updates priority', () => {
    harness.app.pending = { version: '2026.8.1', kind: 'apk', apply: 'prompt' };
    harness.app.update = harness.app.pending;
    harness.hot.staged = { version: 'frontend-b7e2' };
    act(() => { create(<Probe />); });

    expect(harness.appCalls).toBe(1);
    expect(harness.hotCalls).toBe(1);
    expect(prompt?.kind).toBe('app');
  });

  it('keeps hot updates hidden while an app update is gated or dismissed', () => {
    harness.app.pending = { version: '2026.8.1', kind: 'apk', apply: 'prompt' };
    harness.hot.staged = { version: 'frontend-b7e2' };
    act(() => { create(<Probe />); });

    expect(prompt).toBeNull();
  });

  it('never raises a modal for an update the shell installs on its own', () => {
    // A silent update is announced by a toast only; a dialog would defeat the whole point.
    harness.app.pending = { version: '2026.8.1', kind: 'nsis', apply: 'silent' };
    harness.app.update = harness.app.pending;
    act(() => { create(<Probe />); });

    expect(prompt).toBeNull();
  });

  it('lets a hot update through while an app update installs silently', () => {
    // The silent app update is not "an app prompt in progress", so it must not hold the
    // frontend prompt back the way a pending dialog does.
    harness.app.pending = { version: '2026.8.1', kind: 'nsis', apply: 'silent' };
    harness.app.update = harness.app.pending;
    harness.hot.staged = { version: 'frontend-b7e2' };
    act(() => { create(<Probe />); });

    expect(prompt?.kind).toBe('hot');
  });

  it('falls through to hot updates and then to no prompt', () => {
    harness.hot.staged = { version: 'frontend-b7e2' };
    let renderer: ReturnType<typeof create>;
    act(() => { renderer = create(<Probe />); });
    expect(prompt?.kind).toBe('hot');

    harness.hot.staged = null;
    act(() => { renderer.update(<Probe />); });
    expect(prompt).toBeNull();
  });
});
