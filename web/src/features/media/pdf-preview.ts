import type { CappedBytes } from './workspace-bytes';

// The lifecycle of one PDF preview, kept free of React and the DOM so it is unit-tested directly.
// It fetches the bytes (capped), opens the document, and then draws only the pages the viewer asks
// for — the ones near the viewport — one at a time, clearing a page again once it scrolls away. A
// rendered page is a canvas of up to (1.5 × 2)² × its area in pixels, so drawing every page of a long
// PDF up front is what ran mobile WebViews out of memory. `close()` tears everything down: the fetch,
// the running render, every canvas and the pdf.js document with its worker transport.

/** pdf.js viewport scale for a drawn page; the device pixel ratio (capped at 2) multiplies it. */
export const PDF_RENDER_SCALE = 1.5;

export interface PdfPageSize {
  width: number;
  height: number;
}

export interface PdfRenderTaskLike {
  promise: Promise<unknown>;
  cancel(): void;
}

export interface PdfPageLike {
  getViewport(params: { scale: number }): PdfPageSize;
}

export interface PdfDocumentLike<P extends PdfPageLike> {
  numPages: number;
  getPage(pageNumber: number): Promise<P>;
}

export interface PdfLoadingTaskLike<P extends PdfPageLike> {
  promise: Promise<PdfDocumentLike<P>>;
  destroy(): Promise<void>;
}

export interface PdfjsLike<P extends PdfPageLike> {
  getDocument(src: { data: Uint8Array }): PdfLoadingTaskLike<P>;
}

/** The DOM side: draw a page into its slot, or clear the slot again. */
export interface PdfPageCanvas<P extends PdfPageLike> {
  draw(pageNumber: number, page: P): PdfRenderTaskLike;
  clear(pageNumber: number): void;
}

export interface PdfOpenDeps<P extends PdfPageLike> {
  fetchBytes(signal: AbortSignal): Promise<CappedBytes>;
  loadPdfjs(): Promise<PdfjsLike<P>>;
}

export type PdfOpenResult =
  | { kind: 'ok'; numPages: number; pageSize: PdfPageSize }
  | { kind: 'toolarge' }
  | { kind: 'closed' };

const CLOSED: PdfOpenResult = { kind: 'closed' };

export class PdfPreview<P extends PdfPageLike> {
  private readonly abort = new AbortController();
  private task: PdfLoadingTaskLike<P> | null = null;
  private doc: PdfDocumentLike<P> | null = null;
  /** Pages the viewer wants drawn, in the order it asked. */
  private readonly wanted = new Set<number>();
  /** Pages drawn or being drawn. */
  private readonly drawn = new Set<number>();
  private running: { pageNumber: number; task: PdfRenderTaskLike } | null = null;
  private pumping = false;
  private closed = false;

  constructor(private readonly canvas: PdfPageCanvas<P>) {}

  async open(deps: PdfOpenDeps<P>): Promise<PdfOpenResult> {
    try {
      const [bytes, pdfjs] = await Promise.all([deps.fetchBytes(this.abort.signal), deps.loadPdfjs()]);
      if (this.closed) return CLOSED;
      if (bytes.kind === 'toolarge') return { kind: 'toolarge' };
      this.task = pdfjs.getDocument({ data: bytes.bytes });
      const doc = await this.task.promise;
      if (this.closed) return CLOSED;
      const first = await doc.getPage(1);
      if (this.closed) return CLOSED;
      this.doc = doc;
      const { width, height } = first.getViewport({ scale: PDF_RENDER_SCALE });
      return { kind: 'ok', numPages: doc.numPages, pageSize: { width, height } };
    } catch (error) {
      if (this.closed) return CLOSED;
      throw error;
    }
  }

  show(pageNumber: number): void {
    if (this.closed || !this.doc) return;
    this.wanted.add(pageNumber);
    void this.pump();
  }

  hide(pageNumber: number): void {
    this.wanted.delete(pageNumber);
    if (this.running?.pageNumber === pageNumber) this.running.task.cancel();
    if (this.drawn.delete(pageNumber)) this.canvas.clear(pageNumber);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.wanted.clear();
    this.running?.task.cancel();
    for (const pageNumber of this.drawn) this.canvas.clear(pageNumber);
    this.drawn.clear();
    void this.task?.destroy().catch(() => {});
    this.task = null;
    this.doc = null;
  }

  private nextPage(): number | undefined {
    for (const pageNumber of this.wanted) {
      if (!this.drawn.has(pageNumber)) return pageNumber;
    }
    return undefined;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let next = this.nextPage(); next !== undefined && !this.closed; next = this.nextPage()) {
        await this.draw(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async draw(pageNumber: number): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    this.drawn.add(pageNumber);
    try {
      const page = await doc.getPage(pageNumber);
      // Hidden (or the preview closed) while the page loaded.
      if (this.closed || !this.drawn.has(pageNumber)) return;
      const task = this.canvas.draw(pageNumber, page);
      this.running = { pageNumber, task };
      await task.promise;
    } catch {
      // Cancelled, or a page pdf.js cannot draw: it stays a blank sheet.
    } finally {
      this.running = null;
    }
  }
}
