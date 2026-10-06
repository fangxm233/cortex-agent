// Lazy pdf.js loader. Kept in its own module so DocViewer can `import()` it on demand — pdf.js + its
// worker (~1MB) stay OUT of the main bundle and load only when a PDF is actually opened. The worker is
// wired via Vite's `?worker` import (a real bundled asset served same-origin over cortexui:// in the
// native shell), avoiding `?url`/base64 inlining and CSP pitfalls. PDF bytes are handed to
// getDocument({ data }) as an ArrayBuffer — no blob: URL, correct in every WebView.
//
// Both halves come from pdf.js's legacy build: the modern one calls ES2026 built-ins such as
// `Map.prototype.getOrInsertComputed` (Chrome 145, WebKit 26.2), so a Linux webkit2gtk or any older
// engine failed every render. The legacy build carries those polyfills in the page AND the worker.

import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

let configured = false;

/** Return the pdf.js module with its worker configured exactly once. */
export function getPdfjs(): typeof pdfjsLib {
  if (!configured) {
    pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();
    configured = true;
  }
  return pdfjsLib;
}
