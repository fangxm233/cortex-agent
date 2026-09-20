import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { WaitpointInfo } from '@cortex-agent/ui-contract';
import { WaitRail } from './WaitRail';

const state = vi.hoisted(() => ({
  waitpoints: [] as WaitpointInfo[],
  cancel: vi.fn(),
  cancelling: false,
}));

const T0 = Date.UTC(2026, 8, 18, 10, 0, 0);

function wp(overrides: Partial<WaitpointInfo> = {}): WaitpointInfo {
  return {
    id: 'wp_1', label: 'train-arm2', intent: 'compare val loss when all three arms finish',
    state: 'armed', emitFrom: { kind: 'local' },
    quorum: { need: 1, got: 0, members: [] },
    failFast: true, fires: 0, maxSignals: 1,
    createdAt: T0, expiresAt: T0 + 3 * 3600_000,
    signals: [],
    delivery: { pending: false, attempts: 0, lastError: null, lastAt: null },
    wakesLastHour: 0, wakeLimit: 12, rateLimited: false,
    ...overrides,
  };
}

const store = new Map<string, string>();

beforeEach(() => {
  state.waitpoints = [];
  state.cancel = vi.fn();
  state.cancelling = false;
  store.clear();
  // No jsdom in this suite: the rail persists its expanded state, so window/localStorage are stubs.
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    },
  });
});

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <WaitRail
        sessionId="s1"
        lang="en"
        waitpoints={state.waitpoints}
        onCancel={state.cancel}
        cancelling={state.cancelling}
      />,
    );
  });
  return renderer;
}

describe('WaitRail', () => {
  it('renders no pixels at all when the session is waiting on nothing', () => {
    expect(mount().toJSON()).toBeNull();
  });

  it('collapses to one line naming what is being waited on', () => {
    state.waitpoints = [wp()];
    const r = mount();
    expect(r.root.findByProps({ 'data-wait-rail': 'collapsed' })).toBeTruthy();
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain('waiting on 1 signal');
    expect(text).toContain('train-arm2');
  });

  it('expands to show the intent and the signal log', () => {
    store.set('cortex.waitRailOpen.s1', '1');
    state.waitpoints = [wp({
      signals: [{ at: T0, status: 'ok', member: 'arm2', message: 'epoch 12 done', source: 'http' }],
    })];
    const r = mount();
    expect(r.root.findByProps({ 'data-wait-rail': 'expanded' })).toBeTruthy();
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain('compare val loss when all three arms finish');
    expect(text).toContain('epoch 12 done');
    expect(text).toContain('arm2');
  });

  it('cancels only after the user confirms', async () => {
    store.set('cortex.waitRailOpen.s1', '1');
    state.waitpoints = [wp()];
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const r = mount();
    const button = r.root.findByProps({ 'data-waitpoint-cancel': 'wp_1' });

    act(() => button.props.onClick({ stopPropagation: () => {} }));
    expect(state.cancel).not.toHaveBeenCalled();

    await act(async () => button.props.onClick({ stopPropagation: () => {} }));
    expect(state.cancel).toHaveBeenCalledWith('wp_1');
  });

  it('warns that a rate-limited waitpoint can no longer wake the session', () => {
    store.set('cortex.waitRailOpen.s1', '1');
    state.waitpoints = [wp({ rateLimited: true, wakesLastHour: 12 })];
    const r = mount();
    const badge = r.root.findByProps({ 'data-wait-badge': 'rate-limit' });
    expect(JSON.stringify(badge.props.children)).toContain('no longer wake');
  });

  it('does not offer a second cancel while one is in flight', () => {
    store.set('cortex.waitRailOpen.s1', '1');
    state.waitpoints = [wp()];
    state.cancelling = true;
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    const r = mount();
    const button = r.root.findByProps({ 'data-waitpoint-cancel': 'wp_1' });
    expect(button.props.disabled).toBe(true);
    act(() => button.props.onClick({ stopPropagation: () => {} }));
    expect(confirm).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
  });
});
