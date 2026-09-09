// input:  real update hooks/controller and mocked Tauri transport
// output: prompt ownership, priority and feedback lifecycle tests
// pos:    Manual update integration specification
// >>> If updated, update this header and parent CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import { publishAppUpdate } from '@/features/app-update/app-update';
import { useUpdatePrompt, type UpdatePrompt } from './useUpdatePrompt';
import { useManualUpdateCheck } from './useManualUpdateCheck';
import type { NativeCheckReport } from './manual-update-check';

const feedback = vi.hoisted(() => ({ toast: vi.fn(() => 'progress'), dismiss: vi.fn() }));
vi.mock('@/design/Toast', () => ({ useToastOptional: () => feedback }));
vi.mock('@/i18n', async () => {
  const { en } = await import('@/i18n/vocab');
  return { useVocab: () => en };
});

const ui = { version: 'ui-next', fromVersion: 'ui-old', size: 100 };
const shell = { version: '2026.9.8', kind: 'nsis', size: 200, notes: null, releaseUrl: null };
const both: NativeCheckReport = { ui: { status: 'available', update: ui }, shell: { status: 'available', update: shell } };
const current: NativeCheckReport = { ui: { status: 'current' }, shell: { status: 'current' } };
let prompt: UpdatePrompt;
let manual: ReturnType<typeof useManualUpdateCheck>;
let renderer: ReactTestRenderer;
let finish: (report: NativeCheckReport) => void;
let invoke: ReturnType<typeof vi.fn>;
let events: Map<string, (event: { payload: unknown }) => void>;
let off: ReturnType<typeof vi.fn>;

function Probe() {
  manual = useManualUpdateCheck();
  prompt = useUpdatePrompt();
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  publishAppUpdate(null);
  events = new Map();
  off = vi.fn();
  invoke = vi.fn((command: string) => command === 'check_for_updates'
    ? new Promise<NativeCheckReport>((resolve) => { finish = resolve; }) : Promise.resolve(null));
  vi.stubGlobal('__CORTEX_DESKTOP__', true);
  vi.stubGlobal('__TAURI__', { core: { invoke }, event: {
    listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
      events.set(name, handler);
      return () => { off(name); events.delete(name); };
    }),
  } });
  await act(async () => { renderer = create(<Probe />); });
});

afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

function expectNoInstall() {
  expect(invoke.mock.calls.map(([command]) => command)).not.toContain('apply_frontend_update');
  expect(invoke.mock.calls.map(([command]) => command)).not.toContain('install_app_update');
}

async function resolveCheck(report: NativeCheckReport) {
  await act(async () => { finish(report); });
}

describe('manual update menu integration', () => {
  it('suppresses early events, repeated clicks and UI prompts before shell priority is known', async () => {
    act(() => { void manual.check(); void manual.check(); });
    expect(manual.busy).toBe(true);
    act(() => { events.get('frontend-update-staged')?.({ payload: ui }); });
    expect(prompt).toBeNull();
    act(() => { events.get('app-update-available')?.({ payload: shell }); });
    expect(prompt).toBeNull();
    await resolveCheck(both);
    expect(manual.busy).toBe(false);
    expect(prompt?.kind).toBe('app');
    expect(invoke.mock.calls.filter(([command]) => command === 'check_for_updates')).toHaveLength(1);
    expect(feedback.dismiss).toHaveBeenCalledWith('progress');
    expect(feedback.toast.mock.calls).toHaveLength(3);
    expectNoInstall();
  });

  it('re-shows the dismissed app update using the existing prioritized owner', async () => {
    act(() => { events.get('app-update-available')?.({ payload: shell }); });
    act(() => { prompt?.dismiss(); });
    expect(prompt).toBeNull();
    act(() => { void manual.check(); });
    await resolveCheck(both);
    expect(prompt?.kind).toBe('app');
    expectNoInstall();
  });

  it('re-shows a dismissed UI update even without native events on the recheck', async () => {
    act(() => { events.get('frontend-update-staged')?.({ payload: ui }); });
    expect(prompt?.kind).toBe('hot');
    act(() => { prompt?.dismiss(); });
    act(() => { void manual.check(); });
    await resolveCheck({ ui: both.ui, shell: current.shell });
    expect(prompt?.kind).toBe('hot');
    expectNoInstall();
  });

  it('keeps cached fallback errors honest while still offering confirmation', async () => {
    act(() => { void manual.check(); });
    await resolveCheck({ ui: { status: 'error', reason: 'private URL', update: ui },
      shell: { status: 'skipped', reason: 'no_matching_asset' } });
    expect(prompt?.kind).toBe('hot');
    expect(feedback.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: en.updateCheckUi, tone: 'failed', description: `${en.updateCheckError} ${en.updateCheckCached}`,
    }));
    expect(feedback.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: en.updateCheckShell, tone: 'waiting', description: `${en.updateCheckSkipped} ${en.updateCheckNoAsset}`,
    }));
    expectNoInstall();
  });

  it('keeps cached shell fallback priority without reporting a successful shell check', async () => {
    act(() => { void manual.check(); });
    await resolveCheck({ ui: both.ui, shell: { status: 'error', reason: 'offline', update: shell } });
    expect(prompt?.kind).toBe('app');
    expect(feedback.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: en.updateCheckShell, tone: 'failed', description: `${en.updateCheckError} ${en.updateCheckCached}`,
    }));
    act(() => { prompt?.dismiss(); });
    expect(prompt).toBeNull();
    expectNoInstall();
  });

  it('reports both freshly current channels without an update prompt', async () => {
    act(() => { void manual.check(); });
    await resolveCheck(current);
    expect(prompt).toBeNull();
    expect(feedback.toast).toHaveBeenCalledWith(expect.objectContaining({ title: en.updateCheckUi, description: en.updateCheckCurrent }));
    expect(feedback.toast).toHaveBeenCalledWith(expect.objectContaining({ title: en.updateCheckShell, description: en.updateCheckCurrent }));
    expectNoInstall();
  });

  it('reports missing legacy commands as unsupported, never up to date', async () => {
    invoke.mockRejectedValue('Command check_for_updates not found');
    await act(async () => { await manual.check(); });
    expect(manual.busy).toBe(false);
    expect(prompt).toBeNull();
    expect(feedback.toast).toHaveBeenCalledWith(expect.objectContaining({
      tone: 'failed', description: `${en.updateCheckError} ${en.updateCheckUnsupported}`,
    }));
    expectNoInstall();
  });

  it('cleans result/event subscriptions and progress when unmounted during a check', async () => {
    act(() => { void manual.check(); });
    act(() => renderer.unmount());
    expect(off).toHaveBeenCalledTimes(2);
    expect(feedback.dismiss).toHaveBeenCalledWith('progress');
    await resolveCheck(both);
    expect(feedback.toast).toHaveBeenCalledTimes(1);
    await act(async () => { renderer = create(<Probe />); });
    expect(manual.busy).toBe(false);
    expect(prompt).toBeNull();
    expectNoInstall();
  });
});
