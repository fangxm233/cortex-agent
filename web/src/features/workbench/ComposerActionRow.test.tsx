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
