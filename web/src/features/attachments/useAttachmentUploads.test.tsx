// input:  Shared upload hook, deferred transport, scope changes, previews, and mixed states
// output: FIFO concurrency, retry, abort, stale guard, restoration, cleanup, progress, and send-gate tests
// pos:    Shared attachment queue and controller specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AttachmentUploadTransport } from './upload-attachment';
import type { AttachmentMeta } from './types';
import { attachmentSendAllowed, type AttachmentUploadItem } from './types';
import { useAttachmentUploads, type AttachmentUploadController } from './useAttachmentUploads';

interface Request {
  file: File;
  bucket: string;
  signal: AbortSignal;
  progress: (value: number) => void;
  resolve: (meta: AttachmentMeta) => void;
  reject: (error: Error) => void;
}

function deferredTransport(requests: Request[]): AttachmentUploadTransport {
  return (file, bucket, progress, signal) => new Promise((resolve, reject) => {
    requests.push({ file, bucket, progress, signal, resolve, reject });
  });
}

function file(name: string, type = 'application/octet-stream'): File {
  return new File([name], name, { type });
}

function meta(name: string, type: AttachmentMeta['type'] = 'file'): AttachmentMeta {
  return { name, path: `attachments/s1/${name}`, size: 1, mimeType: type === 'image' ? 'image/png' : 'application/octet-stream', type };
}

let current: AttachmentUploadController;

function Probe(props: {
  scope: string;
  bucket: string;
  transport: AttachmentUploadTransport;
  fetchPreview?: (path: string) => Promise<string>;
}): null {
  current = useAttachmentUploads(props);
  return null;
}

function mount(transport: AttachmentUploadTransport, fetchPreview?: (path: string) => Promise<string>): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<Probe scope="scope-a" bucket="bucket-a" transport={transport} fetchPreview={fetchPreview} />); });
  return renderer;
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  vi.stubGlobal('File', globalThis.File);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAttachmentUploads FIFO queue', () => {
  it('runs three uploads and fills lanes in FIFO order', async () => {
    const requests: Request[] = [];
    const renderer = mount(deferredTransport(requests));
    act(() => current.addFiles(['1', '2', '3', '4', '5'].map((name) => file(name))));

    expect(requests.map((request) => request.file.name)).toEqual(['1', '2', '3']);
    await act(async () => { requests[1].resolve(meta('2')); await Promise.resolve(); });
    expect(requests.map((request) => request.file.name)).toEqual(['1', '2', '3', '4']);
    await act(async () => { requests[0].resolve(meta('1')); await Promise.resolve(); });
    expect(requests.map((request) => request.file.name)).toEqual(['1', '2', '3', '4', '5']);
    act(() => renderer.unmount());
  });

  it('aborts an active removal and fills its lane immediately', () => {
    const requests: Request[] = [];
    const renderer = mount(deferredTransport(requests));
    act(() => current.addFiles(['1', '2', '3', '4'].map((name) => file(name))));
    const firstId = current.items[0].id;

    act(() => current.remove(firstId));

    expect(requests[0].signal.aborted).toBe(true);
    expect(requests.map((request) => request.file.name)).toEqual(['1', '2', '3', '4']);
    act(() => renderer.unmount());
  });

  it('puts a retry at the FIFO tail', async () => {
    const requests: Request[] = [];
    const renderer = mount(deferredTransport(requests));
    act(() => current.addFiles(['1', '2', '3', '4'].map((name) => file(name))));
    const retryId = current.items[1].id;
    requests[1].reject(new Error('offline'));
    await flush();

    act(() => current.retry(retryId));
    expect(current.items.at(-1)?.file?.name).toBe('2');
    expect(current.items.at(-1)?.status).toBe('queued');
    await act(async () => { requests[0].resolve(meta('1')); await Promise.resolve(); });
    expect(requests.map((request) => request.file.name)).toEqual(['1', '2', '3', '4', '2']);
    act(() => renderer.unmount());
  });
});

describe('useAttachmentUploads lifecycle', () => {
  it('aborts and clears on a bucket-only change', () => {
    const requests: Request[] = [];
    const transport = deferredTransport(requests);
    const renderer = mount(transport);
    act(() => current.addFiles([file('old-bucket')]));

    act(() => renderer.update(<Probe scope="scope-a" bucket="bucket-b" transport={transport} />));
    expect(requests[0].signal.aborted).toBe(true);
    expect(current.items).toEqual([]);
    act(() => renderer.unmount());
  });

  it('aborts and clears on a scope change and ignores stale completion', async () => {
    const requests: Request[] = [];
    const transport = deferredTransport(requests);
    const renderer = mount(transport);
    act(() => current.addFiles([file('old')]));

    act(() => renderer.update(<Probe scope="scope-b" bucket="bucket-a" transport={transport} />));
    expect(requests[0].signal.aborted).toBe(true);
    expect(current.items).toEqual([]);
    requests[0].resolve(meta('stale'));
    await flush();
    expect(current.items).toEqual([]);
    act(() => renderer.unmount());
  });

  it('projects progress and restores metadata with a remote preview', async () => {
    const requests: Request[] = [];
    let resolvePreview!: (url: string) => void;
    const fetchPreview = vi.fn(() => new Promise<string>((resolve) => { resolvePreview = resolve; }));
    const renderer = mount(deferredTransport(requests), fetchPreview);
    act(() => current.addFiles([file('live')]));
    act(() => requests[0].progress(37));
    expect(current.items[0].progress).toBe(37);

    act(() => current.replaceRestored([meta('restored.png', 'image')]));
    expect(current.items[0]).toMatchObject({ status: 'done', progress: 100, meta: meta('restored.png', 'image') });
    await act(async () => { resolvePreview('blob:remote'); await Promise.resolve(); });
    expect(current.items[0].previewUrl).toBe('blob:remote');
    act(() => renderer.unmount());
  });

  it('revokes each owned object URL exactly once across remove/reset/unmount', async () => {
    const requests: Request[] = [];
    vi.mocked(URL.createObjectURL).mockReturnValue('blob:local');
    const renderer = mount(deferredTransport(requests));
    act(() => current.addFiles([file('image.png', 'image/png')]));
    const id = current.items[0].id;

    act(() => current.remove(id));
    act(() => current.reset());
    act(() => renderer.unmount());
    await flush();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local');
  });
});

describe('attachmentSendAllowed', () => {
  const item = (status: AttachmentUploadItem['status']): AttachmentUploadItem => ({
    id: status, status, progress: status === 'done' ? 100 : 0,
    ...(status === 'done' ? { meta: meta('done') } : { file: file(status) }),
  });

  it('requires text or done metadata and rejects every non-done state', () => {
    expect(attachmentSendAllowed('', [])).toBe(false);
    expect(attachmentSendAllowed('text', [])).toBe(true);
    expect(attachmentSendAllowed('', [item('done')])).toBe(true);
    expect(attachmentSendAllowed('text', [item('done'), item('error')])).toBe(false);
    expect(attachmentSendAllowed('text', [item('queued')])).toBe(false);
    expect(attachmentSendAllowed('text', [item('uploading')])).toBe(false);
  });
});
