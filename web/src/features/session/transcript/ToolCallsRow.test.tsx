import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import type { ToolCall } from '@/features/session/composer/chat-content';
import { DebugDetailsModal, DebugInspectButton } from './DebugDetailsModal';
import { ToolCallsRow } from './ToolCallsRow';

const harness = vi.hoisted(() => ({ query: vi.fn(), openMedia: vi.fn() }));
vi.mock('@/features/media/MediaViewer', () => ({ useMediaViewer: () => ({ openMedia: harness.openMedia }) }));
vi.mock('@/features/media/useNearViewport', () => ({ useNearViewport: () => true }));
vi.mock('@/features/media/useWorkspaceObjectUrl', () => ({ useWorkspaceObjectUrl: (path: string | null) => (path ? `blob:${path}` : null) }));
vi.mock('@/lib/trpc', () => ({
  useTRPCClient: () => ({ sessions: { debugDetails: { query: harness.query } } }),
}));
vi.mock('./DebugDetailsModal', () => ({
  DebugDetailsModal: () => null,
  DebugInspectButton: () => null,
}));

const calls: ToolCall[] = [
  { kind: 'read', input: 'file.ts', debug: { toolRef: 'tool-1' } },
  { kind: 'bash', input: 'pwd' },
];
function mount(items = calls, touch = false): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LangProvider><ToolCallsRow calls={items} sessionId="s1" touch={touch} /></LangProvider>); });
  return renderer;
}

function text(node: ReactTestRenderer['root']): string {
  return node.findAll((n) => typeof n.type === 'string').flatMap((n) => n.children.filter((c) => typeof c === 'string')).join('');
}

const imageCalls: ToolCall[] = [
  { kind: 'Read', input: '/tmp/a.png', images: [{ name: 'tu-a-0.png', path: 'workspace/tool-images/s1/tu-a-0.png' }], debug: { toolRef: 'tu-a' } },
  { kind: 'remote_read', input: 'gpu:/tmp/b.jpg', images: [
    { name: 'tu-b-0.jpg', path: 'workspace/tool-images/s1/tu-b-0.jpg' },
    { name: 'tu-b-1.jpg', path: 'workspace/tool-images/s1/tu-b-1.jpg' },
  ] },
];

beforeEach(() => { harness.query.mockReset(); harness.openMedia.mockReset(); });

describe('ToolCallsRow', () => {
  it('says what the run did in one line, and keeps the same toggle across expansion and collapse', () => {
    const renderer = mount();
    const toggle = renderer.root.findByType('button');
    expect(text(toggle)).toBe('Read file.ts · Ran 1 command');
    expect(toggle.props['aria-expanded']).toBe(false);
    expect(toggle.props.className).toContain('focus-visible:outline');
    act(() => toggle.props.onClick());
    expect(renderer.root.findByType('button') === toggle).toBe(true);
    expect(toggle.props['aria-expanded']).toBe(true);
    expect(renderer.root.findAllByType(DebugInspectButton)).toHaveLength(1);
    act(() => toggle.props.onClick());
    expect(renderer.root.findByType('button') === toggle).toBe(true);
    expect(toggle.props['aria-expanded']).toBe(false);
    expect(renderer.root.findAllByType(DebugInspectButton)).toHaveLength(0);
    expect(harness.query).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('opens to one line per call, and a click on the list folds it back', () => {
    const renderer = mount();
    const toggle = renderer.root.findByType('button');
    act(() => toggle.props.onClick());
    const panel = renderer.root.findByProps({ 'data-tool-calls-panel': true });
    expect(panel.findAllByProps({ 'data-tool-call': '' })).toHaveLength(2);
    expect(text(panel)).toContain('file.ts');
    expect(text(panel)).toContain('pwd');
    act(() => panel.props.onClick());
    expect(toggle.props['aria-expanded']).toBe(false);
    expect(renderer.root.findAllByProps({ 'data-tool-calls-panel': true })).toHaveLength(0);
    expect(renderer.root.findByType('button')).toBe(toggle);
    act(() => renderer.unmount());
  });

  it('loads missing debug details only on inspect, not on expansion', async () => {
    const loaded = { toolInput: { path: 'file.ts' }, toolResult: { content: 'source', isError: false } };
    harness.query.mockResolvedValue(loaded);
    const renderer = mount();
    expect(harness.query).not.toHaveBeenCalled();
    act(() => renderer.root.findByType('button').props.onClick());
    expect(harness.query).not.toHaveBeenCalled();
    const stopPropagation = vi.fn();
    await act(async () => {
      renderer.root.findByType(DebugInspectButton).props.onClick({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(renderer.root.findByType('button').props['aria-expanded']).toBe(true);
    expect(harness.query).toHaveBeenCalledTimes(1);
    expect(harness.query).toHaveBeenCalledWith({ sessionId: 's1', ref: 'tool-1' });
    expect(renderer.root.findByType(DebugDetailsModal).props.detail).toMatchObject(loaded);
    act(() => renderer.unmount());
  });

  it('does not fetch a tool result already present in the transcript', () => {
    const toolResult = { content: 'cached', isError: false };
    const renderer = mount([{ ...calls[0], debug: { toolRef: 'tool-1', toolResult } }]);
    act(() => renderer.root.findByType('button').props.onClick());
    act(() => renderer.root.findByType(DebugInspectButton).props.onClick({ stopPropagation: vi.fn() }));
    expect(harness.query).not.toHaveBeenCalled();
    expect(renderer.root.findByType(DebugDetailsModal).props.detail.toolResult).toEqual(toolResult);
    act(() => renderer.unmount());
  });

  it('touch rows keep the same chrome with a finger-sized target and visible inspection', () => {
    const renderer = mount(calls, true);
    const toggle = renderer.root.findByType('button');
    expect(toggle.props.style.minHeight).toBe(40);
    expect(toggle.props.className).not.toContain('hover:');
    act(() => toggle.props.onClick());
    expect(renderer.root.findByType(DebugInspectButton).props.visible).toBe(true);
    act(() => renderer.unmount());
  });

  it('an image row reads as a count of images, with no image while collapsed', () => {
    const renderer = mount(imageCalls);
    const toggle = renderer.root.findByType('button');
    expect(text(toggle)).toBe('Read 3 images');
    expect(renderer.root.findAllByProps({ 'data-tool-image': true })).toHaveLength(0);
    act(() => renderer.unmount());

    const single = mount([imageCalls[0]]);
    expect(text(single.root.findByType('button'))).toBe('Read 1 image');
    act(() => single.unmount());
  });

  it('expanded, each call keeps its line and hangs its images under it', () => {
    const renderer = mount(imageCalls);
    act(() => renderer.root.findByType('button').props.onClick());
    const panel = renderer.root.findByProps({ 'data-tool-calls-panel': true });
    expect(text(panel)).toContain('/tmp/a.png');
    expect(text(panel)).toContain('gpu:/tmp/b.jpg');
    expect(renderer.root.findAllByType(DebugInspectButton)).toHaveLength(1);
    const thumbs = renderer.root.findAllByProps({ 'data-tool-image': true });
    expect(thumbs).toHaveLength(3);
    expect(thumbs[0].props.style).toMatchObject({ height: 'auto', width: 'auto', maxWidth: '100%', borderRadius: 'var(--r-card)' });
    const img = thumbs[0].findByType('img');
    expect(img.props.src).toBe('blob:workspace/tool-images/s1/tu-a-0.png');
    expect(img.props.style).toMatchObject({ maxHeight: 120, maxWidth: '100%' });
    act(() => renderer.unmount());
  });

  it('clicking an image opens it in the media viewer and leaves the panel open', () => {
    const renderer = mount(imageCalls);
    act(() => renderer.root.findByType('button').props.onClick());
    const stopPropagation = vi.fn();
    act(() => renderer.root.findAllByProps({ 'data-tool-image': true })[2].props.onClick({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(harness.openMedia).toHaveBeenCalledWith({ kind: 'image', name: 'tu-b-1.jpg', path: 'workspace/tool-images/s1/tu-b-1.jpg' });
    expect(renderer.root.findByType('button').props['aria-expanded']).toBe(true);
    act(() => renderer.unmount());
  });

  it('a mixed run still renders as an ordinary tool row', () => {
    const renderer = mount([imageCalls[0], calls[1]]);
    expect(text(renderer.root.findByType('button'))).toBe('Read a.png · Ran 1 command');
    act(() => renderer.unmount());
  });
});

describe('ToolCallsRow as the live step', () => {
  const live: ToolCall[] = [
    { kind: 'bash', input: 'pwd' },
    { kind: 'Read', input: '/src/parser.ts' },
    { kind: 'thinking', input: 'so the parser…', thinking: true, preview: true },
  ];
  const line = (renderer: ReactTestRenderer): string[] => renderer.root.findByType('button')
    .findAll((n) => n.type === 'span' && typeof n.children[0] === 'string').map((n) => n.children[0] as string);

  it('leads with the step under way, then what the run did before it', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<LangProvider><ToolCallsRow calls={live} sessionId="s1" live /></LangProvider>); });
    expect(line(renderer)).toEqual(['Thinking', 'Ran 1 command · Read parser.ts']);
    act(() => renderer.update(<LangProvider><ToolCallsRow calls={live.slice(0, 2)} sessionId="s1" live /></LangProvider>));
    expect(line(renderer)).toEqual(['Reading parser.ts', 'Ran 1 command']);
    act(() => renderer.update(<LangProvider><ToolCallsRow calls={live.slice(0, 2)} sessionId="s1" /></LangProvider>));
    expect(line(renderer)).toEqual(['Ran 1 command · Read parser.ts']);
    act(() => renderer.unmount());
  });
});
