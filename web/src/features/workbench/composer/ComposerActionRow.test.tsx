import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LangProvider } from '@/i18n';
import { DEFAULT_BROWSER_DEVICE } from '@/features/browser/BrowserOptIn';
import { MenuCard, MenuRow } from '@/design/MenuChrome';
import {
  ComposerActionRow, ComposerSlashMenu,
  type ComposerBrowserControl,
} from './ComposerActionRow';

beforeEach(() => {
  // The browser page reads the connected devices when it opens; no device is the ordinary case.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, data: { devices: [] } }) })));
});

afterEach(() => vi.unstubAllGlobals());

/** Every inline style in the tree, as one string — the focus ring's class names stay out of it. */
function inlineStyles(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.root.findAll((node) => typeof node.type === 'string').map((node) => node.props.style ?? null));
}

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
          activeIndex={0}
          onHover={vi.fn()}
          onPick={onPick}
        />
      </LangProvider>,
    );

    act(() => renderer.root.findByProps({ 'data-slash-command': '/new' }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-slash-command': '/cancel' }).props.onClick());

    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick.mock.calls[0][0].command).toBe('/new');
  });

  it('keeps the typed command in the code face and highlights with a gray tint, not the accent', () => {
    const renderer = create(
      <LangProvider>
        <ComposerSlashMenu
          suggestions={[{ command: '/new', description: 'new', action: { type: 'new' }, disabled: false }]}
          activeIndex={0}
          onHover={vi.fn()}
          onPick={vi.fn()}
        />
      </LangProvider>,
    );
    const row = renderer.root.findByProps({ 'data-slash-command': '/new' });
    expect(row.props.style.background).toBe('var(--proto-line-2)');
    const [command, description] = row.findAllByType('span');
    expect(command.props.style.font).toContain('var(--font-code)');
    expect(description.props.style.font).toBeUndefined();
    expect(inlineStyles(renderer)).not.toContain('proto-accent');
  });
});

function renderRow(
  browser: ComposerBrowserControl | null,
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
    act(() => { target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })); });
    expect(renderer.root.findAllByProps({ 'data-menu': 'plus' })).toHaveLength(0);
    expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
    trigger.focus.mockClear();
    vi.stubGlobal('document', { activeElement: trigger });
    openPlus(renderer);
    act(() => { target.dispatchEvent(new Event('click')); });
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
    const { renderer } = renderRow(null, <span data-chip="agent">creative</span>);
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

describe('ComposerActionRow quiet controls', () => {
  it('draws ＋ as a transparent circle and the browser as a filled quiet chip in the UI face', () => {
    const { renderer } = renderRow({ device: DEFAULT_BROWSER_DEVICE, onChange: vi.fn() });
    const plus = renderer.root.findByProps({ 'data-chip': 'plus' });
    expect(plus.props.style.background).toBe('transparent');
    expect(plus.props.style.border).toBe(0);
    const chip = renderer.root.findByProps({ 'data-chip': 'browser' });
    expect(chip.props.style.background).toBe('var(--proto-line-2)');
    expect(chip.props.style.border).toBe(0);
    expect(chip.props.style.font).toContain('var(--font-ui)');
    expect(inlineStyles(renderer)).not.toMatch(/proto-accent|Plex/);
    openPlus(renderer);
    expect(renderer.root.findByProps({ 'data-chip': 'plus' }).props.style.background).toBe('var(--proto-gray)');
  });
});

describe('ComposerActionRow plus menu', () => {
  it('offers attach, browser and commands only', () => {
    const { renderer } = renderRow({ device: null, onChange: vi.fn() });
    openPlus(renderer);
    const items = renderer.root.findAll((node) => typeof node.props['data-plus-item'] === 'string' && node.type === 'button')
      .map((node) => node.props['data-plus-item']);
    expect(items).toEqual(['attach', 'browser', 'commands']);
  });
});
