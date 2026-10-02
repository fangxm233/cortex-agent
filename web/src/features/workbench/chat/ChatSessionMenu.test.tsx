import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSessionMenu } from './ChatSessionMenu';
import { MChatSessionMenu } from '@/mobile/screens/MChatSessionMenu';
import type { MChatCopy } from '@/mobile/screens/MChatView.types';
import type { MetadataSession } from '@/features/session/metadata/SessionMetadata';

const rpc = vi.hoisted(() => ({ star: vi.fn(), rename: vi.fn(), lang: 'en' }));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({ sessions: {
  setStarred: { mutationOptions: () => ({ mutationFn: rpc.star }) },
  rename: { mutationOptions: () => ({ mutationFn: rpc.rename }) },
  list: { queryFilter: () => ({ queryKey: ['sessions', 'list'] }) },
} }) }));
vi.mock('@/i18n', () => ({ useLang: () => rpc.lang, useVocab: () => ({ wbSessionId: 'Session ID' }) }));
vi.mock('@/design/Modal', () => ({ Modal: ({ open, children, footer }: any) =>
  open ? <section role="dialog">{children}{footer}</section> : null }));

const first = { sessionId: 'stable-1', title: 'Display title', starred: false };
const onId = vi.fn();
const onStats = vi.fn();
const copy = { menuSessionId: 'Session ID', menuSessionStats: 'Session stats' } as MChatCopy;
let renderer: ReactTestRenderer;
let client: QueryClient;
function Mobile({ session }: { session: MetadataSession | null }) {
  const [open, setOpen] = useState(false);
  return <><button data-chip="more" onClick={() => setOpen(true)}>⋯</button>
    <MChatSessionMenu metadataSession={session} copy={copy} moreOpen={open} onMoreClose={() => setOpen(false)}
      onSessionIdOpen={onId} sessionStatsRows={[{ key: 'span', label: 'Time', value: '1m' }]} onSessionStatsOpen={onStats} />
  </>;
}
function tree(mobile: boolean, session: MetadataSession | null) {
  return <QueryClientProvider client={client}>{mobile ? <Mobile session={session} />
    : <ChatSessionMenu session={session} onSessionId={onId} />}</QueryClientProvider>;
}
function open() {
  act(() => renderer.root.findByProps({ 'data-chip': 'more' }).props.onClick({ stopPropagation() {} }));
}
function button(label: string) {
  return renderer.root.findAllByType('button').find((node) => node.children.includes(label))!;
}
async function click(label: string) {
  await act(async () => button(label).props.onClick());
}
beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  rpc.star.mockReset().mockImplementation(async (input) => input);
  rpc.rename.mockReset().mockImplementation(async (input) => input);
  rpc.lang = 'en'; onId.mockClear(); onStats.mockClear();
});
afterEach(() => { act(() => renderer?.unmount()); client.clear(); vi.unstubAllGlobals(); });

describe.each([false, true])('session ellipsis integration (mobile=%s)', (mobile) => {
  it('preserves identifiers/stats and sends Star/Unstar from the actual menu', async () => {
    act(() => { renderer = create(tree(mobile, first)); }); open();
    expect(renderer.root.findAll((node) => node.children.includes('Session ID')).length).toBeGreaterThan(0);
    if (mobile) expect(renderer.root.findAll((node) => node.children.includes('Session stats')).length).toBeGreaterThan(0);
    await click('Star');
    expect(rpc.star).toHaveBeenLastCalledWith({ sessionId: 'stable-1', starred: true }, expect.anything());
    open(); await click('Unstar');
    expect(rpc.star).toHaveBeenLastCalledWith({ sessionId: 'stable-1', starred: false }, expect.anything());
    open();
    const id = renderer.root.findAll((node) => node.children.includes('Session ID') && node.props.onClick)[0];
    act(() => id.props.onClick()); expect(onId).toHaveBeenCalledTimes(1);
    if (!mobile) return;
    open();
    const stats = renderer.root.findAll((node) => node.children.includes('Session stats') && node.props.onClick)[0];
    act(() => stats.props.onClick()); expect(onStats).toHaveBeenCalledTimes(1);
  });
  it('keeps rename mounted after closing the menu and targets the newly selected session', async () => {
    act(() => { renderer = create(tree(mobile, first)); }); open(); await click('Rename');
    expect(renderer.root.findByType('input').props.value).toBe('Display title');
    expect(button('Star')).toBeUndefined();
    act(() => renderer.root.findByType('input').props.onChange({ target: { value: 'Discarded' } }));
    act(() => renderer.update(tree(mobile, { sessionId: 'stable-2', title: 'Second', starred: true })));
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
    open(); await click('Rename');
    expect(renderer.root.findByType('input').props.value).toBe('Second');
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(rpc.rename).toHaveBeenCalledWith({ sessionId: 'stable-2', label: 'Second' }, expect.anything());
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
  });
  it('clears rename on a switch to a draft and disables both new actions', async () => {
    act(() => { renderer = create(tree(mobile, first)); }); open(); await click('Rename');
    act(() => renderer.update(tree(mobile, null))); open();
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
    expect(button('Star').props.disabled).toBe(true);
    expect(button('Rename').props.disabled).toBe(true);
    expect(rpc.rename).not.toHaveBeenCalled();
  });
  it('uses dedicated Chinese labels', () => {
    rpc.lang = 'zh';
    act(() => { renderer = create(tree(mobile, { ...first, starred: true })); }); open();
    expect(button('取消星标')).toBeDefined(); expect(button('重命名')).toBeDefined();
  });
});
