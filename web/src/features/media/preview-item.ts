import type { MediaKind } from './media-kind';
import type { DocKind } from './doc-kind';

// What a previewable file looks like to everything that opens one: the lightbox, the document
// modal, the dock's tabs and the seam between them (`design/dock-intake`). These shapes used to sit
// in MediaViewer.tsx / DocViewer.tsx beside the components that render them, which made the type
// unreachable from anything those components import — the seam included.

export interface MediaItem {
  kind: MediaKind;
  name: string;
  /** Workspace-relative `workspace/…` path → authenticated blob fetch (sent messages / agent files). */
  path?: string;
  /** A ready object URL (a local composer File preview) — used directly, not fetched. */
  url?: string;
}

export interface DocItem {
  kind: DocKind;
  name: string;
  /** Workspace-relative `workspace/…` path → authenticated fetch. */
  path: string;
  mimeType?: string;
}

/** Anything the file previewers can render: image/video (MediaItem) or pdf/text/html (DocItem). */
export type PreviewItem = MediaItem | DocItem;
