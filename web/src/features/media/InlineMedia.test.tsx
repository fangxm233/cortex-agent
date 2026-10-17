import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMarkdown } from '@/design/ChatMarkdown';
import { ChatMediaProvider } from './ChatMediaProvider';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), open: vi.fn(), near: true, downloadFailed: false,
}));
vi.mock('@/lib/trpc', () => {
  const client = { sessions: { resolveMedia: { mutate: mocks.resolve } } };
  return { useTRPCClient: () => client };
});
vi.mock('./MediaViewer', () => ({ useMediaViewer: () => ({ openMedia: mocks.open }) }));
vi.mock('./useNearViewport', () => ({ useNearViewport: () => mocks.near }));
vi.mock('./useWorkspaceObjectUrl', () => ({
  useWorkspaceObjectUrlState: (path?: string) => ({ url: path && !mocks.downloadFailed ? 'blob:preview' : null, failed: mocks.downloadFailed }),
}));

let renderer: ReactTestRenderer;
function Message({ src, ts = '2026-10-15T12:00:00Z' }: { src: string; ts?: string }): JSX.Element {
  return <ChatMediaProvider sessionId="s1" ts={ts || undefined}><ChatMarkdown text={`before ![plot](${src}) after`} /></ChatMediaProvider>;
}
async function render(src: string, ts?: string): Promise<void> {
  await act(async () => { renderer = create(<Message src={src} ts={ts} />); });
}
beforeEach(() => {
  mocks.near = true;
  mocks.downloadFailed = false;
  mocks.resolve.mockReset().mockResolvedValue({ path: 'workspace/outputs/s1/inline/a.png', name: 'a.png', kind: 'image' });
  mocks.open.mockReset();
});
afterEach(() => { act(() => renderer?.unmount()); });

describe('assistant inline media', () => {
  it('keeps image alt text inert without a chat context', () => {
    act(() => { renderer = create(<ChatMarkdown text="![plot](https://example.org/a.png)" />); });
    expect(renderer.root.findAllByType('img')).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('plot');
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('resolves local references with message identity and opens the existing viewer', async () => {
    await render('/tmp/a.png');
    expect(mocks.resolve).toHaveBeenCalledWith({ sessionId: 's1', ts: '2026-10-15T12:00:00Z', src: '/tmp/a.png' });
    expect(renderer.root.findByType('img').props.src).toBe('blob:preview');
    act(() => renderer.root.findByProps({ role: 'button' }).props.onClick());
    expect(mocks.open).toHaveBeenCalledWith({ path: 'workspace/outputs/s1/inline/a.png', name: 'plot', kind: 'image' });
  });

  it.each(['/tmp/a.png', 'lab-ksu:/home/x/a.png', 'my-pc:C:/Users/x/a.mp4'])('keeps streaming %s as a placeholder', async (src) => {
    await render(src, '');
    expect(renderer.root.findAllByProps({ 'data-media-placeholder': true })).toHaveLength(1);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType('img')).toHaveLength(0);
  });

  it('loads external images directly even while streaming', async () => {
    await render('https://example.org/a.png', '');
    expect(renderer.root.findByType('img').props).toMatchObject({ src: 'https://example.org/a.png', referrerPolicy: 'no-referrer' });
    expect(mocks.resolve).not.toHaveBeenCalled();
    act(() => renderer.root.findByProps({ role: 'button' }).props.onClick());
    expect(mocks.open).toHaveBeenCalledWith({ url: 'https://example.org/a.png', kind: 'image', name: 'plot' });
  });

  it('uses metadata-only video without autoplay or poster prefetch for external URLs', async () => {
    await render('https://example.org/a.mp4');
    expect(renderer.root.findByType('video').props).toMatchObject({ preload: 'metadata', src: 'https://example.org/a.mp4' });
    expect(renderer.root.findByType('video').props.autoPlay).toBeUndefined();
  });

  it.each(['https://127.0.0.1/a.png', 'http://example.org/a.png'])('renders blocked %s as a plain link', async (src) => {
    await render(src);
    expect(renderer.root.findAllByType('img')).toHaveLength(0);
    expect(renderer.root.findByType('a').props.href).toBe(src);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('does not make dangerous schemes clickable', async () => {
    await render('javascript:alert(1)');
    expect(renderer.root.findAllByType('a')).toHaveLength(0);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each(['/tmp/a.png', 'https://example.org/a.png'])('defers %s until near the viewport', async (src) => {
    mocks.near = false;
    await render(src);
    expect(renderer.root.findAllByType('img')).toHaveLength(0);
    expect(mocks.resolve).not.toHaveBeenCalled();
    mocks.near = true;
    await act(async () => { renderer.update(<Message src={src} />); });
    expect(renderer.root.findAllByType('img')).toHaveLength(1);
  });

  it('shows a localized device failure and retries for a new message identity', async () => {
    mocks.resolve.mockResolvedValueOnce({ error: { code: 'offline', reason: 'internal detail' } });
    await render('lab-ksu:/home/x/a.png');
    expect(JSON.stringify(renderer.toJSON())).toContain('Device offline');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('internal detail');
    await act(async () => { renderer.update(<Message src="lab-ksu:/home/x/a.png" ts="2026-10-15T12:01:00Z" />); });
    expect(renderer.root.findAllByType('img')).toHaveLength(1);
  });

  it('shows failed downloads and image decoding as load failures', async () => {
    mocks.downloadFailed = true;
    await render('/tmp/a.png');
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not load media.');
    mocks.downloadFailed = false;
    await act(async () => { renderer.update(<Message src="https://example.org/a.png" />); });
    act(() => renderer.root.findByType('img').props.onError());
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not load media.');
  });
});
