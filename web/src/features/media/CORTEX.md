# features/media/ — shared in-app previewers (image/video lightbox + PDF/text DocViewer)

The in-app previewers for every attachment surface on **web AND mobile**. Opening a file NEVER opens a
new browser tab (a **no-op inside the Tauri WebView** — `window.open(blob)` / `<a download>` silently
do nothing; that was the "点了没反应" bug). Instead:

- **image / video** → the `MediaViewer` full-screen lightbox (`useMediaViewer().openMedia`).
- **PDF / text** → the `DocViewer` document modal (`useDocViewer().openDoc`).
- **everything else** (zip/xlsx/binaries) → download to disk (`lib/files.downloadFile`, which routes
  through the native `save_download` command in the Tauri shell — see `desktop/CORTEX.md`). On the
  desktop shell `useDownloadFile` then raises a "下载完成" toast whose **Open file / Open folder**
  buttons invoke `lib/files.openPath` / `revealPath` (→ the `open_path` / `reveal_path` Tauri commands);
  the browser has no observable save location so it shows the file name with no buttons.

Both providers are mounted once per shell (`shell/AppShell` desktop · `mobile/MobileShell` mobile).

**Two preview modes (desktop).** The modal above is the default. On the workbench a preview can also
be **pinned**: the modal's ◧ button docks it as a pane to the RIGHT of the chat, splitting the center
region into `chat | preview`, and from then on every preview click swaps the docked pane's content
instead of raising a modal. The pane's × unpins and restores modal mode. Mobile has no dock host, so
it keeps the modal only.

| path | role |
|---|---|
| `media-kind.ts` / `media-kind.test.ts` | Pure `mediaKindOf(type)` classifier mapping an attachment type to image/video or `null`, with two direct behavior tests. Shared by both `AttachmentMeta` and `Attachment`. |
| `doc-kind.ts` / `doc-kind.test.ts` | Pure `docKindOf(name, mimeType)` classifier for `'pdf' \| 'text' \| null` plus `isMarkdownName`; tests cover extensions, MIME fallbacks, paths/dotfiles, casing, and binary rejection. |
| `useWorkspaceObjectUrl.ts` | Hook: fetches a workspace `path` (image/video) into an authenticated object URL for inline preview (a plain `<img>`/`<video src>` can't send the `x-cortex-token` header — routes through `lib/files.fetchFileObjectUrl`, correct in browser/ui-http proxy/Access and desktop/remote token modes). Revoked on unmount / path change; `enabled=false` skips the fetch. Used for sent-message + agent-file thumbnails. |
| `video-poster.ts` / `video-poster.test.ts` + `VideoThumb.tsx` | **First-frame video poster** (shared, web AND mobile). Every video **thumbnail** used to be a live `<video preload="metadata">` relying on the WebView to paint the first frame as a still — desktop WebKitGTK does, but the **Android System WebView (Tauri app) does NOT** (it shows a generic built-in video placeholder — the "模板的视频图片" bug). `useVideoPoster(src)` decodes one frame off-screen (seek a small offset via pure `posterSeekTime` → draw to a downscaled canvas sized by pure `posterCanvasSize`, cap 360px) into a JPEG data URL; `<VideoThumb src style>` shows it as an `<img>`, falling back to the raw `<video>` until the poster is ready / if capture fails (so desktop is never worse and odd codecs still render). Wired into **all five** thumbnail sites (mobile `ComposerChip`/`AttachmentTile`, desktop `Composer` chip, `MessageStream` `MediaThumb` + `AgentMediaPreview`). The **lightbox** keeps its own `<video controls autoPlay>` (playback, not a still). |
| `MediaViewer.tsx` | `MediaViewerProvider` + `useMediaViewer()` (`openMedia(item)` / `close()`) + an internal `Lightbox`. `openMedia` routes to the docked pane while a pinned preview is active; otherwise the action bar offers pin/download/close. Workspace paths are auth-fetched and local object URLs are used directly. Images use `object-fit:contain` with no synthetic corner radius, preserving the source boundary; videos use controlled playback. The context defaults to a no-op outside a mounted provider, and lightbox chrome is not maintained as a static-render contract. |
| `DocViewer.tsx` | `DocViewerProvider` + `useDocViewer()` (`openDoc(item)` / `close()`) + the `DocModal`. Same pinned-preview wiring as MediaViewer (◧ in the modal header, `openDoc` routes to the pane while pinned); `PdfBody`/`TextBody` are exported so the docked pane renders the identical document body. `DocItem = { kind:'pdf'\|'text', name, path, mimeType? }` — bytes auth-fetched from `/api/files/download`. **text**: `.md` → `ChatMarkdown`, else monospace `<pre>` (2 MB preview cap → "download to view"). **pdf**: pdf.js renders each page (wrapped in a per-page `<div>`) to a `<canvas>` — reliable in webkit2gtk / Android System WebView, which have **NO built-in PDF viewer** (an `<iframe src=blob:pdf>` would silently blank there). A `PdfPager` toolbar (shown once `numPages` is known) displays **current / total** pages, prev/next (↑/↓), and an editable jump-to-page field; the current page is derived from the scroll position (viewport-center page via `pdf-pager.pageAtScroll`), and jump smooth-scrolls the tracked page wrapper into view. Header ↓ download / × close, Esc / scrim close / **Android hardware back** (via `mobile/use-back-dismiss`), body-scroll lock. No-op default context like MediaViewer. |
| `pdf-pager.ts` / `pdf-pager.test.ts` | **Pure** (TDD): page math for the `PdfPager` — `clampPage(n,total)` (→ `[1,total]`, floors/NaN-guards), `pageAtScroll(pages,scrollTop,viewportH)` (1-based page occupying the viewport center, given each page's `{top,height}` box), `parseJump(raw,total)` (user-typed jump → clamped page or `null`). No DOM; the scroll/canvas wiring stays in `DocViewer.PdfBody`. |
| `pinned-preview.ts` / `pinned-preview.test.ts` | Pure docked-preview model: stored pin/split parsing, bounded divider-drag behavior, document/media routing, and workspace download-path availability. Pane-size floors remain internal presentation details and are not exported or asserted by value. Type-only viewer imports avoid a runtime cycle. |
| `PinnedPreviewProvider.tsx` | Pinned-preview state + `usePinnedPreview()`: `{canPin, active, pinned, item, split, pin, show, unpin, setSplit, registerHost}`. `pinned` + `split` persist (`cortex.previewPinned` / `cortex.previewSplit`, guarded like `i18n/lang.ts`); the docked item does not. `canPin`/`active` are gated on a **registered dock host** — so the ◧ button only appears where a pane can actually render (the desktop workbench), and pinned mode never swallows a preview on a surface with nowhere to dock it (mobile shell, thread detail). Mounted in `AppShell` ABOVE `MediaViewerProvider`/`DocViewerProvider`, which consult it in `openMedia`/`openDoc`; the context defaults to inert, so with no provider both viewers behave exactly as before. |
| `PinnedPreviewPane.tsx` | The dock host and docked pane, owning registration, divider drag, persisted split, download/unpin wiring, and shared document/media rendering. Image boundaries retain no synthetic radius. Panel chrome/copy stay internal; classification, persisted state, split behavior, and download-path availability are covered through `pinned-preview.test.ts`. |
| `useMediaSrc.ts` | Hook: a media item's displayable source — a local composer `url` used directly, a workspace `path` auth-fetched into an object URL (revoked on change/unmount) — plus a `failed` flag so a full-size viewer says "Failed to load" instead of an endless "Loading…". Shared by the `Lightbox` and the docked `PinnedMediaBody` (thumbnails keep the lighter `useWorkspaceObjectUrl`). |
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
