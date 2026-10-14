import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WaitpointInfo } from '@cortex-agent/ui-contract';
import type { SessionWaitpoints } from '@/features/session/live/useSessionWaitpoints';
import { ActivityStrip } from './ActivityStrip';

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

beforeEach(() => {
  state.waitpoints = [];
  state.cancel = vi.fn();
  state.cancelling = false;
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

function waits(): SessionWaitpoints {
  return { waitpoints: state.waitpoints, cancel: state.cancel, cancelling: state.cancelling };
}

/** The capsule, as the desktop strip shows it. */
function mount(lang: 'en' | 'zh' = 'en'): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<ActivityStrip todos={null} running={false} waitpoints={waits()} lang={lang} />); });
  return renderer;
}

/** The capsule opened: its panel. */
function mountOpen(lang: 'en' | 'zh' = 'en'): ReactTestRenderer {
  const r = mount(lang);
  act(() => chip(r).props.onClick({ stopPropagation: () => {} }));
  return r;
}

const chip = (r: ReactTestRenderer) => r.root.findByProps({ 'data-activity-chip': 'wait' });

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : textContent(child)).join('');
}

describe('wait capsule', () => {
  it('renders no pixels at all when the session is waiting on nothing', () => {
    expect(mount().toJSON()).toBeNull();
  });

  it('names what is being waited on and how far along, on one line', () => {
    state.waitpoints = [wp()];
    const r = mount();
    const text = textContent(chip(r));
    expect(text).toContain('train-arm2');
    expect(text).toContain('0/1 received');
    expect(chip(r).props['aria-expanded']).toBe(false);
    expect(chip(r).props['aria-label']).toContain('Waiting on: train-arm2 · 0/1 received');
    expect(r.root.findAllByType('details')).toHaveLength(0);
  });

  it('opens structured reports with initially closed intent and raw signal details', () => {
    state.waitpoints = [wp({
      signals: [{ at: T0, status: 'ok', member: 'arm2', message: 'epoch 12 done', source: 'http' }],
    })];
    const r = mountOpen();
    expect(chip(r).props['aria-expanded']).toBe(true);
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
    state.waitpoints = [wp()];
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const r = mountOpen();
    const button = r.root.findByProps({ 'data-waitpoint-cancel': 'wp_1' });

    act(() => button.props.onClick({ stopPropagation: () => {} }));
    expect(state.cancel).not.toHaveBeenCalled();

    await act(async () => button.props.onClick({ stopPropagation: () => {} }));
    expect(state.cancel).toHaveBeenCalledWith('wp_1');
  });

  it('warns that a rate-limited waitpoint holds its next wake until the hour clears', () => {
    state.waitpoints = [wp({ rateLimited: true, wakesLastHour: 12 })];
    const r = mountOpen();
    const badge = r.root.findByProps({ 'data-wait-badge': 'rate-limit' });
    expect(JSON.stringify(badge.props.children)).toContain('waits until the hour clears');
  });

  it('flags failures, rate limits and delivery retries with one dot, and spells them out when opened', () => {
    state.waitpoints = [wp({ rateLimited: true,
      signals: [{ at: T0, status: 'fail', member: null, message: 'failed', source: 'http' }],
      delivery: { pending: true, attempts: 3, lastError: 'closed', lastAt: T0 },
    })];
    const r = mount();
    expect(r.root.findAll((n) => n.props['data-wait-alert'] !== undefined).map((n) => n.props['data-wait-alert'])).toEqual(['danger']);
    expect(r.root.findAll((n) => n.props['data-wait-badge'] !== undefined)).toHaveLength(0);
    expect(chip(r).props['aria-label']).toContain('1 failure signal');
    act(() => chip(r).props.onClick({ stopPropagation: () => {} }));
    expect(r.root.findByProps({ 'data-wait-badge': 'failure' }).props.children).toBe('1 failure signal');
    expect(r.root.findByProps({ 'data-wait-badge': 'rate-limit' })).toBeTruthy();
    expect(r.root.findByProps({ 'data-wait-badge': 'delivery' }).props.title).toBe('closed');
  });

  it('adds no dot to an ordinary wait', () => {
    state.waitpoints = [wp()];
    expect(mount().root.findAll((n) => n.props['data-wait-alert'] !== undefined)).toHaveLength(0);
  });

  it('labels multiple waiting items and gives each its own section when opened', () => {
    state.waitpoints = [wp(), wp({ id: 'wp_2', label: 'second', rateLimited: true })];
    const r = mount();
    expect(chip(r).props['aria-label']).toContain('Waiting on: 2 waiting items · train-arm2');
    expect(r.root.findAllByType('section')).toHaveLength(0);
    act(() => chip(r).props.onClick({ stopPropagation: () => {} }));
    const items = r.root.findAllByType('section');
    expect(items.map((item) => item.props['aria-label'])).toEqual(['train-arm2', 'second']);
    expect(items[1].findByProps({ 'data-wait-badge': 'rate-limit' })).toBeTruthy();
    expect(r.root.findAllByProps({ className: 'wait-rail-metrics' })).toHaveLength(2);
  });

  it('preserves raw text safely without interpreting markup or truncating messages', () => {
    const message = `  <script>bad()</script>\n${'long'.repeat(200)}  `;
    state.waitpoints = [wp({ intent: message,
      signals: [{ at: T0, status: 'progress', member: 'a', message, source: '<http>' }],
    })];
    const r = mountOpen();
    expect(r.root.findByType('pre').props.children).toBe(message);
    expect(r.root.findAllByType('script')).toHaveLength(0);
    expect(r.root.findAll((node) => node.props.dangerouslySetInnerHTML !== undefined)).toHaveLength(0);
    const raw = r.root.findByType('pre');
    expect(renderToStaticMarkup(<pre>{raw.props.children}</pre>)).toContain('&lt;script&gt;');
    expect(r.root.findAllByType('details').every((node) => !node.props.open)).toBe(true);
  });

  it('shows raw history newest first without changing source or member order', () => {
    const signals: WaitpointInfo['signals'] = [
      { at: T0, status: 'progress', member: 'a', message: 'first', source: 'http' },
      { at: T0 + 1000, status: 'ok', member: 'b', message: 'second', source: 'http' },
      { at: T0 + 1000, status: 'ok', member: 'a', message: 'latest', source: 'http' },
    ];
    state.waitpoints = [wp({ signals, quorum: { need: 3, got: 2, members: ['a', 'b', 'c'] } })];
    const r = mountOpen();
    expect(r.root.findAllByType('pre').map((node) => node.props.children)).toEqual(['latest', 'second', 'first']);
    expect(signals.map((signal) => signal.message)).toEqual(['first', 'second', 'latest']);
    const members = r.root.findByType('tbody').findAllByType('tr');
    expect(members.map((node) => node.findByType('th').props.children)).toEqual(['a', 'b', 'c']);
  });

  it('uses Chinese chrome and separates mailbox history from the current fraction', () => {
    state.waitpoints = [wp({ maxSignals: 5, fires: 2,
      signals: [{ at: T0, status: 'ok', member: 'a', message: null, source: 'http' }],
    })];
    const r = mountOpen('zh');
    expect(r.root.findByType('caption').props.children).toBe('回报历史 · 所有轮次');
    expect(JSON.stringify(r.toJSON())).toContain('0/1 已回报');
    expect(JSON.stringify(r.toJSON())).toContain('第 3/5 次');
    expect(r.root.findByType('footer').findByType('button').props.children).toBe('取消等待');
  });

  it('does not offer a second cancel while one is in flight', () => {
    state.waitpoints = [wp()];
    state.cancelling = true;
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    const r = mountOpen();
    const button = r.root.findByProps({ 'data-waitpoint-cancel': 'wp_1' });
    expect(button.props.disabled).toBe(true);
    act(() => button.props.onClick({ stopPropagation: () => {} }));
    expect(confirm).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it('opens one capsule at a time', () => {
    state.waitpoints = [wp()];
    const todos = { items: [{ content: 'Run', activeForm: 'Running', status: 'in_progress' as const }], total: 1, completed: 0, activeLabel: 'Running', updatedAt: 1 };
    let r!: ReactTestRenderer;
    act(() => { r = create(<ActivityStrip todos={todos} running waitpoints={waits()} lang="en" />); });
    const todoChip = () => r.root.findByProps({ 'data-activity-chip': 'todo' });
    act(() => todoChip().props.onClick({ stopPropagation: () => {} }));
    act(() => chip(r).props.onClick({ stopPropagation: () => {} }));
    expect(r.root.findAll((n) => n.type === 'div' && n.props['data-activity-popover'] !== undefined)
      .map((n) => n.props['data-activity-popover'])).toEqual(['wait']);
    expect(todoChip().props['aria-expanded']).toBe(false);
  });
});
