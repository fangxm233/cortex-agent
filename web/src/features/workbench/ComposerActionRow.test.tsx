// input:  Toolbar nodes, ＋-menu actions, browser control and slash suggestions
// output: Composer toolbar, ＋-menu and local slash-menu interaction regressions
// pos:    Desktop composer action behavior specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LangProvider } from '@/i18n';
import { DEFAULT_BROWSER_DEVICE } from './BrowserOptIn';
import { ComposerActionRow, ComposerSlashMenu, type ComposerBrowserControl } from './ComposerActionRow';

beforeEach(() => {
  // The browser page reads the connected devices when it opens; no device is the ordinary case.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, data: { devices: [] } }) })));
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

function renderRow(browser: ComposerBrowserControl | null) {
  const onAttach = vi.fn();
  const onCommands = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <LangProvider>
        <ComposerActionRow
          browser={browser}
          onAttach={onAttach}
          onCommands={onCommands}
          profileControl={<span data-chip="profile">profile · plan</span>}
          sendControl={<button type="button" data-action="send" />}
        />
      </LangProvider>,
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
