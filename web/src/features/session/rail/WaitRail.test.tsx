import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
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

function mount(floating = false): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <WaitRail
        sessionId="s1"
        lang="en"
        waitpoints={state.waitpoints}
        onCancel={state.cancel}
        cancelling={state.cancelling}
        floating={floating}
      />,
    );
  });
  return renderer;
}

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : textContent(child)).join('');
}

function assertNoToggleAncestor(node: ReactTestInstance): void {
  let ancestor: ReactTestInstance | null = node;
  while (ancestor) {
    expect(ancestor.props.onClick).toBeUndefined();
    expect(ancestor.props.onKeyDown).toBeUndefined();
    ancestor = ancestor.parent;
  }
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
    expect(text).not.toContain('waiting on 1 signal');
    expect(text).toContain('train-arm2');
    expect(text).toContain('0/1 received');
    expect(r.root.findByType('button').props['aria-expanded']).toBe(false);
  });

  it('takes frosted chrome only when floating over the transcript', () => {
    state.waitpoints = [wp()];
    const inline = mount().root.findByProps({ 'data-wait-rail': 'collapsed' }).props.style;
    expect(inline.background).toBe('var(--proto-alt)');
    expect(inline.backdropFilter).toBeUndefined();
    const floating = mount(true).root.findByProps({ 'data-wait-rail': 'collapsed' }).props.style;
    expect(floating).toMatchObject({ background: 'var(--glass-1)', backdropFilter: 'var(--glass-filter)' });
  });

  it('expands with structured reports and initially closed intent and raw signal details', () => {
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
    expect(r.root.findAllByType('details')).toHaveLength(2);
    for (const details of r.root.findAllByType('details')) expect(details.props.open).toBeUndefined();
    expect(r.root.findByType('table')).toBeTruthy();
    expect(r.root.findByType('footer').findByType('button').props.children).toBe('Cancel wait');
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

  it('shows failures, rate limits and delivery retries even when collapsed', () => {
    state.waitpoints = [wp({ rateLimited: true,
      signals: [{ at: T0, status: 'fail', member: null, message: 'failed', source: 'http' }],
      delivery: { pending: true, attempts: 3, lastError: 'closed', lastAt: T0 },
    })];
    const r = mount();
    expect(r.root.findByProps({ 'data-wait-badge': 'failure' }).props.children).toBe('1 failure signal');
    expect(r.root.findByProps({ 'data-wait-badge': 'rate-limit' })).toBeTruthy();
    expect(r.root.findByProps({ 'data-wait-badge': 'delivery' }).props.title).toBe('closed');
    expect(r.root.findAllByType('details')).toHaveLength(0);
  });

  it('keeps the same summary in both states and persists only summary-button toggles', () => {
    state.waitpoints = [wp({ quorum: { need: 1, got: 0, members: ['a'] } })];
    const r = mount();
    const toggle = r.root.findByProps({ 'aria-expanded': false });
    const summary = textContent(toggle.findByProps({ className: 'wait-rail-heading' }));
    act(() => toggle.props.onClick());
    expect(textContent(r.root.findByProps({ className: 'wait-rail-heading' }))).toBe(summary);
    expect(r.root.findByProps({ 'aria-expanded': true }).props['aria-label']).toContain('Waiting on: train-arm2 · 0/1 received');
    expect(r.root.findByProps({ id: toggle.props['aria-controls'] })).toBeTruthy();
    expect(store.get('cortex.waitRailOpen.s1')).toBe('1');
    for (const details of r.root.findAllByType('details')) assertNoToggleAncestor(details);
    assertNoToggleAncestor(r.root.findByType('table'));
    expect(r.root.findAll((node) => node.props.role === 'button')).toHaveLength(0);
    act(() => r.root.findByProps({ 'aria-expanded': true }).props.onClick());
    expect(store.get('cortex.waitRailOpen.s1')).toBe('0');
  });

  it('restores expansion independently for each session', () => {
    state.waitpoints = [wp()];
    store.set('cortex.waitRailOpen.s1', '1');
    const r = mount();
    const renderSession = (sessionId: string) => <WaitRail sessionId={sessionId} lang="en" waitpoints={state.waitpoints} onCancel={state.cancel} />;
    act(() => r.update(renderSession('s2')));
    expect(r.root.findByProps({ 'aria-expanded': false })).toBeTruthy();
    act(() => r.update(renderSession('s1')));
    expect(r.root.findByProps({ 'aria-expanded': true })).toBeTruthy();
  });

  it('labels multiple waiting items and associates each visible exception with its item', () => {
    state.waitpoints = [wp(), wp({ id: 'wp_2', label: 'second', rateLimited: true })];
    const r = mount();
    expect(r.root.findByType('button').props['aria-label']).toBe('Waiting on: 2 waiting items · train-arm2');
    const items = r.root.findAllByType('section');
    expect(items.map((item) => item.props['aria-label'])).toEqual(['second']);
    expect(items[0].findByProps({ 'data-wait-badge': 'rate-limit' })).toBeTruthy();
    expect(r.root.findAllByProps({ className: 'wait-rail-metrics' })).toHaveLength(1);
    act(() => r.root.findByType('button').props.onClick());
    expect(r.root.findAllByType('section').map((item) => item.props['aria-label'])).toEqual(['train-arm2', 'second']);
    expect(r.root.findAllByProps({ className: 'wait-rail-metrics' })).toHaveLength(2);
  });

  it('keeps ordinary multiple waits in one collapsed summary', () => {
    state.waitpoints = [wp(), wp({ id: 'wp_2', label: 'second' })];
    const r = mount();
    expect(r.root.findAllByType('section')).toHaveLength(0);
    expect(r.root.findAllByType('button')).toHaveLength(1);
    expect(r.root.findByProps({ className: 'wait-rail-title' }).props.title).toBe('2 waiting items · train-arm2');
    act(() => r.root.findByType('button').props.onClick());
    expect(r.root.findAllByType('section')).toHaveLength(2);
  });

  it('preserves raw text safely without interpreting markup or truncating messages', () => {
    store.set('cortex.waitRailOpen.s1', '1');
    const message = `  <script>bad()</script>\n${'long'.repeat(200)}  `;
    state.waitpoints = [wp({ intent: message,
      signals: [{ at: T0, status: 'progress', member: 'a', message, source: '<http>' }],
    })];
    const r = mount();
    expect(r.root.findByType('pre').props.children).toBe(message);
    expect(r.root.findAllByType('script')).toHaveLength(0);
    expect(r.root.findAll((node) => node.props.dangerouslySetInnerHTML !== undefined)).toHaveLength(0);
    const raw = r.root.findByType('pre');
    expect(renderToStaticMarkup(<pre>{raw.props.children}</pre>)).toContain('&lt;script&gt;');
    expect(r.root.findAllByType('details').every((node) => !node.props.open)).toBe(true);
  });

  it('uses Chinese chrome and separates mailbox history from the current fraction', () => {
    store.set('cortex.waitRailOpen.s1', '1');
    state.waitpoints = [wp({ maxSignals: 5, fires: 2,
      signals: [{ at: T0, status: 'ok', member: 'a', message: null, source: 'http' }],
    })];
    let r!: ReactTestRenderer;
    act(() => { r = create(<WaitRail sessionId="s1" lang="zh" waitpoints={state.waitpoints} onCancel={state.cancel} />); });
    expect(r.root.findByType('caption').props.children).toBe('回报历史 · 所有轮次');
    expect(JSON.stringify(r.toJSON())).toContain('0/1 已回报');
    expect(JSON.stringify(r.toJSON())).toContain('第 3/5 次');
    expect(r.root.findByType('footer').findByType('button').props.children).toBe('取消等待');
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
