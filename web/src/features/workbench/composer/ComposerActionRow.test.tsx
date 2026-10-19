import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LangProvider } from '@/i18n';
import { MENU_INSET, MenuCard, MenuRow } from '@/design/MenuChrome';
import { ComposerActionRow, ComposerSlashMenu } from './ComposerActionRow';

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
    // Rows sit in from the card's edges, so a tint is a rounded inset shape on both sides alike.
    expect(scroller.props.style.padding).toBe(MENU_INSET);
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
    expect(renderer.root.findByProps({ role: 'listbox' }).props.style.padding).toBe(MENU_INSET);
    const [command, description] = row.findAllByType('span');
    expect(command.props.style.font).toContain('var(--font-code)');
    expect(description.props.style.font).toBeUndefined();
    expect(inlineStyles(renderer)).not.toContain('proto-accent');
  });
});

function renderRow(agentControl: JSX.Element | null = null) {
  const onAttach = vi.fn();
  const onCommands = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <QueryClientProvider client={queryClient}>
        <LangProvider>
          <ComposerActionRow
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
    const { renderer } = renderRow();
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
});

describe('ComposerActionRow right cluster', () => {

  it('seats the environment before the engine — where the turn runs, then what runs it', () => {
    const { renderer } = renderRow(<span data-chip="agent">creative</span>);
    const chips = renderer.root.findAllByProps({ 'data-composer-actions': true })[0]
      .findAllByType('span')
      .map((node) => node.props['data-chip'])
      .filter((chip) => chip === 'agent' || chip === 'selection');
    expect(chips).toEqual(['agent', 'selection']);
  });

  it('leaves the row as it was when the host offers no environment to pick', () => {
    // The chip decides that for itself (SessionSelector.test); the row only has to survive it.
    const { renderer } = renderRow();
    expect(renderer.root.findAllByProps({ 'data-chip': 'agent' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-chip': 'selection' })).toHaveLength(1);
  });
});

describe('ComposerActionRow quiet controls', () => {
  it('draws ＋ as a transparent circle, without the accent', () => {
    const { renderer } = renderRow();
    const plus = renderer.root.findByProps({ 'data-chip': 'plus' });
    expect(plus.props.style.background).toBe('transparent');
    expect(plus.props.style.border).toBe(0);
    expect(inlineStyles(renderer)).not.toMatch(/proto-accent|Plex/);
    openPlus(renderer);
    expect(renderer.root.findByProps({ 'data-chip': 'plus' }).props.style.background).toBe('var(--proto-gray)');
  });
});

describe('ComposerActionRow plus menu', () => {
  it('offers attach and commands only, on the glass menu surface', () => {
    const { renderer, onAttach } = renderRow();
    openPlus(renderer);
    const items = renderer.root.findAll((node) => typeof node.props['data-plus-item'] === 'string' && node.type === 'button')
      .map((node) => node.props['data-plus-item']);
    expect(items).toEqual(['attach', 'commands']);
    const menu = renderer.root.findByProps({ 'data-menu': 'plus' });
    expect(menu.props.style.background).toBe('var(--material-overlay-bg)');
    expect(menu.props.style.backdropFilter).toBe('var(--glass-filter)');
    act(() => renderer.root.findByProps({ 'data-plus-item': 'attach' }).props.onClick(click));
    expect(onAttach).toHaveBeenCalledOnce();
    expect(renderer.root.findAllByProps({ 'data-menu': 'plus' })).toHaveLength(0);
  });
});
