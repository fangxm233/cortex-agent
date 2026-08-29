// input:  Toolbar nodes, ＋-menu actions, browser/commission controls and slash suggestions
// output: Composer toolbar, ＋-menu and local slash-menu interaction regressions
// pos:    Desktop composer action behavior specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LangProvider } from '@/i18n';
import { DEFAULT_BROWSER_DEVICE } from './BrowserOptIn';
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
            profileControl={<span data-chip="profile">profile · plan</span>}
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
  it('folds attach and commands into the menu and invokes their actions', () => {
    const { renderer, onAttach, onCommands } = renderRow(null);

    openPlus(renderer);
    act(() => renderer.root.findByProps({ 'data-plus-item': 'attach' }).props.onClick(click));
    expect(onAttach).toHaveBeenCalledOnce();
    // A picked action closes the menu.
    expect(renderer.root.findAllByProps({ 'data-menu': 'plus' })).toHaveLength(0);

    openPlus(renderer);
    act(() => renderer.root.findByProps({ 'data-plus-item': 'commands' }).props.onClick(click));
    expect(onCommands).toHaveBeenCalledOnce();
  });

  it('omits the browser row entirely for a session that has none', () => {
    // A live session that never opted in must not grow a control that would do nothing.
    const { renderer } = renderRow(null);
    openPlus(renderer);
    expect(renderer.root.findAllByProps({ 'data-plus-item': 'browser' })).toHaveLength(0);
  });

  it('offers a device page rather than a bare toggle, and picking this host names it', () => {
    // Where the browser runs matters as much as whether it runs: the server draws on the server's
    // display, a device opens a window on the screen in front of you.
    const onChange = vi.fn();
    const { renderer } = renderRow({ device: null, onChange });
    openPlus(renderer);
    act(() => renderer.root.findByProps({ 'data-plus-item': 'browser' }).props.onClick(click));
    const row = renderer.root.findByProps({ 'data-device': DEFAULT_BROWSER_DEVICE });
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
    expect(row.props.onClick).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain('server');
  });
});

describe('ComposerActionRow browser capsule', () => {
  function chip(renderer: ReactTestRenderer) {
    return renderer.root.findAllByProps({ 'data-chip': 'browser' })[0];
  }

  it('stays absent while browsing is off, on a draft and on a plain session alike', () => {
    // The ＋ menu already carries the choice; a capsule for "no browser" would mark nothing.
    expect(chip(renderRow({ device: null, onChange: vi.fn() }).renderer)).toBeUndefined();
    expect(chip(renderRow(null).renderer)).toBeUndefined();
  });

  it('names the chosen device once a browser is on, without opening the ＋ menu', () => {
    // Which machine's screen the agent drives is the whole point of the choice.
    const { renderer } = renderRow({ device: 'my-pc', onChange: vi.fn() });
    expect(chip(renderer).props['data-browser-device']).toBe('my-pc');
    expect(JSON.stringify(renderer.toJSON())).toContain('my-pc');
  });

  it('switches machines from the capsule itself', () => {
    const onChange = vi.fn();
    const { renderer } = renderRow({ device: 'my-pc', onChange });
    act(() => chip(renderer).props.onClick(click));
    act(() => renderer.root.findByProps({ 'data-device': DEFAULT_BROWSER_DEVICE }).props.onClick(click));
    expect(onChange).toHaveBeenCalledWith(DEFAULT_BROWSER_DEVICE);
  });

  it('turns browsing off from the capsule, and closes its menu after a pick', () => {
    const onChange = vi.fn();
    const { renderer } = renderRow({ device: DEFAULT_BROWSER_DEVICE, onChange });
    act(() => chip(renderer).props.onClick(click));
    act(() => renderer.root.findByProps({ 'data-device': '__off__' }).props.onClick(click));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(renderer.root.findAllByProps({ 'data-menu': 'browser' })).toHaveLength(0);
  });

  it('only reports on a live session', () => {
    // Same reason the ＋ row is read-only there: the tool set is fixed at spawn.
    const { renderer } = renderRow({ device: 'server' });
    expect(chip(renderer).props['data-editable']).toBe('false');
    expect(chip(renderer).props.onClick).toBeUndefined();
  });
});

describe('ComposerActionRow commission mode', () => {
  function chip(renderer: ReactTestRenderer) {
    return renderer.root.findAllByProps({ 'data-chip': 'commission' })[0];
  }

  it('omits the commission row entirely for a session outside the mode', () => {
    const { renderer } = renderRow(null, null);
    openPlus(renderer);
    expect(renderer.root.findAllByProps({ 'data-plus-item': 'commission' })).toHaveLength(0);
  });

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

  it('shows no capsule while the mode is off', () => {
    expect(chip(renderRow(null, { value: null, onChange: vi.fn() }).renderer)).toBeUndefined();
    expect(chip(renderRow(null, null).renderer)).toBeUndefined();
  });

  it('marks an unnamed draft rather than pretending it has a title', () => {
    // The name is only fixed at contract approval — that is the point of the drill.
    const { renderer } = renderRow(null, { value: 'new', onChange: vi.fn() });
    expect(chip(renderer).props['data-commission-value']).toBe('new');
  });

  it('names the commission on a live bound session, and only reports', () => {
    const { renderer } = renderRow(null, { value: 'cm-1', label: 'Refactor the rail' });
    expect(chip(renderer).props['data-editable']).toBe('false');
    expect(chip(renderer).props.onClick).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain('Refactor the rail');
  });

  it('is independent of the browser control', () => {
    // Both are creation-time modes, but one is not a proxy for the other.
    const { renderer } = renderRow({ device: 'my-pc', onChange: vi.fn() }, { value: 'new', onChange: vi.fn() });
    expect(renderer.root.findAllByProps({ 'data-chip': 'browser' })[0]).toBeDefined();
    expect(chip(renderer)).toBeDefined();
  });
});
