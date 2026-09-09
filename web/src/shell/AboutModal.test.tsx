// input:  AboutModal, native responses and bilingual vocabulary
// output: focused About identity, version and link regressions
// pos:    About dialog rendering and interaction specification
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enBase } from '@/i18n/vocab-en-base';
import { zhBase } from '@/i18n/vocab-zh-base';
import { openExternalUrl } from '@/lib/external-navigation';
import { AboutModal } from './AboutModal';

let vocab = enBase;
vi.mock('@/i18n', () => ({ useVocab: () => vocab }));
vi.mock('@/lib/build-info', () => ({ BUILD_STAMP: '0908-1234·abc1234' }));
vi.mock('@/lib/external-navigation', () => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@radix-ui/react-dialog', () => {
  const part = (name: string) => ({ children, ...props }: any) => (
    <div data-radix-part={name} {...props}>{children}</div>
  );
  return {
    Root: part('root'), Portal: part('portal'), Overlay: part('overlay'),
    Content: part('content'), Title: part('title'), Description: part('description'), Close: part('close'),
  };
});

let tree: ReactTestRenderer;
async function render(onClose = vi.fn()): Promise<void> {
  await act(async () => { tree = create(<AboutModal onClose={onClose} />); });
}
function text(): string { return JSON.stringify(tree.toJSON()); }
function part(name: string) { return tree.root.findByProps({ 'data-radix-part': name }); }
function native(invoke: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('__TAURI__', { core: { invoke } });
}

afterEach(() => {
  act(() => tree?.unmount());
  vocab = enBase;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('About Cortex', () => {
  it('reuses the real icon, build identity and accessible Modal semantics', async () => {
    const onClose = vi.fn();
    await render(onClose);
    expect(tree.root.findByType('img').props).toMatchObject({
      src: '/apple-touch-icon.png', alt: '', width: 72, height: 72,
    });
    expect(tree.root.findByType('h2').children).toEqual(['Cortex']);
    expect(part('title').children).toEqual([enBase.aboutTitle]);
    expect(part('description').children).toEqual([enBase.aboutDescription]);
    expect(part('close').props['aria-label']).toBe(enBase.winClose);
    expect(tree.root.findAllByType('dt').map(node => node.children[0]))
      .toEqual([enBase.aboutFrontend, enBase.aboutShell]);
    expect(text()).toContain('0908-1234·abc1234');
    act(() => part('root').props.onOpenChange(true));
    expect(onClose).not.toHaveBeenCalled();
    act(() => part('root').props.onOpenChange(false));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('identifies a browser only when native invocation is unavailable', async () => {
    await render();
    expect(text()).toContain(enBase.aboutShellBrowser);
    expect(text()).not.toContain(enBase.aboutShellFailed);
    expect(tree.root.findByProps({ role: 'status' }).props['aria-busy']).toBe(false);
  });

  it('shows pending then the actual independent shell version', async () => {
    let resolve!: (value: string) => void;
    const invoke = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    native(invoke);
    await render();
    expect(text()).toContain(enBase.aboutShellLoading);
    expect(text()).not.toContain(enBase.aboutShellBrowser);
    expect(tree.root.findByProps({ role: 'status' }).props['aria-busy']).toBe(true);
    await act(async () => { resolve('0.9.8'); });
    expect(text()).toContain('0.9.8');
    expect(text()).not.toContain(enBase.aboutShellLoading);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('plugin:app|version', undefined);
  });

  it.each([enBase, zhBase])('distinguishes failed native reads in both languages', async (language) => {
    vocab = language;
    native(vi.fn().mockRejectedValue(new Error('permission denied')));
    await render();
    expect(text()).toContain(language.aboutTitle);
    expect(text()).toContain(language.aboutDescription);
    expect(text()).toContain(language.aboutShellFailed);
    expect(text()).not.toContain(language.aboutShellBrowser);
    expect(text()).not.toContain('permission denied');
  });

  it('routes both project links through existing external navigation', async () => {
    await render();
    const links = tree.root.findAllByType('a');
    expect(links.map(link => link.props.href)).toEqual([
      'https://fangxm233.github.io/cortex-agent/', 'https://github.com/fangxm233/cortex-agent',
    ]);
    expect(links.map(link => link.children[0])).toEqual([enBase.aboutDocs, enBase.aboutProject]);
    for (const link of links) {
      const preventDefault = vi.fn();
      await act(async () => { link.props.onClick({ preventDefault }); });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(openExternalUrl).toHaveBeenLastCalledWith(link.props.href);
    }
  });

  it('reports a link failure and clears it on the next attempt', async () => {
    vi.mocked(openExternalUrl).mockRejectedValueOnce(new Error('blocked'));
    await render();
    const link = tree.root.findAllByType('a')[0];
    await act(async () => { link.props.onClick({ preventDefault: vi.fn() }); });
    expect(tree.root.findByProps({ role: 'alert' }).children).toEqual([enBase.aboutLinkError]);
    await act(async () => { link.props.onClick({ preventDefault: vi.fn() }); });
    expect(tree.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
  });

  it('allows an in-flight version read to finish after dismissal', async () => {
    let resolve!: (value: string) => void;
    native(vi.fn(() => new Promise<string>(done => { resolve = done; })));
    await render();
    act(() => tree.unmount());
    await act(async () => { resolve('0.9.8'); });
    expect(tree.toJSON()).toBeNull();
  });
});
