import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  serverCalls: 0,
  appCalls: 0,
  hotCalls: 0,
  server: null as any,
  app: null as any,
  hot: null as any,
}));

vi.mock('./useServerUpdate', () => ({
  useServerUpdate: () => {
    harness.serverCalls += 1;
    return harness.server;
  },
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
  harness.serverCalls = 0;
  harness.appCalls = 0;
  harness.hotCalls = 0;
  harness.server = {
    status: { available: null, state: 'idle' }, visible: false, busy: false,
    apply: vi.fn(), skip: vi.fn(), dismiss: vi.fn(),
  };
  harness.app = {
    pending: null, update: null, busy: false, error: null,
    install: vi.fn(), skip: vi.fn(), dismiss: vi.fn(),
  };
  harness.hot = { staged: null, apply: vi.fn(), dismiss: vi.fn() };
  prompt = null;
});

describe('useUpdatePrompt', () => {
  it('owns all three source hooks and gives app updates priority over hot ones', () => {
    harness.app.pending = { version: '2026.8.1', kind: 'apk', apply: 'prompt' };
    harness.app.update = harness.app.pending;
    harness.hot.staged = { version: 'frontend-b7e2' };
    act(() => { create(<Probe />); });

    expect(harness.serverCalls).toBe(1);
    expect(harness.appCalls).toBe(1);
    expect(harness.hotCalls).toBe(1);
    expect(prompt?.kind).toBe('app');
  });

  it('ranks server above app above hot', () => {
    // All three at once: the shell's version ceiling is the server's, so asking about the app
    // before the server has moved would be asking about a version the shell cannot see yet.
    harness.server.visible = true;
    harness.server.status = { available: '2026.9.20', state: 'prompting' };
    harness.app.pending = { version: '2026.8.1', kind: 'apk', apply: 'prompt' };
    harness.app.update = harness.app.pending;
    harness.hot.staged = { version: 'frontend-b7e2' };
    let renderer: ReturnType<typeof create>;
    act(() => { renderer = create(<Probe />); });
    expect(prompt?.kind).toBe('server');

    // Server settles → app is next in line.
    harness.server.visible = false;
    harness.server.status = { available: null, state: 'idle' };
    act(() => { renderer.update(<Probe />); });
    expect(prompt?.kind).toBe('app');

    // App settles → hot gets its turn.
    harness.app.pending = null;
    harness.app.update = null;
    act(() => { renderer.update(<Probe />); });
    expect(prompt?.kind).toBe('hot');
  });

  it('keeps the server prompt up while the install runs', () => {
    harness.server.visible = true;
    harness.server.status = { available: '2026.9.20', state: 'installing' };
    harness.server.busy = true;
    act(() => { create(<Probe />); });

    expect(prompt).toEqual(expect.objectContaining({
      kind: 'server',
      status: { available: '2026.9.20', state: 'installing' },
      busy: true,
    }));
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
