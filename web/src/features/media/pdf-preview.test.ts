import { describe, expect, it, vi } from 'vitest';
import type { CappedBytes } from './workspace-bytes';
import { PdfPreview, type PdfLoadingTaskLike, type PdfPageLike, type PdfRenderTaskLike } from './pdf-preview';

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const OK_BYTES: CappedBytes = { kind: 'ok', bytes: new Uint8Array([37, 80, 68, 70]) };

interface FakeRender extends PdfRenderTaskLike { pageNumber: number; done: Deferred<void>; cancelled: boolean }

/** A pdf.js stand-in: every page and render is a promise the test settles by hand. */
function fakePdf(numPages: number) {
  const pages = new Map<number, Deferred<PdfPageLike & { n: number }>>();
  const renders: FakeRender[] = [];
  const doc = deferred<{ numPages: number; getPage(n: number): Promise<PdfPageLike & { n: number }> }>();
  const task: PdfLoadingTaskLike<PdfPageLike & { n: number }> & { destroyed: boolean } = {
    promise: doc.promise,
    destroyed: false,
    destroy: vi.fn(async () => {
      task.destroyed = true;
      doc.reject(new Error('Loading aborted'));
    }),
  };
  const getDocument = vi.fn(() => task);
  const page = (n: number) => {
    if (!pages.has(n)) pages.set(n, deferred());
    return pages.get(n)!;
  };
  const document = { numPages, getPage: vi.fn((n: number) => page(n).promise) };
  const resolvePage = (n: number) => page(n).resolve({ n, getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }) });
  const canvas = {
    draw: vi.fn((pageNumber: number): PdfRenderTaskLike => {
      const done = deferred<void>();
      const render: FakeRender = {
        pageNumber,
        done,
        cancelled: false,
        promise: done.promise,
        cancel: () => { render.cancelled = true; done.reject(new Error('Rendering cancelled')); },
      };
      renders.push(render);
      return render;
    }),
    clear: vi.fn(),
  };
  return { task, getDocument, document, doc, resolvePage, renders, canvas };
}

async function openedPreview(numPages = 5) {
  const pdf = fakePdf(numPages);
  const preview = new PdfPreview(pdf.canvas);
  const opened = preview.open({ fetchBytes: async () => OK_BYTES, loadPdfjs: async () => ({ getDocument: pdf.getDocument }) });
  await flush();
  pdf.doc.resolve(pdf.document);
  pdf.resolvePage(1);
  expect(await opened).toEqual({ kind: 'ok', numPages, pageSize: { width: 918, height: 1188 } });
  return { pdf, preview };
}

describe('PdfPreview.open', () => {
  it('aborts the download and never opens a document when closed during the fetch', async () => {
    const pdf = fakePdf(3);
    const fetched = deferred<CappedBytes>();
    let signal: AbortSignal | undefined;
    const preview = new PdfPreview(pdf.canvas);
    const opened = preview.open({
      fetchBytes: (s) => { signal = s; return fetched.promise; },
      loadPdfjs: async () => ({ getDocument: pdf.getDocument }),
    });

    preview.close();
    expect(signal?.aborted).toBe(true);
    fetched.resolve(OK_BYTES);

    expect(await opened).toEqual({ kind: 'closed' });
    expect(pdf.getDocument).not.toHaveBeenCalled();
  });

  it('refuses an oversized file without opening it', async () => {
    const pdf = fakePdf(3);
    const preview = new PdfPreview(pdf.canvas);

    const opened = await preview.open({ fetchBytes: async () => ({ kind: 'toolarge' }), loadPdfjs: async () => ({ getDocument: pdf.getDocument }) });

    expect(opened).toEqual({ kind: 'toolarge' });
    expect(pdf.getDocument).not.toHaveBeenCalled();
  });

  it('destroys the loading task when closed while the document loads', async () => {
    const pdf = fakePdf(3);
    const preview = new PdfPreview(pdf.canvas);
    const opened = preview.open({ fetchBytes: async () => OK_BYTES, loadPdfjs: async () => ({ getDocument: pdf.getDocument }) });
    await flush();
    expect(pdf.getDocument).toHaveBeenCalledTimes(1);

    preview.close();

    expect(pdf.task.destroy).toHaveBeenCalledTimes(1);
    expect(await opened).toEqual({ kind: 'closed' });
  });

  it('reports closed when closed while the first page loads', async () => {
    const pdf = fakePdf(3);
    const preview = new PdfPreview(pdf.canvas);
    const opened = preview.open({ fetchBytes: async () => OK_BYTES, loadPdfjs: async () => ({ getDocument: pdf.getDocument }) });
    await flush();
    pdf.doc.resolve(pdf.document);
    await flush();

    preview.close();
    pdf.resolvePage(1);

    expect(await opened).toEqual({ kind: 'closed' });
    expect(pdf.task.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('PdfPreview pages', () => {
  it('draws only the pages asked for, one at a time', async () => {
    const { pdf, preview } = await openedPreview();
    pdf.resolvePage(2);
    pdf.resolvePage(3);

    preview.show(1);
    preview.show(2);
    await flush();
    expect(pdf.canvas.draw.mock.calls.map(([n]) => n)).toEqual([1]);

    pdf.renders[0].done.resolve();
    await flush();
    expect(pdf.canvas.draw.mock.calls.map(([n]) => n)).toEqual([1, 2]);
    expect(pdf.document.getPage).not.toHaveBeenCalledWith(3);
  });

  it('cancels and clears a page that scrolls away mid-render, and draws it again when it returns', async () => {
    const { pdf, preview } = await openedPreview();
    preview.show(1);
    await flush();

    preview.hide(1);
    expect(pdf.renders[0].cancelled).toBe(true);
    expect(pdf.canvas.clear).toHaveBeenCalledWith(1);

    preview.show(1);
    await flush();
    expect(pdf.canvas.draw).toHaveBeenCalledTimes(2);
  });

  it('skips a page that scrolls away before it loads', async () => {
    const { pdf, preview } = await openedPreview();
    preview.show(4);
    await flush();
    preview.hide(4);
    pdf.resolvePage(4);
    await flush();

    expect(pdf.canvas.draw).not.toHaveBeenCalled();
  });

  it('close() cancels the running render, clears every drawn page and destroys the document', async () => {
    const { pdf, preview } = await openedPreview();
    pdf.resolvePage(2);
    preview.show(1);
    await flush();
    pdf.renders[0].done.resolve();
    preview.show(2);
    await flush();
    expect(pdf.canvas.draw).toHaveBeenCalledTimes(2);

    preview.close();

    expect(pdf.renders[1].cancelled).toBe(true);
    expect(pdf.canvas.clear.mock.calls.map(([n]) => n).sort()).toEqual([1, 2]);
    expect(pdf.task.destroy).toHaveBeenCalledTimes(1);

    pdf.resolvePage(3);
    preview.show(3);
    await flush();
    expect(pdf.canvas.draw).toHaveBeenCalledTimes(2);
  });

  it('does not draw a page whose load resolves after close()', async () => {
    const { pdf, preview } = await openedPreview();
    preview.show(5);
    await flush();
    preview.close();
    pdf.resolvePage(5);
    await flush();

    expect(pdf.canvas.draw).not.toHaveBeenCalled();
  });
});
