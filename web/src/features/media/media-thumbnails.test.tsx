import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import type { AttachmentMeta } from '@/features/attachments/types';
import { AttachmentCard, AgentFileGroup, UserAttachmentRow } from '@/features/session/transcript/MessageAttachmentCards';
import { AttachmentGroup } from '@/mobile/screens/MChatAttachments';
import { useWorkspaceObjectUrl } from './useWorkspaceObjectUrl';

vi.mock('./useWorkspaceObjectUrl', () => ({ useWorkspaceObjectUrl: vi.fn(() => null) }));
vi.mock('./useDownloadFile', () => ({ useDownloadFile: () => vi.fn() }));
const openMedia = vi.hoisted(() => vi.fn());
vi.mock('./MediaViewer', () => ({ useMediaViewer: () => ({ openMedia }) }));
vi.mock('./DocViewer', () => ({ useDocViewer: () => ({ openDoc: vi.fn() }) }));

const attachment: AttachmentMeta = {
  name: 'clip.mp4', path: 'workspace/clip.mp4', type: 'video', size: 10, mimeType: 'video/mp4',
};

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('media thumbnail viewport gating', () => {
  it.each([
    ['desktop user', () => <AttachmentCard a={attachment} />],
    ['desktop agent', () => <AgentFileGroup attachments={[attachment]} />],
    ['mobile', () => <AttachmentGroup attachments={[attachment]} />],
  ] as const)('defers %s media until it approaches the viewport', (_name, content) => {
    let enter!: () => void;
    const observe = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) {
        enter = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe = observe;
      disconnect = vi.fn();
    });
    let view!: ReturnType<typeof create>;
    act(() => { view = create(<LangProvider>{content()}</LangProvider>, { createNodeMock: () => ({}) }); });
    expect(observe).toHaveBeenCalledOnce();
    expect(useWorkspaceObjectUrl).toHaveBeenLastCalledWith(null);
    act(() => enter());
    expect(useWorkspaceObjectUrl).toHaveBeenLastCalledWith(attachment.path);
    act(() => view.unmount());
  });
});

describe('attachment media groups', () => {
  const shot = (name: string, type: 'image' | 'video' | 'file'): AttachmentMeta => ({ name, path: `workspace/${name}`, type, size: 10, mimeType: 'x' });
  const sent = [shot('a.png', 'image'), shot('notes.csv', 'file'), shot('b.png', 'image'), shot('c.mp4', 'video')];
  const tileOf = (root: ReactTestInstance, name: string): ReactTestInstance =>
    root.find((node) => typeof node.type === 'string' && node.props.role === 'button' && node.findAll((c) => c.children.includes(name)).length > 0);

  it.each([
    ['desktop user', () => <UserAttachmentRow attachments={sent} />],
    ['desktop agent', () => <AgentFileGroup attachments={sent} />],
    ['mobile', () => <AttachmentGroup attachments={sent} side="left" />],
  ] as const)('opens %s media as one group, without the plain files', (_name, content) => {
    let view!: ReturnType<typeof create>;
    act(() => { view = create(<LangProvider>{content()}</LangProvider>, { createNodeMock: () => ({}) }); });

    act(() => tileOf(view.root, 'b.png').props.onClick());

    const [opened, group] = openMedia.mock.calls[0];
    expect(group.map((item: { name: string }) => item.name)).toEqual(['a.png', 'b.png', 'c.mp4']);
    expect(group[1]).toBe(opened);
    act(() => view.unmount());
  });
});
