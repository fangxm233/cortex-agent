# features/media/ — shared image/video lightbox (modal previewer)

The single in-app previewer for every image/video surface on **web AND mobile**. Opening a photo or
video anywhere — the composer's attachment preview, a sent user message's media, or an agent-sent
image/video — raises a full-screen **modal** (scrim + centered media + download/close), **never a new
browser tab**. One instance is mounted per shell (`shell/AppShell` desktop · `mobile/MobileShell`
mobile) and opened from anywhere via `useMediaViewer().openMedia(item)`.

| path | role |
|---|---|
| `media-kind.ts` / `media-kind.test.ts` | **Pure** (TDD): `mediaKindOf(type)` maps an attachment `type` (`'image'\|'video'\|'file'`) to the previewable kind or `null`; `isPreviewable(type)`. Shared by both `AttachmentMeta` (chat-content) and `Attachment` (transcript-vm). |
| `useWorkspaceObjectUrl.ts` | Hook: fetches a workspace `path` (image/video) into an authenticated object URL for inline preview (a plain `<img>`/`<video src>` can't send the `x-cortex-token` header — routes through `lib/files.fetchFileObjectUrl`, correct in browser/ui-http proxy/Access and desktop/remote token modes). Revoked on unmount / path change; `enabled=false` skips the fetch. Used for sent-message + agent-file thumbnails. |
| `MediaViewer.tsx` | `MediaViewerProvider` + `useMediaViewer()` (`openMedia(item)` / `close()`) + the `Lightbox`. `MediaItem = { kind, name, path?, url? }` — a `path` is auth-fetched into an object URL (sent messages / agent files), a `url` is used directly (a local composer `File` preview). The lightbox is a `position:fixed` scrim modal (Esc / scrim-click / × to close, body-scroll lock, ↓ download, filename caption); image = `object-fit:contain`, video = `<video controls autoPlay>`. The context defaults to a **no-op** so presentational components (rebuilt 1:1, unit-tested in isolation) render without a provider in scope. |

## Wired surfaces

- **Composer preview** (desktop `features/workbench/Composer` · mobile `mobile/v3/MChatView` `ComposerChip`):
  the attachment chip renders a real thumbnail from a local `URL.createObjectURL(file)` (revoked on
  remove / send) and opens the lightbox on click (`openMedia({url})`).
- **Sent user message** (desktop `MessageStream` `AttachmentCard`→`MediaThumb` · mobile `MChatView`
  `AttachmentTile`): image/video render an auth-fetched thumbnail, click opens the lightbox
  (`openMedia({path})`); plain files keep the download action.
- **Agent-sent files** (desktop `MessageStream` `AgentMediaPreview` + `AgentFileGroup` inlining
  video · mobile `AttachmentTile`): inline image/video previews open the lightbox on click instead of
  a new tab; plain files keep their download / copy-path / open-in-new-tab card actions.
