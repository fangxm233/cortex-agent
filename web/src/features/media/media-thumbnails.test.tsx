import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import type { AttachmentMeta } from '@/features/attachments/types';
import { AttachmentCard, AgentFileGroup } from '@/features/session/transcript/MessageAttachmentCards';
import { AttachmentGroup } from '@/mobile/screens/MChatAttachments';
import { useWorkspaceObjectUrl } from './useWorkspaceObjectUrl';

vi.mock('./useWorkspaceObjectUrl', () => ({ useWorkspaceObjectUrl: vi.fn(() => null) }));
vi.mock('./useDownloadFile', () => ({ useDownloadFile: () => vi.fn() }));
vi.mock('./MediaViewer', () => ({ useMediaViewer: () => ({ openMedia: vi.fn() }) }));
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
