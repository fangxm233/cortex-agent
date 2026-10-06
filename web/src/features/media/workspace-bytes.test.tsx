import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceText } from './useWorkspaceText';
import { fetchWorkspaceBytes, readCappedBody } from './workspace-bytes';

/** A body of `chunks` chunks of `size` bytes each, produced on demand so the test can see how far it was read. */
function lazyBody(chunks: number, size: number): { stream: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks) {
        controller.close();
        return;
      }
      pulled++;
      controller.enqueue(new Uint8Array(size).fill(97));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

describe('readCappedBody', () => {
  it('refuses a declared Content-Length over the limit without reading the body', async () => {
    const body = lazyBody(1000, 1024);
    const res = new Response(body.stream, { headers: { 'content-length': String(1000 * 1024) } });

    expect(await readCappedBody(res, 10 * 1024)).toEqual({ kind: 'toolarge' });
    expect(body.pulled()).toBe(0);
    expect(body.cancelled()).toBe(true);
  });

  it('stops reading an undeclared body as soon as it passes the limit', async () => {
    const body = lazyBody(1000, 1024);
    const res = new Response(body.stream);

    expect(await readCappedBody(res, 10 * 1024)).toEqual({ kind: 'toolarge' });
    expect(body.pulled()).toBeLessThanOrEqual(12);
    expect(body.cancelled()).toBe(true);
  });

  it('returns the whole body when it fits, including exactly at the limit', async () => {
    const body = lazyBody(4, 256);
    const result = await readCappedBody(new Response(body.stream), 1024);

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.bytes.byteLength).toBe(1024);
    expect(body.cancelled()).toBe(false);
  });

  it('does not trust an understated Content-Length', async () => {
    const body = lazyBody(100, 1024);
    const res = new Response(body.stream, { headers: { 'content-length': '10' } });

    expect(await readCappedBody(res, 4096)).toEqual({ kind: 'toolarge' });
    expect(body.pulled()).toBeLessThanOrEqual(6);
  });
});

describe('fetchWorkspaceBytes', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('passes the caller signal to fetch and decodes the capped body', async () => {
    const fetchMock = vi.fn(async () => new Response('hello'));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const result = await fetchWorkspaceBytes('workspace/a.txt', 1024, controller.signal);

    expect(result.kind === 'ok' && new TextDecoder().decode(result.bytes)).toBe('hello');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('path=workspace%2Fa.txt'), expect.objectContaining({ signal: controller.signal }));
  });

  it('throws on an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));

    await expect(fetchWorkspaceBytes('workspace/missing.txt', 1024)).rejects.toThrow('404');
  });
});

describe('useWorkspaceText', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reports an oversized file without downloading all of it', async () => {
    const body = lazyBody(1000, 1024);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body.stream)));
    const seen: string[] = [];
    function Probe(): null {
      seen.push(useWorkspaceText('workspace/huge.log', 10 * 1024).state);
      return null;
    }

    await act(async () => { create(<Probe />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(seen.at(-1)).toBe('toolarge');
    expect(body.pulled()).toBeLessThanOrEqual(12);
  });

  it('aborts the request when the viewer closes', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    }));
    function Probe(): null {
      useWorkspaceText('workspace/slow.log', 1024);
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Probe />); });
    expect(signal?.aborted).toBe(false);
    await act(async () => { renderer.unmount(); });
    expect(signal?.aborted).toBe(true);
  });
});
