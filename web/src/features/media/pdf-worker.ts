// Lazy pdf.js loader. Kept in its own module so DocViewer can `import()` it on demand — pdf.js + its
// worker (~1MB) stay OUT of the main bundle and load only when a PDF is actually opened. The worker is
// wired via Vite's `?worker` import (a real bundled asset served same-origin over cortexui:// in the
// native shell), avoiding `?url`/base64 inlining and CSP pitfalls. PDF bytes are handed to
// getDocument({ data }) as an ArrayBuffer — no blob: URL, correct in every WebView.

import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import * as pdfjsLib from 'pdfjs-dist';

let configured = false;

/** Return the pdf.js module with its worker configured exactly once. */
export function getPdfjs(): typeof pdfjsLib {
  if (!configured) {
    pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();
    configured = true;
  }
  return pdfjsLib;
}
