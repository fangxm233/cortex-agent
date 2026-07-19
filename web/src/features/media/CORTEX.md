# features/media/ — shared in-app previewers (image/video lightbox + PDF/text DocViewer)

The in-app previewers for every attachment surface on **web AND mobile**. Opening a file NEVER opens a
new browser tab (a **no-op inside the Tauri WebView** — `window.open(blob)` / `<a download>` silently
do nothing; that was the "点了没反应" bug). Instead:

- **image / video** → the `MediaViewer` full-screen lightbox (`useMediaViewer().openMedia`).
- **PDF / text** → the `DocViewer` document modal (`useDocViewer().openDoc`).
- **everything else** (zip/xlsx/binaries) → download to disk (`lib/files.downloadFile`, which routes
  through the native `save_download` command in the Tauri shell — see `desktop/CORTEX.md`).

Both providers are mounted once per shell (`shell/AppShell` desktop · `mobile/MobileShell` mobile).

| path | role |
|---|---|
| `media-kind.ts` / `media-kind.test.ts` | **Pure** (TDD): `mediaKindOf(type)` maps an attachment `type` (`'image'\|'video'\|'file'`) to the previewable kind or `null`; `isPreviewable(type)`. Shared by both `AttachmentMeta` (chat-content) and `Attachment` (transcript-vm). |
| `doc-kind.ts` / `doc-kind.test.ts` | **Pure** (TDD): `docKindOf(name, mimeType)` classifies a plain `file` attachment into `'pdf' \| 'text' \| null` — PDF on `.pdf`/`application/pdf`, text on an extension allow-list (md/txt/log/json/csv/yaml/code/…) or a `text/*` / `application/json` mimeType, else null (→ download). `isDocPreviewable`, `isMarkdownName` (md → rich Markdown render, else `<pre>`). Consulted only for the `file` type (image/video go through `media-kind`). |
| `useWorkspaceObjectUrl.ts` | Hook: fetches a workspace `path` (image/video) into an authenticated object URL for inline preview (a plain `<img>`/`<video src>` can't send the `x-cortex-token` header — routes through `lib/files.fetchFileObjectUrl`, correct in browser/ui-http proxy/Access and desktop/remote token modes). Revoked on unmount / path change; `enabled=false` skips the fetch. Used for sent-message + agent-file thumbnails. |
| `video-poster.ts` / `video-poster.test.ts` + `VideoThumb.tsx` | **First-frame video poster** (shared, web AND mobile). Every video **thumbnail** used to be a live `<video preload="metadata">` relying on the WebView to paint the first frame as a still — desktop WebKitGTK does, but the **Android System WebView (Tauri app) does NOT** (it shows a generic built-in video placeholder — the "模板的视频图片" bug). `useVideoPoster(src)` decodes one frame off-screen (seek a small offset via pure `posterSeekTime` → draw to a downscaled canvas sized by pure `posterCanvasSize`, cap 360px) into a JPEG data URL; `<VideoThumb src style>` shows it as an `<img>`, falling back to the raw `<video>` until the poster is ready / if capture fails (so desktop is never worse and odd codecs still render). Wired into **all five** thumbnail sites (mobile `ComposerChip`/`AttachmentTile`, desktop `Composer` chip, `MessageStream` `MediaThumb` + `AgentMediaPreview`). The **lightbox** keeps its own `<video controls autoPlay>` (playback, not a still). |
| `MediaViewer.tsx` | `MediaViewerProvider` + `useMediaViewer()` (`openMedia(item)` / `close()`) + the `Lightbox`. `MediaItem = { kind, name, path?, url? }` — a `path` is auth-fetched into an object URL (sent messages / agent files), a `url` is used directly (a local composer `File` preview). The lightbox is a `position:fixed` scrim modal (Esc / scrim-click / × / **Android hardware back** to close — the back key is wired via `mobile/use-back-dismiss` so it dismisses the modal instead of navigating a route, body-scroll lock, ↓ download, filename caption); image = `object-fit:contain`, video = `<video controls autoPlay>`. The context defaults to a **no-op** so presentational components (rebuilt 1:1, unit-tested in isolation) render without a provider in scope. |
| `DocViewer.tsx` | `DocViewerProvider` + `useDocViewer()` (`openDoc(item)` / `close()`) + the `DocModal`. `DocItem = { kind:'pdf'\|'text', name, path, mimeType? }` — bytes auth-fetched from `/api/files/download`. **text**: `.md` → `ChatMarkdown`, else monospace `<pre>` (2 MB preview cap → "download to view"). **pdf**: pdf.js renders each page (wrapped in a per-page `<div>`) to a `<canvas>` — reliable in webkit2gtk / Android System WebView, which have **NO built-in PDF viewer** (an `<iframe src=blob:pdf>` would silently blank there). A `PdfPager` toolbar (shown once `numPages` is known) displays **current / total** pages, prev/next (↑/↓), and an editable jump-to-page field; the current page is derived from the scroll position (viewport-center page via `pdf-pager.pageAtScroll`), and jump smooth-scrolls the tracked page wrapper into view. Header ↓ download / × close, Esc / scrim close / **Android hardware back** (via `mobile/use-back-dismiss`), body-scroll lock. No-op default context like MediaViewer. |
| `pdf-pager.ts` / `pdf-pager.test.ts` | **Pure** (TDD): page math for the `PdfPager` — `clampPage(n,total)` (→ `[1,total]`, floors/NaN-guards), `pageAtScroll(pages,scrollTop,viewportH)` (1-based page occupying the viewport center, given each page's `{top,height}` box), `parseJump(raw,total)` (user-typed jump → clamped page or `null`). No DOM; the scroll/canvas wiring stays in `DocViewer.PdfBody`. |
| `pdf-worker.ts` | Lazy pdf.js loader (`getPdfjs()`), kept separate so `DocViewer` can `import()` it on demand — pdf.js + its worker (~1.2 MB) stay **out of the main bundle**, loading only when a PDF is opened. Worker wired via Vite's `?worker` import (bundled asset, same-origin over `cortexui://`); PDF bytes go to `getDocument({ data })` as an `ArrayBuffer` (no blob URL). |

## Wired surfaces

- **Composer preview** (desktop `features/workbench/Composer` · mobile `mobile/v3/MChatView` `ComposerChip`):
  the attachment chip renders a real thumbnail from a local `URL.createObjectURL(file)` (revoked on
  remove / send; video via `VideoThumb`) and opens the lightbox on click (`openMedia({url})`).
- **Sent user message** (desktop `MessageStream` `AttachmentCard`→`MediaThumb` · mobile `MChatView`
  `AttachmentTile`): image/video render an auth-fetched thumbnail, click opens the lightbox
  (`openMedia({path})`); plain files keep the download action.
- **Agent-sent files** (desktop `MessageStream` `AgentMediaPreview` + `AgentFileGroup` inlining
  video · mobile `AttachmentTile`): image/video inline previews open the lightbox; **PDF/text file
  cards open the DocViewer** (`openDoc`) — desktop cards are clickable + carry a "打开" pill, mobile
  tiles open on tap; **other files download** (native `save_download`). The old "open in new tab"
  affordance (`openFile` → `window.open`) was **removed** — it was a no-op in the native shell.
