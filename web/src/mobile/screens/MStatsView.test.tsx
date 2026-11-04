import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { en, LangProvider } from '@/i18n';
import { fixtureController } from '@/features/stats/__fixtures__/stats-fixtures';
import type { StatsController } from '@/features/stats';

vi.mock('@/design', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/design')>(),
  MSelect: ({ value, onValueChange, options, title: _title, sheetClassName: _sheet, ...props }: {
    value: string; onValueChange: (value: string) => void; options: { value: string; label: string }[];
    title: string; sheetClassName?: string;
  }) => (
    <select {...props} value={value} onChange={(event) => onValueChange(event.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}));

import { MStatsView } from './MStatsView';

function mount(controller: StatsController, handlers: { onBack?: () => void; onOpenSession?: () => void } = {}): ReactTestRenderer {
  let view!: ReactTestRenderer;
  act(() => {
    view = create(
      <LangProvider>
        <MStatsView controller={controller} onBack={handlers.onBack ?? vi.fn()} onOpenSession={handlers.onOpenSession ?? vi.fn()} />
      </LangProvider>,
    );
  });
  return view;
}

function all(view: ReactTestRenderer, attr: string, value?: string): ReactTestInstance[] {
  return view.root.findAll((node) => typeof node.type === 'string' && node.props[attr] !== undefined
    && (value === undefined || node.props[attr] === value));
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

describe('MStatsView', () => {
  it('stacks the page for a phone: filters, KPI grid of two, single-column quota and tools', () => {
    const view = mount(fixtureController());
    expect(all(view, 'data-stats-filters')).toHaveLength(1);
    expect(all(view, 'data-stats-kpis')[0].props['data-variant']).toBe('mobile');
    expect(all(view, 'data-stats-variant')[0].props['data-stats-variant']).toBe('mobile');
    expect(view.root.findAll((n) => n.props.className?.toString().startsWith('stats-two')
      && typeof n.type === 'string')[0].props['data-variant']).toBe('mobile');
    expect(view.root.findAll((n) => n.props.className === 'stats-tools')[0].props['data-variant']).toBe('mobile');
    view.unmount();
  });

  it('lists sessions as rows that expand to their details and open the session', () => {
    const onOpenSession = vi.fn();
    const view = mount(fixtureController(), { onOpenSession });
    const rows = all(view, 'data-stats-session');
    expect(rows).toHaveLength(6);
    expect(rows[0].type).toBe('button');
    expect(view.root.findAll((n) => n.type === 'table' && n.props.className === 'stats-table'
      && n.parent?.parent?.props['data-stats-section'] === 'sessions')).toHaveLength(0);
    act(() => rows[0].props.onClick());
    const detail = all(view, 'data-stats-session-detail', 'session-0')[0];
    expect(text(detail)).toContain(en.statsOpenSession);
    act(() => all(view, 'data-stats-open-session', 'session-0')[0].props.onClick());
    expect(onOpenSession).toHaveBeenCalledWith({ sessionId: 'session-0', projectId: 'alap' });
    view.unmount();
  });

  it('picks the project from a sheet and goes back to Settings', () => {
    const setProjectId = vi.fn();
    const onBack = vi.fn();
    const view = mount(fixtureController({}, { setProjectId }), { onBack });
    act(() => all(view, 'data-stats-project')[0].props.onChange({ target: { value: 'wm-align' } }));
    expect(setProjectId).toHaveBeenCalledWith('wm-align');
    act(() => view.root.findByProps({ 'aria-label': en.back }).props.onClick());
    expect(onBack).toHaveBeenCalled();
    view.unmount();
  });
});
