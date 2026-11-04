import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { en, LangProvider, useSetLang, zh } from '@/i18n';
import {
  failed, FIXTURE_QUOTA, FIXTURE_TOOLS, FIXTURE_USAGE, fixtureController, loading, ready,
} from '@/features/stats/__fixtures__/stats-fixtures';
import type { StatsController } from '@/features/stats';

vi.mock('@/design', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/design')>(),
  Select: ({ value, onValueChange, options, ...props }: {
    value: string; onValueChange: (value: string) => void; options: { value: string; label: string }[];
  }) => (
    <select {...props} value={value} onChange={(event) => onValueChange(event.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}));

import { StatsPanelView } from './StatsPanel';

function ZhSwitch() {
  const setLang = useSetLang();
  return <button type="button" data-lang-zh onClick={() => setLang('zh')}>zh</button>;
}

function mount(controller: StatsController, onOpenSession = vi.fn()): ReactTestRenderer {
  let view!: ReactTestRenderer;
  act(() => {
    view = create(<LangProvider><ZhSwitch /><StatsPanelView controller={controller} onOpenSession={onOpenSession} /></LangProvider>);
  });
  return view;
}

function all(view: ReactTestRenderer, attr: string, value?: string): ReactTestInstance[] {
  return view.root.findAll((node) => typeof node.type === 'string' && node.props[attr] !== undefined
    && (value === undefined || node.props[attr] === value));
}

function one(view: ReactTestRenderer, attr: string, value?: string): ReactTestInstance {
  const found = all(view, attr, value);
  if (found.length !== 1) throw new Error(`expected one ${attr}=${value ?? '*'}, found ${found.length}`);
  return found[0];
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

describe('StatsPanelView', () => {
  it('shows the four KPI tiles with deltas against the previous period', () => {
    const view = mount(fixtureController());
    expect(all(view, 'data-stats-kpi').map((n) => n.props['data-stats-kpi'])).toEqual(['total', 'output', 'cacheHit', 'cost']);
    expect(text(one(view, 'data-stats-kpi', 'total'))).toContain('11.1M▼ 6.7%');
    expect(all(view, 'data-stats-delta')).toHaveLength(4);
    view.unmount();
  });

  it('hides every delta when the previous period is outside the ledger', () => {
    const view = mount(fixtureController({ usage: ready({ ...FIXTURE_USAGE, previous: null }) }));
    expect(all(view, 'data-stats-delta')).toHaveLength(0);
    view.unmount();
  });

  it('stacks the token kinds and hides a series from its legend entry', () => {
    const view = mount(fixtureController());
    const usage = view.root.findByProps({ 'data-stats-section': 'usage' });
    const legend = () => usage.findAll((n) => typeof n.type === 'string' && n.props['data-legend-item'] !== undefined);
    const kinds = () => new Set(all(view, 'data-bar-segment').map((n) => n.props['data-bar-segment']));
    expect(legend().map((n) => n.props['data-legend-item'])).toEqual(['cacheRead', 'cacheWrite', 'input', 'output']);
    expect(kinds().has('cacheRead')).toBe(true);
    act(() => legend()[0].props.onClick());
    expect(legend()[0].props['aria-pressed']).toBe(false);
    expect(kinds().has('cacheRead')).toBe(false);
    // Without the dominant kind the axis rescales, so the thin output segments now show.
    expect(kinds().has('output')).toBe(true);
    view.unmount();
  });

  it('regroups the chart by model with the folded remainder last', () => {
    const view = mount(fixtureController());
    act(() => one(view, 'data-stats-group').props.onChange({ target: { value: 'model' } }));
    const usage = view.root.findByProps({ 'data-stats-section': 'usage' });
    const items = usage.findAll((n) => typeof n.type === 'string' && n.props['data-legend-item'] !== undefined);
    expect(items.map((n) => n.props['data-legend-item'])).toEqual(['claude-opus-5-5[1m]', 'gpt-6-astra', '__rest']);
    expect(text(items[2])).toContain('4 others');
    view.unmount();
  });

  it('pages back one period and cannot page past the present', () => {
    const setPage = vi.fn();
    const view = mount(fixtureController({}, { setPage }));
    expect(one(view, 'data-stats-page', 'newer').props.disabled).toBe(true);
    act(() => one(view, 'data-stats-page', 'older').props.onClick());
    expect(setPage).toHaveBeenCalledWith(1);
    view.unmount();
  });

  it('applies the range and project filters', () => {
    const setRange = vi.fn();
    const setProjectId = vi.fn();
    const view = mount(fixtureController({ projectId: 'alap' }, { setRange, setProjectId }));
    act(() => one(view, 'data-stats-range', '30d').props.onClick());
    expect(setRange).toHaveBeenCalledWith('30d');
    const project = one(view, 'data-stats-project');
    expect(project.findAllByType('option').map((o) => o.props.value)).toEqual(['', 'alap', 'cortex-self', 'wm-align']);
    act(() => project.props.onChange({ target: { value: '' } }));
    expect(setProjectId).toHaveBeenCalledWith(null);
    view.unmount();
  });

  it('lists six sessions, shows six more, and opens a session from its expanded row', () => {
    const onOpen = vi.fn();
    const view = mount(fixtureController(), onOpen);
    expect(all(view, 'data-stats-session')).toHaveLength(6);
    act(() => one(view, 'data-stats-more', 'sessions').props.onClick());
    expect(all(view, 'data-stats-session')).toHaveLength(8);
    expect(all(view, 'data-stats-more', 'sessions')).toHaveLength(0);
    act(() => one(view, 'data-stats-session', 'session-1').props.onClick());
    const detail = one(view, 'data-stats-session-detail', 'session-1');
    expect(text(detail)).toContain('Background');
    act(() => one(view, 'data-stats-open-session', 'session-1').props.onClick());
    expect(onOpen).toHaveBeenCalledWith({ sessionId: 'session-1', projectId: 'cortex-self' });
    view.unmount();
  });

  it('shows both quota spans, splits an opened window by source, and switches accounts', () => {
    const setAccount = vi.fn();
    const view = mount(fixtureController({}, { setAccount }));
    expect(all(view, 'data-stats-quota-span').map((n) => n.props['data-stats-quota-span'])).toEqual(['fiveHour', 'weekly']);
    const first = all(view, 'data-stats-quota-row')[0];
    act(() => first.props.onClick());
    expect(text(view.root.findByProps({ 'data-stats-quota-span': 'fiveHour' }))).toContain('31.8%');
    act(() => one(view, 'data-stats-account').props.onChange({ target: { value: 'anthropic\u0000school' } }));
    expect(setAccount).toHaveBeenCalledWith({ provider: 'anthropic', route: 'school' });
    view.unmount();
  });

  it('leaves the quota section out until an account has a recorded window', () => {
    const empty = mount(fixtureController({ quota: ready({ ...FIXTURE_QUOTA, accounts: [], account: null }) }));
    expect(all(empty, 'data-stats-section', 'quota')).toHaveLength(0);
    empty.unmount();
    const pending = mount(fixtureController({ quota: loading() }));
    expect(all(pending, 'data-stats-section', 'quota')).toHaveLength(0);
    pending.unmount();
  });

  it('ranks tools, switches the kind, and waits quietly for the first index', () => {
    const setToolKind = vi.fn();
    const view = mount(fixtureController({}, { setToolKind }));
    expect(all(view, 'data-stats-rank').map((n) => n.props['data-stats-rank'])).toEqual(['Bash', 'Read', 'TaskStop']);
    act(() => one(view, 'data-stats-tool-kind', 'skill').props.onClick());
    expect(setToolKind).toHaveBeenCalledWith('skill');
    view.unmount();
    const pending = mount(fixtureController({ tools: ready({ ...FIXTURE_TOOLS, ready: false, total: 0, series: [], ranking: [] }) }));
    expect(all(pending, 'data-stats-tools-pending')).toHaveLength(1);
    expect(all(pending, 'data-stats-rank')).toHaveLength(0);
    pending.unmount();
  });

  it('draws run lines by model or by source', () => {
    const view = mount(fixtureController());
    const runs = view.root.findByProps({ 'data-stats-section': 'runs' });
    const lines = () => runs.findAll((n) => n.type === 'polyline').map((n) => n.props['data-line-series']);
    expect(lines()).toEqual(['claude-opus-5-5[1m]', 'gpt-6-astra']);
    act(() => one(view, 'data-stats-runs-by', 'source').props.onClick());
    expect(lines()).toEqual(['chat']);
    view.unmount();
  });

  it('reports loading and failed reads per section', () => {
    const view = mount(fixtureController({ usage: loading(), tools: failed('boom') }));
    expect(all(view, 'data-stats-loading')).toHaveLength(1);
    expect(text(one(view, 'data-stats-error'))).toBe(`${en.statsLoadError}: boom`);
    expect(all(view, 'data-stats-kpis')).toHaveLength(0);
    view.unmount();
  });

  it('says so when the period has no usage', () => {
    const zero = { ...FIXTURE_USAGE.totals, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, runs: 0, requests: 0, costUsd: 0 };
    const view = mount(fixtureController({ usage: ready({ ...FIXTURE_USAGE, totals: zero, sessions: [] }) }));
    expect(all(view, 'data-stats-empty').map(text)).toContain(en.statsEmpty);
    expect(all(view, 'data-bar-segment')).toHaveLength(0);
    view.unmount();
  });

  it('follows the UI language', () => {
    const view = mount(fixtureController());
    act(() => view.root.findByProps({ 'data-lang-zh': true }).props.onClick());
    const headings = view.root.findAll((n) => n.props.className === 'stats-heading-title').map(text);
    expect(headings).toEqual([zh.statsTokenUsage, zh.statsTopSessions, zh.statsQuotaWindows, zh.statsToolActivity, zh.statsRunActivity]);
    view.unmount();
  });
});
