// input:  ComposerActionRow, mocked device and commission queries
// output: Toolbar, picker and Escape focus regression tests
// pos:    Verify compact action controls and selection behavior
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LangProvider } from '@/i18n';
import { DEFAULT_BROWSER_DEVICE } from './BrowserOptIn';
import { MenuCard, MenuRow } from './MenuChrome';
import {
  ComposerActionRow, ComposerSlashMenu,
  type ComposerBrowserControl, type ComposerCommissionControl,
} from './ComposerActionRow';

const commissions = vi.hoisted(() => ({
  list: [] as Array<{ id: string; title: string }>,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    commissions: {
      list: {
        queryOptions: (input: object) => ({
          queryKey: ['commissions.list', input],
          queryFn: async () => commissions.list,
        }),
      },
    },
  }),
}));

beforeEach(() => {
  // The browser page reads the connected devices when it opens; no device is the ordinary case.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, data: { devices: [] } }) })));
  commissions.list = [];
});

afterEach(() => vi.unstubAllGlobals());

describe('shared picker chrome', () => {
  it('keeps selections semantic and disabled choices inert on a stationary glass surface', () => {
    const onPick = vi.fn();
    const renderer = create(
      <MenuCard kind="test">
        <MenuRow id="test" label="Choice" sub="Unavailable" active disabled
          onPick={onPick} hover={null} setHover={vi.fn()} />
      </MenuCard>,
    );
    const row = renderer.root.findByType('button');
    expect(row.props['aria-pressed']).toBe(true);
    expect(row.props.disabled).toBe(true);
    expect(row.props.className).toContain('focus-visible:outline');
    act(() => row.props.onClick({ stopPropagation: vi.fn() }));
    expect(onPick).not.toHaveBeenCalled();
    const card = renderer.root.findByProps({ 'data-menu': 'test' });
    expect(card.props.style.background).toBe('var(--material-overlay-bg)');
    expect(card.props.style.backdropFilter).toBe('var(--glass-filter)');
    expect(card.props.style.overflow).toBe('hidden');
    const scroller = card.findByProps({ 'data-menu-scroll': true });
    expect(scroller.props.style.overflowY).toBe('auto');
    expect(scroller.props.style.backdropFilter).toBeUndefined();
    expect(row.props.style.backdropFilter).toBeUndefined();
  });
});

describe('ComposerSlashMenu', () => {
  it('runs enabled UI suggestions and ignores disabled ones', () => {
    const onPick = vi.fn();
    const renderer = create(
      <LangProvider>
        <ComposerSlashMenu
          suggestions={[
            { command: '/new', description: 'new', action: { type: 'new' }, disabled: false },
            { command: '/cancel', description: 'cancel', action: { type: 'cancel' }, disabled: true },
          ]}
          onPick={onPick}
        />
      </LangProvider>,
    );

    act(() => renderer.root.findByProps({ 'data-slash-command': '/new' }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-slash-command': '/cancel' }).props.onClick());

    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick.mock.calls[0][0].command).toBe('/new');
  });
});

function renderRow(
  browser: ComposerBrowserControl | null,
  commission: ComposerCommissionControl | null = null,
  agentControl: JSX.Element | null = null,
) {
  const onAttach = vi.fn();
  const onCommands = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <QueryClientProvider client={queryClient}>
        <LangProvider>
          <ComposerActionRow
            browser={browser}
            commission={commission}
            onAttach={onAttach}
            onCommands={onCommands}
            agentControl={agentControl}
            selectionControl={<span data-chip="selection">claude-opus-5 · high</span>}
            sendControl={<button type="button" data-action="send" />}
          />
        </LangProvider>
      </QueryClientProvider>,
    );
  });
  return { renderer, onAttach, onCommands };
}

const click = { stopPropagation: () => {} };

function openPlus(renderer: ReactTestRenderer): void {
  act(() => renderer.root.findByProps({ 'data-chip': 'plus' }).props.onClick(click));
}

describe('ComposerActionRow ＋ menu', () => {
  it('returns focus from a menu item on Escape but not on outside clicks', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const { renderer } = renderRow(null);
    const trigger = { isConnected: true, focus: vi.fn() };
    vi.stubGlobal('document', { activeElement: trigger });
    openPlus(renderer);
    vi.stubGlobal('document', { activeElement: { dataset: { plusItem: 'attach' } } });
    act(() => target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })));
    expect(renderer.root.findAllByProps({ 'data-menu': 'plus' })).toHaveLength(0);
    expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
    trigger.focus.mockClear();
    vi.stubGlobal('document', { activeElement: trigger });
    openPlus(renderer);
    act(() => target.dispatchEvent(new Event('click')));
    expect(trigger.focus).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('offers a device page rather than a bare toggle, and picking this host names it', () => {
    // Where the browser runs matters as much as whether it runs: the server draws on the server's
    // display, a device opens a window on the screen in front of you.
    const onChange = vi.fn();
    const { renderer } = renderRow({ device: null, onChange });
    openPlus(renderer);
    act(() => renderer.root.findByProps({ 'data-plus-item': 'browser' }).props.onClick(click));
    const row = renderer.root.findByProps({ 'data-device': DEFAULT_BROWSER_DEVICE });
    expect(row.type).toBe('button');
    expect(row.props.type).toBe('button');
    expect(row.props.className).toContain('focus-visible:outline');
    const menu = renderer.root.findByProps({ 'data-menu': 'plus' });
    expect(menu.props.style.background).toBe('var(--material-overlay-bg)');
    expect(menu.props.style.backdropFilter).toBe('var(--glass-filter)');
    act(() => row.props.onClick(click));
    expect(onChange).toHaveBeenCalledWith(DEFAULT_BROWSER_DEVICE);
  });

  it('turning it off clears the device rather than keeping a stale one', () => {
    const onChange = vi.fn();
    const { renderer } = renderRow({ device: DEFAULT_BROWSER_DEVICE, onChange });
    openPlus(renderer);
    act(() => renderer.root.findByProps({ 'data-plus-item': 'browser' }).props.onClick(click));
    act(() => renderer.root.findByProps({ 'data-device': '__off__' }).props.onClick(click));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('reports the device without offering a control on an existing session', () => {
    // The agent's tool set is fixed when its process spawns, so a switch here would be a lie.
    const { renderer } = renderRow({ device: 'server' });
    openPlus(renderer);
    const row = renderer.root.findByProps({ 'data-plus-item': 'browser' });
    expect(row.props['data-editable']).toBe('false');
    expect(row.type).toBe('button');
    expect(row.props.disabled).toBe(true);
    expect(row.props.onClick).toBeUndefined();
  });
});

describe('ComposerActionRow right cluster', () => {

  it('seats the environment before the engine — where the turn runs, then what runs it', () => {
    const { renderer } = renderRow(null, null, <span data-chip="agent">creative</span>);
    const chips = renderer.root.findAllByProps({ 'data-composer-actions': true })[0]
      .findAllByType('span')
      .map((node) => node.props['data-chip'])
      .filter((chip) => chip === 'agent' || chip === 'selection');
    expect(chips).toEqual(['agent', 'selection']);
  });

  it('leaves the row as it was when the host offers no environment to pick', () => {
    // The chip decides that for itself (SessionSelector.test); the row only has to survive it.
    const { renderer } = renderRow(null);
    expect(renderer.root.findAllByProps({ 'data-chip': 'agent' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-chip': 'selection' })).toHaveLength(1);
  });
});

describe('ComposerActionRow commission mode', () => {
  function chip(renderer: ReactTestRenderer) {
    return renderer.root.findAllByProps({ 'data-chip': 'commission' })[0];
  }

  it('starts a new commission from the ＋ menu', () => {
    // "New" is the ordinary way in: the user has a long task but no contract yet.
    const onChange = vi.fn();
    const { renderer } = renderRow(null, { value: null, onChange });
    openPlus(renderer);
    act(() => renderer.root.findByProps({ 'data-plus-item': 'commission' }).props.onClick(click));
    act(() => renderer.root.findByProps({ 'data-commission-option': 'new' }).props.onClick(click));
    expect(onChange).toHaveBeenCalledWith('new');
  });

  it('turns the mode back off from the menu', () => {
    const onChange = vi.fn();
    const { renderer } = renderRow(null, { value: 'new', onChange });
    openPlus(renderer);
    act(() => renderer.root.findByProps({ 'data-plus-item': 'commission' }).props.onClick(click));
    act(() => renderer.root.findByProps({ 'data-commission-option': '__off__' }).props.onClick(click));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('names the commission on a live bound session, and only reports', () => {
    const { renderer } = renderRow(null, { value: 'cm-1', label: 'Refactor the rail' });
    expect(chip(renderer).props['data-editable']).toBe('false');
    expect(chip(renderer).props.onClick).toBeUndefined();
  });
});
